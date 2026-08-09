import * as vscode from 'vscode';
import { TOOL_DRIFT_NOTICE_END, TOOL_DRIFT_NOTICE_START } from './consts.js';

type ChatMessagePart = vscode.LanguageModelChatRequestMessage['content'][number];

/**
 * Notice shown to the user when the tool list is unstable across turns
 * (cache hit rate drops). Wrapped in markers so it can be stripped from the
 * replayed history later — it is provider-owned, not user content.
 *
 * Ported from upstream Vizards/deepseek-v4-for-copilot (tools/notices.ts).
 */
export function createToolDriftNotice(): string {
    return [
        '',
        TOOL_DRIFT_NOTICE_START,
        '',
        createBlockquote(
            '⚠️ Tool list is unstable; DeepSeek context-cache hit rate may drop. ' +
            'If requests get slower or costlier, disable the experimental "Stabilize Tool List" setting, ' +
            'or use VS Code Configure Tools to disable rarely-used tools.'
        ),
        '',
        TOOL_DRIFT_NOTICE_END,
        '',
    ].join('\n');
}

/**
 * Strip provider-owned notices (between TOOL_DRIFT_NOTICE_START/END) from
 * assistant text parts so they never reach DeepSeek or other providers.
 */
export function filterProviderNotices(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): readonly vscode.LanguageModelChatRequestMessage[] {
    let changed = false;
    const filteredMessages: vscode.LanguageModelChatRequestMessage[] = [];

    for (const message of messages) {
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
            filteredMessages.push(message);
            continue;
        }

        let messageChanged = false;
        const filteredContent: ChatMessagePart[] = [];
        for (const part of message.content) {
            if (!(part instanceof vscode.LanguageModelTextPart)) {
                filteredContent.push(part);
                continue;
            }

            const value = stripProviderNotices(part.value);
            if (value === part.value) {
                filteredContent.push(part);
                continue;
            }

            changed = true;
            messageChanged = true;
            if (value.length > 0) {
                filteredContent.push(new vscode.LanguageModelTextPart(value));
            }
        }

        if (!messageChanged) {
            filteredMessages.push(message);
        } else if (filteredContent.length > 0) {
            filteredMessages.push({ ...message, content: filteredContent });
        } else {
            changed = true;
        }
    }

    return changed ? filteredMessages : messages;
}

function stripProviderNotices(value: string): string {
    let result = value;
    while (true) {
        const startIndex = result.indexOf(TOOL_DRIFT_NOTICE_START);
        if (startIndex < 0) {
            return result;
        }

        const endMarkerIndex = result.indexOf(TOOL_DRIFT_NOTICE_END, startIndex);
        const endIndex = endMarkerIndex < 0 ? result.length : endMarkerIndex + TOOL_DRIFT_NOTICE_END.length;
        result = removeRangeWithWhitespace(result, startIndex, endIndex);
    }
}

function removeRangeWithWhitespace(value: string, startIndex: number, endIndex: number): string {
    let removeStart = startIndex;
    while (removeStart > 0 && isWhitespace(value.charAt(removeStart - 1))) {
        removeStart -= 1;
    }

    let removeEnd = endIndex;
    while (removeEnd < value.length && isWhitespace(value.charAt(removeEnd))) {
        removeEnd += 1;
    }

    return value.slice(0, removeStart) + value.slice(removeEnd);
}

function isWhitespace(char: string): boolean {
    return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function createBlockquote(value: string): string {
    return value
        .split(/\r?\n/)
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
}
