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
import type { GoalEvaluator, GoalVerdict } from './goalEvaluator.js';
import { defaultPermissionGate, isTerminalTool, type CommandVerdict } from './permission.js';

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
export type ToolExecutor = (tool: AgentTool, args: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<string>;

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
    /**
     * Fail-closed permission gate for terminal commands (v0.7.85). Defaults to
     * the built-in classifier (see permission.ts). Return a non-allowed verdict
     * to block the command without executing it.
     */
    permissionGate?: (command: string, transcript: string) => CommandVerdict;
    /**
     * Whether read-only tool results (read_file / search_text) are cached per
     * run so identical calls are served from cache (v0.7.85). Default true.
     */
    toolResultCache?: boolean;
    /**
     * When true, transient retries apply ONLY to read-only tools — terminal
     * commands with side effects are never auto-retried (v0.7.85). Default
     * false (behavior preserved).
     */
    retryTransientOnlyReadonly?: boolean;
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
    /** Independent completion judge (grok-build goal evaluator). When set, the model's
     *  "done" claim is verified; if the judge says continue, the loop keeps going. */
    goalEvaluator?: GoalEvaluator;
    /** Max iterations to run after the judge says "continue" (safety backstop). Default 5. */
    goalEvaluatorMaxExtraIterations?: number;
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
    /** True if stopped because the model said it was done (and any goal evaluator agreed). */
    completed: boolean;
    /** True if stopped by maxIterations. */
    truncated: boolean;
    /** True if stopped by the goal evaluator's "continue" verdict hitting the extra-iterations cap. */
    goalEvaluatorTruncated?: boolean;
    /** The goal-evaluator verdict when one ran. */
    goalVerdict?: GoalVerdict;
    /** Verify-pass result, when a verify command was provided and run. */
    verify?: ToolResult;
    /** True if the loop stopped because the abort signal fired. */
    aborted?: boolean;
    /** Number of terminal commands blocked by the permission gate. */
    permissionDenied?: number;
}

function toDeepSeekTool(tool: AgentTool): DeepSeekTool {
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

const defaultExecutor: ToolExecutor = async (tool, args, cwd, signal) => tool.execute(args, cwd, signal);

/**
 * Build a bounded, chronological transcript for the goal evaluator.
 * Keeps the most recent items up to a byte budget; skips system + reasoning.
 * Mirrors grok-build's `bounded_goal_transcript`.
 */
function buildGoalTranscript(messages: DeepSeekMessage[], maxChars = 8_000): string {
    const rows: string[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'system') continue;
        const text = typeof m.content === 'string' ? m.content : '';
        const trimmed = text.trim();
        if (!trimmed) continue;
        const capped = trimmed.slice(0, 1_000);
        const row = `[${m.role}] ${capped}`;
        const cost = row.length + 2;
        if (rows.length > 0 && used + cost > maxChars) break;
        used += cost;
        rows.push(row);
    }
    rows.reverse();
    return rows.join('\n\n');
}

/** Abort error with a recognizable name (used across the loop). */
function abortError(): Error {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
}

