/**
 * Embeddings-based virtual-tool expansion.
 *
 * Faithful, self-contained reconstruction of the Copilot Chat agent harness's
 * virtual-tool mechanism, observed directly in the live Copilot bundle
 * (`extension.js`):
 *
 *   - Virtual tool names MUST start with `activate_` — the bundle throws
 *     `"Virtual tool name must start with 'activate_'"` otherwise.
 *   - There is a reserved `activate_embeddings` group whose tools are matched
 *     to the current request by embedding similarity ("high predicted
 *     relevancy for this query", metadata `wasEmbeddingsMatched`,
 *     `wasExpandedByDefault`, `canBeCollapsed`).
 *   - Matching is gated by a threshold config, `chat.virtualTools.threshold`
 *     (= 128 in the observed bundle).
 *   - Copilot itself runs a lightweight summarizer model
 *     (`copilot-utility-small`) that picks which tool *category* to expand
 *     before the main model runs.
 *
 * We cannot call Microsoft's embeddings, so the relevance scorer here is a
 * deterministic lexical overlap (tokenize + weighted term matching) that
 * stands in for a real embeddings matcher. The interface is shaped so a real
 * embeddings provider can be swapped in later without changing the expansion
 * logic (see `VirtualToolMatcher`).
 *
 * This is NOT wired into the live request path yet — it is a self-contained,
 * tested building block we can use to control which tools DeepSeek actually
 * sees (see the module docstring / repo memory).
 */

/** A tool definition with a name + human description (used for matching). */
export interface VirtualToolCandidate {
    /** Stable tool id / function name. */
    name: string;
    /** Natural-language description of what the tool does. */
    description: string;
}

/** A virtual tool group: a category the model may expand on demand. */
export interface VirtualToolGroup {
    /** Group name, e.g. `activate_embeddings` or `activate_file_ops`. */
    name: string;
    /** Fixed category tools always shown for this group. */
    tools: VirtualToolCandidate[];
    metadata: {
        /** True when this group was populated by embedding matching. */
        wasEmbeddingsMatched: boolean;
        /** True when expanded without an explicit tool call. */
        wasExpandedByDefault: boolean;
        /** False = always shown; true = can be collapsed until requested. */
        canBeCollapsed: boolean;
    };
}

/** A single matched (expanded) tool after relevance scoring. */
export interface MatchedTool {
    candidate: VirtualToolCandidate;
    /** Relevance score (higher = more relevant). */
    score: number;
}

/** Embeddings/relevance matcher interface — swap a real embedding here. */
export interface VirtualToolMatcher {
    /**
     * Score how relevant each candidate is to the request text.
     * Returns candidates ordered by descending relevance.
     */
    score(candidates: VirtualToolCandidate[], query: string): MatchedTool[];
}

/** Default matcher: deterministic lexical overlap (stands in for embeddings). */
export class LexicalOverlapMatcher implements VirtualToolMatcher {
    score(candidates: VirtualToolCandidate[], query: string): MatchedTool[] {
        const q = tokenize(query);
        if (q.size === 0) {
            return candidates.map(c => ({ candidate: c, score: 0 }));
        }
        return candidates
            .map(candidate => ({
                candidate,
                score: relevance(candidate, q),
            }))
            .sort((a, b) => b.score - a.score);
    }
}

/** Simple tokenizer: lowercase, split on non-alphanumerics, drop stopwords. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with',
    'this', 'that', 'these', 'those', 'me', 'my', 'you', 'your', 'i', 'is',
    'are', 'be', 'do', 'does', 'can', 'could', 'will', 'would', 'should',
    'how', 'what', 'when', 'where', 'which', 'who', 'please', 'help',
]);
export function tokenize(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
        if (!raw) continue;
        if (STOPWORDS.has(raw)) continue;
        if (raw.length < 2) continue;
        out.add(raw);
    }
    return out;
}

/**
 * Score a candidate against the query term set.
 * Each query term found in the candidate's name/description contributes.
 * Name matches count more than description matches (a tool id is a strong
 * signal). Uses tokenized containment (substring) for robustness.
 */
function relevance(candidate: VirtualToolCandidate, q: Set<string>): number {
    const hayName = candidate.name.toLowerCase();
    const hayDesc = candidate.description.toLowerCase();
    let score = 0;
    for (const term of q) {
        if (hayName.includes(term)) score += 2;
        else if (hayDesc.includes(term)) score += 1;
    }
    return score;
}

/** Reserved name for the embedding-matched group (mirrors the bundle). */
export const EMBEDDINGS_GROUP = 'activate_embeddings';

/** Validates a virtual group name (mirrors the bundle's throw). */
export function assertVirtualGroupName(name: string): void {
    if (!name.startsWith('activate_')) {
        throw new Error(`Virtual tool name must start with 'activate_'`);
    }
}

export interface ExpandOptions {
    /** Minimum relevance score to include an embedding-matched tool. */
    threshold: number;
    /** Maximum tools to return total (guards the DeepSeek 128-tool limit). */
    maxTools?: number;
}

/**
 * Expand a virtual-tool set against a request query.
 *
 * Mirrors Copilot's expansion flow:
 *   1. Fixed groups with `wasExpandedByDefault` are always included.
 *   2. The `activate_embeddings` group is scored against the query; only
 *      candidates at/above `threshold` are expanded (wereEmbeddingsMatched).
 *   3. Collapsible non-embedding groups stay collapsed unless the query
 *      matches them too (the "requested a category" case).
 *
 * @returns The expanded flat tool list (deduped by name), plus a report of
 *          what was matched for diagnostics.
 */
export function expandVirtualTools(
    groups: VirtualToolGroup[],
    query: string,
    options: ExpandOptions,
    matcher: VirtualToolMatcher = new LexicalOverlapMatcher(),
): { tools: VirtualToolCandidate[]; expanded: MatchedTool[]; collapsed: string[] } {
    const threshold = options.threshold;
    const maxTools = options.maxTools ?? 128;

    const result: VirtualToolCandidate[] = [];
    const seen = new Set<string>();
    const expanded: MatchedTool[] = [];
    const collapsed: string[] = [];

    const push = (c: VirtualToolCandidate): void => {
        if (seen.has(c.name)) return;
        seen.add(c.name);
        result.push(c);
    };

    for (const group of groups) {
        assertVirtualGroupName(group.name);

        const isEmbeddings = group.name === EMBEDDINGS_GROUP;
        if (isEmbeddings || group.metadata.canBeCollapsed) {
            // Score against the query.
            const matched = matcher.score(group.tools, query);
            let added = 0;
            for (const m of matched) {
                if (m.score >= threshold) {
                    push(m.candidate);
                    expanded.push(m);
                    added++;
                }
            }
            if (added === 0) collapsed.push(group.name);
            continue;
        }

        // Non-collapsible (always-shown) group.
        for (const c of group.tools) push(c);
    }

    // Respect the max tools budget (defaults to DeepSeek's 128 limit).
    if (result.length > maxTools) {
        return { tools: result.slice(0, maxTools), expanded, collapsed };
    }
    return { tools: result, expanded, collapsed };
}
