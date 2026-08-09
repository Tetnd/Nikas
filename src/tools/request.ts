import { DEEPSEEK_TOOLS_LIMIT } from './consts.js';

/**
 * DeepSeek supports at most 128 functions in a single `tools` request.
 * Enforce the limit client-side with a clear, actionable error instead of
 * letting the API reject the request with an opaque 400.
 *
 * Ported from upstream Vizards/deepseek-v4-for-copilot (tools/request.ts,
 * v0.5.1 #77).
 */
export function assertToolsWithinLimit(tools: readonly unknown[], label: string): void {
    if (tools.length > DEEPSEEK_TOOLS_LIMIT) {
        throw new Error(
            `DeepSeek supports at most ${DEEPSEEK_TOOLS_LIMIT} functions in a single tools request, ` +
            `but this ${label} request contains ${tools.length}. ` +
            `Use VS Code Configure Tools (workbench.action.chat.configureTools) to disable tools you rarely use.`
        );
    }
}
