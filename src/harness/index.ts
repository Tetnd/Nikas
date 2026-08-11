/**
 * Agent facade — the public, high-level entry point that ties the whole
 * harness together:
 *
 *   task → (category summarizer) → (virtual-tool expansion) → toolset
 *        → (agent loop: model ↔ tools) → result
 *
 * This mirrors Copilot's architecture end-to-end:
 *   - `copilot-utility-small`-style summarizer picks tool categories
 *     (`toolSummarizer.ts`).
 *   - `activate_*` embedding-style expansion scopes which tools the model
 *     actually sees (`virtualTools.ts`).
 *   - A loop runs model-decides → executes → sees-result until done
 *     (`agentLoop.ts`), using the minimal file/search/terminal toolset
 *     (`tools/index.ts`) and the DeepSeek transport (`api/deepseek.ts`).
 *
 * Everything is injectable so it can be exercised with mocks in tests.
 */
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from './agentLoop.js';
import { selectToolsForTask, type CategorySelector } from './toolSummarizer.js';
import { EMBEDDINGS_GROUP, type VirtualToolGroup } from './virtualTools.js';
import type { AgentTool } from './tools/index.js';

/** Build virtual groups from a flat AgentTool[] so expansion can scope them. */
export function toVirtualGroups(
    tools: AgentTool[],
    opts?: { alwaysShown?: string[]; collapsible?: string[] },
): VirtualToolGroup[] {
    const always = new Set(opts?.alwaysShown ?? []);
    const collapsible = new Set(opts?.collapsible ?? []);
    const groups: VirtualToolGroup[] = [];

    const fixed: VirtualToolGroup['tools'] = [];
    const emb: VirtualToolGroup['tools'] = [];
    const extra: { name: string; tools: AgentTool[] }[] = [];
    const extraNames = new Set<string>();

    for (const t of tools) {
        if (collapsible.has(t.name)) {
            const cat = `activate_${t.name}`;
            let g = extra.find(e => e.name === cat);
            if (!g) {
                g = { name: cat, tools: [] };
                extra.push(g);
                extraNames.add(cat);
            }
            g.tools.push(t);
        } else if (always.has(t.name)) {
            fixed.push({ name: t.name, description: t.description });
        } else {
            emb.push({ name: t.name, description: t.description });
        }
    }

    if (fixed.length) {
        groups.push({
            name: 'activate_fixed',
            metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: true, canBeCollapsed: false },
            tools: fixed,
        });
    }
    for (const g of extra) {
        groups.push({
            name: g.name,
            metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true },
            tools: g.tools.map(t => ({ name: t.name, description: t.description })),
        });
    }
    if (emb.length) {
        groups.push({
            name: EMBEDDINGS_GROUP,
            metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true },
            tools: emb,
        });
    }
    return groups;
}

export interface AgentRunOptions extends Omit<AgentLoopOptions, 'tools'> {
    /** Full toolset the agent may use. */
    tools: AgentTool[];
    /** Tool names always shown (never collapsed). */
    alwaysShown?: string[];
    /** Tool names treated as collapsible categories. */
    collapsible?: string[];
    /** Optional category selector. If omitted, all collapsible groups expand. */
    categorySelector?: CategorySelector;
    /** Optional matcher/expansion override (unused by the facade by default). */
    maxTools?: number;
    /** Optional logger (category selection + agent loop). */
    onLog?: (msg: string) => void;
}

/**
 * Run the full agent: pick tool categories → run the loop against DeepSeek.
 */
export async function runAgent(task: string, options: AgentRunOptions): Promise<AgentLoopResult> {
    const groups = toVirtualGroups(options.tools, {
        alwaysShown: options.alwaysShown,
        collapsible: options.collapsible,
    });

    // Summarizer picks which collapsible categories matter for this task.
    const selected = await selectToolsForTask(
        groups,
        task,
        options.categorySelector,
        options.maxTools ?? 128,
        options.signal,
        options.onLog,
    );

    // Filter the real toolset down to what the model is allowed to call.
    const allowed = new Set(selected.map(t => t.name));
    const scopedTools = options.tools.filter(t => allowed.has(t.name));

    return runAgentLoop(task, {
        ...options,
        tools: scopedTools,
        onLog: options.onLog,
    });
}
