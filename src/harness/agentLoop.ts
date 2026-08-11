/**
 * Agent loop controller — orchestrates a task through DeepSeek.
 *
 * This is the "harness that writes code": it runs the loop
 *   model-decides-tool-call → harness-executes → model-sees-result → repeat
 * using our DeepSeek transport (`streamDeepSeekChat`), the virtual-tool
 * expansion, the category summarizer, and the minimal toolset.
 *
 * Design notes:
 * - Stateless per invocation: it builds the message history itself from the
 *   task + tool results, so it is safe to run concurrently and never bleeds
 *   state across calls (consistent with the session-scoping work).
 * - Thinking is DISABLED for the loop executor by default (matches the "off"
 *   default) so we don't need reasoning_text round-tripping; enable it via
 *   `thinkingEffort` if desired.
 * - Tool execution is the caller's responsibility via `executor` (injectable
 *   for tests). Results are appended as `role: 'tool'` messages with the
 *   matching `tool_call_id`.
 */
import type { StreamResult } from '../api/deepseek.js';
import type { DeepSeekMessage, DeepSeekTool, DeepSeekToolCall } from '../api/types.js';
import type { AgentTool } from './tools/index.js';
import { guardToolHistory } from './estimate.js';

/** Lazy transport import — avoids loading the vscode-dependent api client at module load (keeps this testable in plain Node). */
async function loadTransport() {
    return (await import('../api/deepseek.js')).streamDeepSeekChat;
}

/**
 * The transport the loop uses to talk to DeepSeek. Injectable for tests;
 * defaults to the real `streamDeepSeekChat`.
 */
export type ChatTransport = (
    request: {
        model: string;
        messages: DeepSeekMessage[];
        temperature: number;
        max_tokens: number;
        stream: boolean;
        tools: DeepSeekTool[];
        tool_choice: 'auto';
        thinking: { type: 'enabled' | 'disabled' };
        reasoning_effort?: 'low' | 'high' | 'max';
    },
    apiKey: string,
    signal: AbortSignal,
    onText: (text: string) => void,
    onToolCalls: (calls: { id: string; name: string; arguments: Record<string, unknown> }[]) => void,
    onComplete: (usage?: { promptTokens: number; completionTokens: number }) => void,
) => Promise<StreamResult>;

/** How a tool call is executed (injectable; default uses the AgentTool executors). */
export type ToolExecutor = (tool: AgentTool, args: Record<string, unknown>, cwd: string) => Promise<string>;

/** A structured tool result fed back to the model. */
export interface ToolResult {
    /** Raw output (capped). */
    output: string;
    /** True when the tool reported a failure. */
    ok: boolean;
    /** Exit code when known (terminal), else undefined. */
    exitCode?: number;
    /** True when the output was truncated for context. */
    truncated?: boolean;
    /** Optional short machine-readable tag (e.g. 'timeout', 'network'). */
    tag?: string;
}

export interface AgentLoopOptions {
    /** DeepSeek API key. */
    apiKey: string;
    /** Working directory for tools. */
    cwd: string;
    /** The toolset the model may call. */
    tools: AgentTool[];
    /** Thinking effort: 'off' | 'low' | 'high' | 'max'. Default 'off'. */
    thinkingEffort?: 'off' | 'low' | 'high' | 'max';
    /** Max loop iterations (safety). Default 10. */
    maxIterations?: number;
    /** Max output tokens per model call. Default 4096. */
    maxTokens?: number;
    /** Abort signal for cancellation. */
    signal?: AbortSignal;
    /** Custom executor (for tests / sandboxing). */
    executor?: ToolExecutor;
    /** Called with each model text chunk (streaming out). */
    onText?: (text: string) => void;
    /** Transport override (for tests). Defaults to the real DeepSeek client. */
    transport?: ChatTransport;
    /** Max parallel tool calls per turn. Default 4. */
    maxParallel?: number;
    /** Retry count for transient tool errors. Default 2. */
    toolRetries?: number;
    /** Retry count for transient API failures. Default 2. */
    apiRetries?: number;
    /** Soft token budget for accumulated tool-result history. Default 120_000. */
    maxHistoryTokens?: number;
    /** Command to run for the optional verify pass (e.g. `npm test`). */
    verifyCommand?: string;
    /** Max tool output chars before truncation. Default 8_000. */
    maxOutputChars?: number;
    /** Optional logger for the tool-call sequence (for observability). */
    onLog?: (msg: string) => void;
}

