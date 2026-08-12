/**
 * VS Code embeddings-backed tool relevance matcher (v0.7.88, D-10).
 *
 * Implements the harness's `VirtualToolMatcher` using VS Code's proposed
 * `lm.computeEmbeddings` when available (F-17 guard: it's a proposed API that
 * may not exist in every build). Scores each tool's description against the
 * request by cosine similarity of embedding vectors.
 *
 * Fallback: when embeddings are unavailable, returns a matcher that scores all
 * candidates 0 (the caller then falls back to no filtering) — or callers can
 * simply skip wiring it.
 */
import * as vscode from 'vscode';
import type { VirtualToolMatcher, VirtualToolCandidate, MatchedTool } from './virtualTools.js';

/** True when the VS Code build exposes lm.computeEmbeddings. */
export function embeddingsAvailable(): boolean {
    try {
        const lm = vscode.lm as unknown as { computeEmbeddings?: unknown };
        return typeof lm.computeEmbeddings === 'function';
    } catch {
        return false;
    }
}

/** Cosine similarity of two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Build an embeddings matcher for a given embedding model (or the first
 * available embedding model). Returns `undefined` when embeddings are
 * unavailable — callers should fall back to no filter.
 */
export function createEmbeddingsMatcher(embeddingModel?: string): VirtualToolMatcher | undefined {
    if (!embeddingsAvailable()) return undefined;

    const lm = vscode.lm as unknown as {
        embeddingModels?: string[];
        computeEmbeddings: (model: string, input: string[], token?: vscode.CancellationToken) => Thenable<{ values: number[] }[]>;
    };

    return {
        score(candidates: VirtualToolCandidate[], query: string): MatchedTool[] {
            const model = embeddingModel && lm.embeddingModels?.includes(embeddingModel)
                ? embeddingModel
                : (lm.embeddingModels?.[0] ?? '');
            if (!model) return candidates.map(c => ({ candidate: c, score: 0 }));

            const texts = candidates.map(c => c.description || c.name);
            const inputs = [query, ...texts];
            try {
                const vectors = lm.computeEmbeddings(model, inputs);
                if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
                    return candidates.map(c => ({ candidate: c, score: 0 }));
                }
                const q = vectors[0]?.values ?? [];
                return candidates
                    .map((candidate, i) => ({
                        candidate,
                        score: cosine(q, vectors[i + 1]?.values ?? []),
                    }))
                    .sort((a, b) => b.score - a.score);
            } catch {
                return candidates.map(c => ({ candidate: c, score: 0 }));
            }
        },
    };
}
