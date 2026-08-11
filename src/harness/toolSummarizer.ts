/**
 * Tool-category summarizer — mirrors Copilot Chat's `copilot-utility-small`
 * internal model (observed in the live bundle as the `summarizeVirtualTools`
 * request with the prompt "Call this tool when you need access to a new
 * category of tools...").
 *
 * Job: given the user's task and a set of tool GROUPS (categories), return the
 * subset of groups worth expanding BEFORE the main model runs. This keeps the
 * tool list small and relevant so the executor only sees tools that plausibly
 * matter, exactly like Copilot does before invoking the main model.
 *
 * The actual LLM call is pluggable (`CategorySelector`) so it can be tested
 * without a network call. The default implementation uses `streamDeepSeekChat`
 * with a tiny, no-tools, thinking-off request (cheap) and falls back to
 * returning ALL groups if the model call fails — a safe default that never
 * hides tools the user might need.
 */
import type { DeepSeekRequest } from '../api/types.js';
import { EMBEDDINGS_GROUP, type VirtualToolGroup } from './virtualTools.js';
import { getToolKnowledge } from './copilotKnowledge.js';

/** Lazy transport import — avoids loading the vscode-dependent api client at module load (keeps this testable in plain Node). */
async function loadTransport() {
    return (await import('../api/deepseek.js')).streamDeepSeekChat;
}

/** The model used for category selection (a cheap utility model). */
export const SUMMARIZER_MODEL = 'deepseek-v4-flash';
/** Cap on the category-selection output. */
export const SUMMARIZER_MAX_TOKENS = 512;

/**
 * Injected category selector. Returns the names of groups to EXPAND.
 * `undefined` return means "no opinion" → caller falls back to a default.
 */
export interface CategorySelector {
    select(task: string, groups: VirtualToolGroup[], signal?: AbortSignal): Promise<string[] | undefined>;
}

/** Default selector: ask DeepSeek (utility call), fall back to all groups. */
export class DeepSeekCategorySelector implements CategorySelector {
    constructor(private apiKey: string) {}

    async select(task: string, groups: VirtualToolGroup[], signal?: AbortSignal): Promise<string[] | undefined> {
        const request: DeepSeekRequest = {
            model: SUMMARIZER_MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a tool-category selector. Given a user task and a list of ' +
                        'tool categories, choose ONLY the categories relevant to the task. ' +
                        'Respond with a JSON array of category names. No commentary.',
                },
                {
                    role: 'user',
                    content: `Task: ${task}\n\nCategories:\n${groups
                        .map(g => {
                            const names = g.tools.map(t => t.name).join(', ');
                            // Add a one-line hint from the knowledge catalog when available.
                            const hint = g.tools
                                .map(t => getToolKnowledge(t.name)?.category)
                                .filter((c): c is string => !!c)
                                .length > 0
                                ? ` [${[...new Set(g.tools.map(t => getToolKnowledge(t.name)?.category).filter((c): c is string => !!c))].join(', ')}]`
                                : '';
                            return `- ${g.name}${hint}: ${names}`;
                        })
                        .join('\n')}`,
                },
            ],
            temperature: 0,
            max_tokens: SUMMARIZER_MAX_TOKENS,
            stream: true,
            thinking: { type: 'disabled' },
        };

        let text = '';
        try {
            const streamDeepSeekChat = await loadTransport();
            const result = await streamDeepSeekChat(
                request,
                this.apiKey,
                signal ?? new AbortController().signal,
                (t: string) => { text += t; },
                () => { /* no tools on this call */ },
                () => { /* usage not needed */ }
            );
            if (!result.receivedContent || !text.trim()) return undefined;
            return parseCategoryArray(text);
        } catch {
            return undefined; // fall back to all groups
        }
    }
}

/** Parse a JSON array (possibly wrapped in fences/code) from model output. */
export function parseCategoryArray(text: string): string[] | undefined {
    const trimmed = text.trim();
    // Strip markdown fences if present.
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : trimmed;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return undefined;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        if (Array.isArray(parsed)) {
            return parsed.filter((x): x is string => typeof x === 'string').filter(n => n.length > 0);
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Expand a task into a tool list using category selection.
 *
 * Strategy (mirrors Copilot):
 *   1. Always include non-collapsible (always-shown) groups + the embeddings
 *      group's own fixed tools.
 *   2. Ask the selector which additional collapsible groups to expand; if it
 *      has no opinion, expand all collapsible groups.
 *   3. Cap the result at `maxTools`.
 *
 * @returns the flat list of tools to present to the executor.
 */
export async function selectToolsForTask(
    groups: VirtualToolGroup[],
    task: string,
    selector: CategorySelector | undefined,
    maxTools = 128,
    signal?: AbortSignal,
    onLog?: (msg: string) => void,
): Promise<VirtualToolGroup['tools']> {
    const out: VirtualToolGroup['tools'] = [];
    const seen = new Set<string>();
    const push = (name: string, description: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        out.push({ name, description });
    };

    // Always-shown groups + the embeddings group's fixed members.
    const collapsible: VirtualToolGroup[] = [];
    for (const g of groups) {
        if (!g.metadata.canBeCollapsed || g.name === EMBEDDINGS_GROUP) {
            for (const t of g.tools) push(t.name, t.description);
        } else {
            collapsible.push(g);
        }
    }

    // Which collapsible groups to expand.
    let chosen: Set<string>;
    let selectedBy: string;
    if (selector) {
        const picked = await selector.select(task, groups, signal);
        selectedBy = picked ? 'selector' : 'selector-no-opinion → fallback all';
        chosen = new Set(picked ?? collapsible.map(g => g.name));
    } else {
        selectedBy = 'no-selector → all';
        chosen = new Set(collapsible.map(g => g.name));
    }

    const chosenNames = [...chosen].sort().join(', ') || '(none)';
    if (onLog) onLog(`[knowledge] category selection (${selectedBy}): expanded ${chosen.size} groups → ${chosenNames}`);

    for (const g of collapsible) {
        if (chosen.has(g.name)) {
            for (const t of g.tools) push(t.name, t.description);
        }
    }

    return out.slice(0, maxTools);
}