export interface AgentLoopResult {
    /** Final text output from the model. */
    text: string;
    /** Number of loop iterations performed. */
    iterations: number;
    /** Number of tool calls executed. */
    toolCalls: number;
    /** Ordered names of every tool executed, in the order they ran. */
    sequence: string[];
    /** True if stopped because the model said it was done. */
    completed: boolean;
    /** True if stopped by maxIterations. */
    truncated: boolean;
    /** Verify-pass result, when a verify command was provided and run. */
    verify?: ToolResult;
}

function toDeepSeekTool(tool: AgentTool): DeepSeekTool {
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

const defaultExecutor: ToolExecutor = async (tool, args, cwd) => tool.execute(args, cwd);

/** Sleep helper for backoff. */
function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** Parse a ToolResult from raw executor output using our framing conventions. */
function parseToolResult(raw: string, maxOutputChars: number): ToolResult {
    let output = raw;
    let ok = true;
    let tag: string | undefined;

    if (output.startsWith('[command failed]')) {
        ok = false;
        tag = 'command-failed';
    } else if (output.startsWith('[error')) {
        ok = false;
        tag = 'tool-error';
    }

    // Detect transient signals for retry classification.
    if (/timeout|timed out|ECONNRESET|network|ETIMEDOUT/i.test(output)) {
        tag = 'transient';
    }

    if (output.length > maxOutputChars) {
        output = output.slice(0, maxOutputChars) + `\n...[truncated ${raw.length - maxOutputChars} chars]`;
    }
    return { output, ok, truncated: raw.length > maxOutputChars, tag };
}

/** Format a structured tool result for the model. */
function formatToolResult(name: string, r: ToolResult): string {
    const status = r.ok ? 'OK' : 'ERROR';
    const meta = [status, r.exitCode !== undefined ? `exit=${r.exitCode}` : '', r.truncated ? 'TRUNCATED' : '', r.tag ? `tag=${r.tag}` : ''].filter(Boolean).join(' ');
    return `[tool ${name}: ${meta}]\n${r.output}`;
}

/** Retry a transient tool call with exponential backoff. */
async function executeWithRetry(
    tool: AgentTool,
    args: Record<string, unknown>,
    cwd: string,
    executor: ToolExecutor,
    retries: number,
    maxOutputChars: number,
): Promise<ToolResult> {
    let attempt = 0;
    for (;;) {
        const raw = await executor(tool, args, cwd);
        const result = parseToolResult(raw, maxOutputChars);
        const isTransient = result.tag === 'transient';
        if (!isTransient || attempt >= retries) return result;
        attempt++;
        await sleep(10 * Math.pow(2, attempt - 1)); // short backoff (tests)
        result.output += `\n[retry ${attempt}/${retries} after transient failure]`;
    }
}

/** Wrap a transport call with retry on transient API failures. */
async function transportWithRetry(
    transport: ChatTransport,
    request: Parameters<ChatTransport>[0],
    apiKey: string,
    signal: AbortSignal,
    onText: (t: string) => void,
    onToolCalls: (c: { id: string; name: string; arguments: Record<string, unknown> }[]) => void,
    onComplete: () => void,
    retries: number,
): Promise<StreamResult> {
    let attempt = 0;
    for (;;) {
        try {
            return await transport(request, apiKey, signal, onText, onToolCalls, onComplete);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt >= retries || /abort/i.test(msg)) throw err;
            attempt++;
            await sleep(10 * Math.pow(2, attempt - 1));
        }
    }
}

/**
 * Run one agent turn: send the current messages + toolset, collect text and
 * any tool calls, return them.
 */
async function runTurn(
    options: AgentLoopOptions,
    messages: DeepSeekMessage[],
    toolSet: DeepSeekTool[],
): Promise<{ text: string; toolCalls: CompletedLoopCall[] }> {
    const thinking = options.thinkingEffort ?? 'off';
    const transport = options.transport ?? (async (...a: Parameters<ChatTransport>) => {
        const fn = await loadTransport();
        return fn(a[0] as never, a[1], a[2], a[3], a[4], a[5]) as Promise<StreamResult>;
    });
    const request = {
        model: 'deepseek-v4-flash',
        messages,
        temperature: 0.2,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
        tools: toolSet,
        tool_choice: 'auto' as const,
        thinking: thinking === 'off' ? { type: 'disabled' as const } : { type: 'enabled' as const },
        ...(thinking !== 'off' ? { reasoning_effort: thinking } : {}),
    };

    let text = '';
    let toolCalls: CompletedLoopCall[] = [];

    const result = await transportWithRetry(
        transport,
        request,
        options.apiKey,
        options.signal ?? new AbortController().signal,
        (t: string) => {
            text += t;
            options.onText?.(t);
        },
        (calls) => {
            toolCalls = calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }));
        },
        () => { /* usage not needed here */ },
        options.apiRetries ?? 2,
    );

    void result;
    return { text, toolCalls };
}

