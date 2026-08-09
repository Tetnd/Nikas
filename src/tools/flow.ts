import * as vscode from 'vscode';
import {
    ACTIVATE_TOOL_PREFIX,
    MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST,
} from './consts.js';
import { createToolDriftNotice, filterProviderNotices } from './notices.js';
import {
    createPreflightToolCallId,
    filterPreflightControlFlow,
    inspectActivatePreflight,
} from './preflight.js';

interface ToolFlowOptions {
    stabilizeToolList: boolean;
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    tools: readonly vscode.LanguageModelChatTool[] | undefined;
    progress: vscode.Progress<vscode.LanguageModelResponsePart>;
}

interface ToolFlowResult {
    preflightHandled: boolean;
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    initialResponseNotice?: string;
}

/**
 * Process the tool preflight flow for one chat request.
 *
 * - Always: strip provider-owned preflight artifacts (`activate_*` tool
 *   calls, tool results, empty text leftovers, tool-drift notices) from the
 *   history sent to DeepSeek.
 * - When `nikas.experimental.stabilizeToolList` is enabled: if VS
 *   Code/Copilot virtual `activate_*` tools are still unexpanded, emit
 *   provider-safe preflight tool calls so Copilot expands them (up to
 *   MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST rounds) and SHORT-CIRCUIT the
 *   request — the real DeepSeek call happens once the tool list is stable.
 *
 * Ported from upstream Vizards/deepseek-v4-for-copilot (tools/flow.ts,
 * v0.5.1 #77 + #86).
 */
export function processToolFlow({
    stabilizeToolList,
    messages,
    tools,
    progress,
}: ToolFlowOptions): ToolFlowResult {
    const filteredMessages = filterProviderNotices(filterPreflightControlFlow(messages));

    if (!stabilizeToolList) {
        return {
            preflightHandled: false,
            messages: filteredMessages,
        };
    }

    const activatePreflight = inspectActivatePreflight(messages, tools);
    if (activatePreflight.remainingActivatorNames.length > 0) {
        if (activatePreflight.rounds >= MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST) {
            throw new Error(
                `Experimental tool-list stabilization tried ${MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST} rounds ` +
                `but still could not get a stable enabled-tools list. Turn the setting off, or use ` +
                `VS Code Configure Tools to disable tools you rarely use first.`
            );
        }

        const nextRound = activatePreflight.rounds + 1;
        for (const toolName of activatePreflight.remainingActivatorNames) {
            progress.report(
                new vscode.LanguageModelToolCallPart(
                    createPreflightToolCallId(nextRound, toolName),
                    toolName,
                    {},
                ),
            );
        }

        return { preflightHandled: true, messages };
    }

    const hasUnexpandedActivateTools =
        activatePreflight.rounds > 0 &&
        tools?.some((tool) => tool.name.startsWith(ACTIVATE_TOOL_PREFIX));

    return {
        preflightHandled: false,
        messages: filteredMessages,
        initialResponseNotice: hasUnexpandedActivateTools ? createToolDriftNotice() : undefined,
    };
}