/** Sleep helper for backoff — abort-aware (resolves immediately on abort by throwing). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const t = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = (): void => {
            cleanup();
            reject(abortError());
        };
        const cleanup = (): void => {
            clearTimeout(t);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
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

/** Retry a transient tool call with exponential backoff (abort-aware). */
async function executeWithRetry(
    tool: AgentTool,
    args: Record<string, unknown>,
    cwd: string,
    executor: ToolExecutor,
    retries: number,
    maxOutputChars: number,
    signal?: AbortSignal,
): Promise<ToolResult> {
    let attempt = 0;
    for (;;) {
        if (signal?.aborted) throw abortError();
        const raw = await executor(tool, args, cwd, signal);
        const result = parseToolResult(raw, maxOutputChars);
        const isTransient = result.tag === 'transient';
        if (!isTransient || attempt >= retries) return result;
        attempt++;
        await sleep(10 * Math.pow(2, attempt - 1), signal); // short backoff (tests)
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
            await sleep(10 * Math.pow(2, attempt - 1), signal);
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

/**
 * Run one agent turn, translating abort signals into a clean `{aborted:true}`
 * result instead of a thrown rejection (v0.7.85 cancellation propagation).
 */
async function runTurnGuarded(
    options: AgentLoopOptions,
    messages: DeepSeekMessage[],
    toolSet: DeepSeekTool[],
): Promise<{ turn?: { text: string; toolCalls: CompletedLoopCall[] }; aborted: boolean }> {
    try {
        const turn = await runTurn(options, messages, toolSet);
        return { turn, aborted: false };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.signal?.aborted || /abort/i.test(msg)) {
            return { aborted: true };
        }
        throw err;
    }
}

/** A completed tool call from the transport (name + parsed args + id). */
interface CompletedLoopCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

// ── v0.7.85 tool-execution hardening ───────────────────────────────────────

/** Deterministic tools whose results are safe to cache within a run. */
function isReadOnlyTool(name: string): boolean {
    return name === 'read_file' || name === 'search_text';
}

/** Canonical JSON of tool args (keys sorted) so equal calls hash identically. */
function canonicalArgs(args: Record<string, unknown>): string {
    try {
        const sort = (v: unknown): unknown => {
            if (Array.isArray(v)) return v.map(sort);
            if (v && typeof v === 'object') {
                const o: Record<string, unknown> = {};
                for (const k of Object.keys(v as Record<string, unknown>).sort()) {
                    o[k] = sort((v as Record<string, unknown>)[k]);
                }
                return o;
            }
            return v;
        };
        return JSON.stringify(sort(args ?? {}));
    } catch {
        return JSON.stringify(args ?? {});
    }
}

/** Shared state for tool execution (built once per run). */
interface ToolExecContext {
    toolById: Map<string, AgentTool>;
    executor: ToolExecutor;
    maxOutputChars: number;
    maxParallel: number;
    signal: AbortSignal;
    permissionGate: (command: string, transcript: string) => CommandVerdict;
    transcript: () => string;
    /** In-flight dedup map for read-only calls (key → shared execution promise). */
    inflight: Map<string, Promise<ToolResult>>;
    cacheEnabled: boolean;
    retryOnlyReadonly: boolean;
    toolRetries: number;
    counters: { toolCalls: number; permissionDenied: number };
    sequence: string[];
    onLog?: (msg: string) => void;
    cwd: string;
}

/** Execute ONE tool call with permission gating, read-only caching, and retry. */
async function executeToolCall(ctx: ToolExecContext, call: CompletedLoopCall): Promise<ToolResult> {
    const tool = ctx.toolById.get(call.name);
    ctx.counters.toolCalls++;
    ctx.sequence.push(call.name);
    ctx.onLog?.(`[agent] exec ${call.name}`);
    if (!tool) {
        return { output: `[unknown tool: ${call.name}]`, ok: false, tag: 'tool-error' };
    }

    // Fail-closed permission gate for terminal commands (v0.7.85).
    if (isTerminalTool(call.name)) {
        const command = String((call.arguments as Record<string, unknown>)?.command ?? '');
        const verdict = ctx.permissionGate(command, ctx.transcript());
        if (!verdict.allowed) {
            ctx.counters.permissionDenied++;
            ctx.onLog?.(`[agent] DENIED ${call.name}: ${verdict.reason}`);
            return {
                output: `[permission denied: ${verdict.reason} — command was NOT executed]`,
                ok: false,
                tag: 'permission',
            };
        }
    }

    // Read-only result cache: identical deterministic calls are served from
    // cache — including duplicates running in the SAME batch (they share one
    // in-flight promise so the tool executes only once per run).
    const cacheKey = `${call.name}:${canonicalArgs(call.arguments ?? {})}`;
    const isReadonly = isReadOnlyTool(call.name);
    if (ctx.cacheEnabled && isReadonly) {
        const inFlight = ctx.inflight.get(cacheKey);
        if (inFlight) {
            ctx.onLog?.(`[agent] cached ${call.name}`);
            const base = await inFlight;
            return {
                ...base,
                output: base.output + '\n[served from cache — identical call earlier in this run]',
            };
        }
        const p = (async (): Promise<ToolResult> => {
            const result = await executeWithRetry(
                tool,
                call.arguments ?? {},
                ctx.cwd,
                ctx.executor,
                ctx.toolRetries,
                ctx.maxOutputChars,
                ctx.signal,
            );
            if (result.ok) ctx.inflight.set(cacheKey, Promise.resolve(result));
            return result;
        })();
        ctx.inflight.set(cacheKey, p);
        return p;
    }

    // Terminal commands with side effects are never auto-retried when the safe
    // mode is on (retryTransientOnlyReadonly).
    const retries = ctx.retryOnlyReadonly && !isReadonly ? 0 : ctx.toolRetries;
    return executeWithRetry(
        tool,
        call.arguments ?? {},
        ctx.cwd,
        ctx.executor,
        retries,
        ctx.maxOutputChars,
        ctx.signal,
    );
}

/** Execute tool calls in bounded-concurrency batches (shared by main + judge loops). */
async function executeCallsInBatches(ctx: ToolExecContext, calls: CompletedLoopCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (let i = 0; i < calls.length; i += ctx.maxParallel) {
        const batch = calls.slice(i, i + ctx.maxParallel);
        const batchResults = await Promise.all(batch.map((call) => executeToolCall(ctx, call)));
        results.push(...batchResults);
    }
    return results;
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
    const sequence: string[] = [];

    // v0.7.85: cancellation + safety wiring.
    const signal = options.signal ?? new AbortController().signal;
    options = { ...options, signal };
    const counters = { toolCalls: 0, permissionDenied: 0 };
    const ctx: ToolExecContext = {
        toolById,
        executor,
        maxOutputChars,
        maxParallel,
        signal,
        permissionGate: options.permissionGate ?? defaultPermissionGate,
        transcript: () => messages
            .slice(-12)
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .join('\n')
            .slice(-4000),
        inflight: new Map<string, Promise<ToolResult>>(),
        cacheEnabled: options.toolResultCache ?? true,
        retryOnlyReadonly: options.retryTransientOnlyReadonly ?? false,
        toolRetries: options.toolRetries ?? 2,
        counters,
        sequence,
        onLog: options.onLog,
        cwd: options.cwd,
    };

    for (; iterations < maxIterations; iterations++) {
        if (signal.aborted) {
            options.onLog?.(`[agent] aborted (signal)`);
            return {
                text: text.trim(), iterations, toolCalls: ctx.counters.toolCalls, sequence,
                completed: false, truncated: false, aborted: true, permissionDenied: ctx.counters.permissionDenied,
            };
        }
        const guarded = await runTurnGuarded(options, messages, toolSet);
        if (guarded.aborted) {
            options.onLog?.(`[agent] aborted (transport)`);
            return {
                text: text.trim(), iterations, toolCalls: ctx.counters.toolCalls, sequence,
                completed: false, truncated: false, aborted: true, permissionDenied: ctx.counters.permissionDenied,
            };
        }
        const turn = guarded.turn!;
        text += turn.text;

        if (turn.toolCalls.length === 0) {
            // No tools requested → the model considers itself done.
            let verify: ToolResult | undefined;
            if (options.verifyCommand) {
                verify = await runVerify(options, executor);
            }
            // Independent completion judge (grok-build pattern): don't just trust
            // the "done" claim — verify it. If the judge says continue, keep going.
            if (options.goalEvaluator) {
                const cap = options.goalEvaluatorMaxExtraIterations ?? 5;
                const judgeCap = Math.min(iterations + cap, maxIterations);
                for (; iterations < judgeCap; iterations++) {
                    if (signal.aborted) {
                        return {
                            text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                            completed: false, truncated: false, aborted: true, permissionDenied: ctx.counters.permissionDenied,
                        };
                    }
                    const transcript = buildGoalTranscript(messages);
                    const verdict = await options.goalEvaluator.evaluate(task, transcript);
                    options.onLog?.(`[goal-eval] verdict=${verdict?.decision ?? 'no-opinion'} (${verdict?.evidence ?? ''})`);
                    if (!verdict || verdict.decision !== 'continue') {
                        return {
                            text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                            completed: true, truncated: false, verify, goalVerdict: verdict,
                            permissionDenied: ctx.counters.permissionDenied,
                        };
                    }
                    // Judge wants more work: feed its next-step as a user nudge.
                    options.onLog?.(`[goal-eval] continue → next: ${verdict.nextStep}`);
                    messages.push({ role: 'user', content: `The completion evaluator says the task is not done yet. Next step: ${verdict.nextStep}. Keep going until it is complete.` });
                    const guardedNext = await runTurnGuarded(options, messages, toolSet);
                    if (guardedNext.aborted) {
                        return {
                            text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                            completed: false, truncated: false, aborted: true, permissionDenied: ctx.counters.permissionDenied,
                        };
                    }
                    const next = guardedNext.turn!;
                    text += next.text;
                    if (next.toolCalls.length === 0) {
                        // Judge said continue but the model still declines to act —
                        // re-evaluate the judge; if it still says continue, stop (don't loop).
                        const transcript = buildGoalTranscript(messages);
                        const re = await options.goalEvaluator.evaluate(task, transcript);
                        options.onLog?.(`[goal-eval] re-verdict=${re?.decision ?? 'no-opinion'} (${re?.evidence ?? ''})`);
                        return {
                            text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                            completed: !re || re.decision !== 'continue', truncated: false, verify,
                            goalVerdict: re ?? verdict, goalEvaluatorTruncated: !!(re && re.decision === 'continue'),
                            permissionDenied: ctx.counters.permissionDenied,
                        };
                    }
                    // Execute the follow-up tool calls (reuse the same batch logic below).
                    const assistantMsg: DeepSeekMessage = {
                        role: 'assistant',
                        content: next.text || null,
                        tool_calls: next.toolCalls.map((c): DeepSeekToolCall => ({
                            id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                        })),
                    };
                    messages.push(assistantMsg);
                    const results = await executeCallsInBatches(ctx, next.toolCalls);
                    for (let i = 0; i < next.toolCalls.length; i++) {
                        messages.push({ role: 'tool', tool_call_id: next.toolCalls[i].id, content: formatToolResult(next.toolCalls[i].name, results[i]) });
                    }
                    // Loop back to the judge to re-evaluate whether the task is now complete.
                }
                // Hit the judge's extra-iteration cap.
                options.onLog?.(`[goal-eval] truncated after extra-iteration cap`);
                return {
                    text: text.trim(), iterations, toolCalls: ctx.counters.toolCalls, sequence,
                    completed: false, truncated: true, goalEvaluatorTruncated: true, verify,
                    permissionDenied: ctx.counters.permissionDenied,
                };
            }
            options.onLog?.(`[agent] done after ${iterations + 1} iterations, ${ctx.counters.toolCalls} tool calls`);
            return {
                text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                completed: true, truncated: false, verify, permissionDenied: ctx.counters.permissionDenied,
            };
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

        // Execute tool calls in parallel (bounded concurrency), with permission
        // gating, read-only caching, and abort-aware retry (v0.7.85).
        const results = await executeCallsInBatches(ctx, turn.toolCalls);
        if (signal.aborted) {
            return {
                text: text.trim(), iterations: iterations + 1, toolCalls: ctx.counters.toolCalls, sequence,
                completed: false, truncated: false, aborted: true, permissionDenied: ctx.counters.permissionDenied,
            };
        }

        // Feed each result back, keyed by its call id.
        for (let i = 0; i < turn.toolCalls.length; i++) {
            const call = turn.toolCalls[i];
            const r = results[i];
            messages.push({ role: 'tool', tool_call_id: call.id, content: formatToolResult(call.name, r) });
        }

        // Keep the accumulated history within budget (drop oldest tool pairs).
        const guardedHistory = guardToolHistory(
            messages as never[] as Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null; tool_call_id?: string }>,
            { maxHistoryTokens: options.maxHistoryTokens ?? 120_000 },
        );
        messages.length = 0;
        messages.push(...(guardedHistory as DeepSeekMessage[]));
    }

    options.onLog?.(`[agent] truncated after ${iterations} iterations, ${ctx.counters.toolCalls} tool calls; sequence: ${sequence.join(' → ') || '(none)'}`);
    return {
        text: text.trim(), iterations, toolCalls: ctx.counters.toolCalls, sequence,
        completed: false, truncated: true, permissionDenied: ctx.counters.permissionDenied,
    };
}

/** Run the optional verify command (e.g. `npm test`) and return a ToolResult. */
async function runVerify(options: AgentLoopOptions, executor: ToolExecutor): Promise<ToolResult> {
    const cmd = options.verifyCommand ?? 'true';
    // The verify command is a shell command — gate it like any terminal tool (v0.7.85).
    const gate = options.permissionGate ?? defaultPermissionGate;
    const verdict = gate(cmd, '');
    if (!verdict.allowed) {
        return { output: `[permission denied: ${verdict.reason} — verify command was NOT executed]`, ok: false, tag: 'permission' };
    }
    const raw = await executor(
        { name: 'run_verify', description: 'Run the verify command.', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => '' },
        { command: cmd },
        options.cwd,
        options.signal,
    );
    return parseToolResult(raw, options.maxOutputChars ?? 8_000);
}