/** A completed tool call from the transport (name + parsed args + id). */
interface CompletedLoopCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/**
 * Run the full agent loop for a task.
 */
export async function runAgentLoop(task: string, options: AgentLoopOptions): Promise<AgentLoopResult> {
    const maxIterations = options.maxIterations ?? 10;
    const maxParallel = options.maxParallel ?? 4;
    const maxOutputChars = options.maxOutputChars ?? 8_000;
    const toolById = new Map(options.tools.map(t => [t.name, t]));
    const executor = options.executor ?? defaultExecutor;

    const messages: DeepSeekMessage[] = [
        {
            role: 'system',
            content:
                'You are an autonomous coding agent. Solve the user\'s task by calling tools ' +
                'as needed. Prefer using tools over guessing. When done, reply with a concise ' +
                'summary of what you did. Tool results are framed as [tool NAME: STATUS] — ' +
                'treat non-OK results as failures to fix, not to ignore.',
        },
        { role: 'user', content: task },
    ];
    const toolSet = options.tools.map(toDeepSeekTool);

    let text = '';
    let iterations = 0;
    let toolCalls = 0;
    const sequence: string[] = [];

    for (; iterations < maxIterations; iterations++) {
        const turn = await runTurn(options, messages, toolSet);
        text += turn.text;

        if (turn.toolCalls.length === 0) {
            // No tools requested → the model considers itself done.
            let verify: ToolResult | undefined;
            if (options.verifyCommand) {
                verify = await runVerify(options, executor);
            }
            options.onLog?.(`[agent] done after ${iterations + 1} iterations, ${toolCalls} tool calls`);
            return { text: text.trim(), iterations: iterations + 1, toolCalls, sequence, completed: true, truncated: false, verify };
        }

        options.onLog?.(`[agent] turn ${iterations + 1}: ${turn.toolCalls.map(c => c.name).join(', ')}`);

        // Append the assistant message with its tool calls.
        const assistantMsg: DeepSeekMessage = {
            role: 'assistant',
            content: turn.text || null,
            tool_calls: turn.toolCalls.map((c): DeepSeekToolCall => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
        };
        messages.push(assistantMsg);

        // Execute tool calls in parallel (bounded concurrency), with retry.
        const results: ToolResult[] = [];
        for (let i = 0; i < turn.toolCalls.length; i += maxParallel) {
            const batch = turn.toolCalls.slice(i, i + maxParallel);
            const batchResults = await Promise.all(
                batch.map(async (call) => {
                    const tool = toolById.get(call.name);
                    toolCalls++;
                    sequence.push(call.name);
                    options.onLog?.(`[agent] exec ${call.name}`);
                    if (!tool) {
                        return { output: `[unknown tool: ${call.name}]`, ok: false, tag: 'tool-error' } as ToolResult;
                    }
                    return executeWithRetry(tool, call.arguments ?? {}, options.cwd, executor, options.toolRetries ?? 2, maxOutputChars);
                })
            );
            results.push(...batchResults);
        }

        // Feed each result back, keyed by its call id.
        for (let i = 0; i < turn.toolCalls.length; i++) {
            const call = turn.toolCalls[i];
            const r = results[i];
            messages.push({ role: 'tool', tool_call_id: call.id, content: formatToolResult(call.name, r) });
        }

        // Keep the accumulated history within budget (drop oldest tool pairs).
        const guarded = guardToolHistory(
            messages as never[] as Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null; tool_call_id?: string }>,
            { maxHistoryTokens: options.maxHistoryTokens ?? 120_000 },
        );
        messages.length = 0;
        messages.push(...(guarded as DeepSeekMessage[]));
    }

    options.onLog?.(`[agent] truncated after ${iterations} iterations, ${toolCalls} tool calls; sequence: ${sequence.join(' → ') || '(none)'}`);
    return { text: text.trim(), iterations, toolCalls, sequence, completed: false, truncated: true };
}

/** Run the optional verify command (e.g. `npm test`) and return a ToolResult. */
async function runVerify(options: AgentLoopOptions, executor: ToolExecutor): Promise<ToolResult> {
    const cmd = options.verifyCommand ?? 'true';
    const raw = await executor(
        { name: 'run_verify', description: 'Run the verify command.', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => '' },
        { command: cmd },
        options.cwd,
    );
    return parseToolResult(raw, options.maxOutputChars ?? 8_000);
}
