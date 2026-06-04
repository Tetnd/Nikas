import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { DeepSeekMessage } from '../api/types.js';
import { extractImageParts, injectVisionDescriptions, hasImageParts } from '../transform/messages.js';
import { describeImage } from './gemini.js';
import type { SecretStore } from '../secrets.js';

/**
 * Vision preprocessing pipeline.
 *
 * When messages contain image parts:
 * 1. Hash each image to identify duplicates (same image re-sent in history)
 * 2. Send NEW images to Gemini 2.5 Flash for description
 * 3. Use cached descriptions for already-seen images
 * 4. Inject text descriptions back into the messages
 * 5. Return text-only messages ready for DeepSeek
 */

// In-memory cache: image hash → description. Lives for the session.
const descriptionCache = new Map<string, string>();

function hashImage(data: Uint8Array): string {
    // Hash first 64KB + total size to identify duplicates efficiently
    const slice = data.length > 65536 ? data.subarray(0, 65536) : data;
    const sizeSuffix = `::${data.length}`;
    return crypto.createHash('sha256').update(slice).digest('hex') + sizeSuffix;
}

export async function preprocessVision(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    deepseekMessages: DeepSeekMessage[],
    secrets: SecretStore,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken
): Promise<{ messages: DeepSeekMessage[]; hadImages: boolean; errors: string[] }> {
    if (!hasImageParts(messages)) {
        return { messages: deepseekMessages, hadImages: false, errors: [] };
    }

    const geminiKey = await secrets.getGeminiApiKey();
    if (!geminiKey) {
        return {
            messages: deepseekMessages,
            hadImages: true,
            errors: ['No Gemini API key configured. Images cannot be processed. Run "Nika: Manage Nika Models" and select "Input Gemini API Key". Get a free key at https://aistudio.google.com/apikey'],
        };
    }

    const imageMap = extractImageParts(messages);
    const errors: string[] = [];

    // Collect all images with their hashes, tracking new vs cached
    const allImages: { msgIndex: number; data: Uint8Array; mimeType: string; hash: string; cached: boolean }[] = [];
    let newImageCount = 0;

    for (const [msgIndex, images] of imageMap) {
        for (const img of images) {
            const hash = hashImage(img.data);
            const cached = descriptionCache.has(hash);
            allImages.push({ msgIndex, data: img.data, mimeType: img.mimeType, hash, cached });
            if (!cached) newImageCount++;
        }
    }

    // Only show progress for new images
    if (newImageCount > 0) {
        _progress.report(new vscode.LanguageModelTextPart(
            `\n\n*Analyzing ${newImageCount} image(s) with Gemini vision...*\n\n`
        ));
    }

    // Process each image — only call Gemini for uncached ones
    const descriptionMap = new Map<number, string>();

    for (const img of allImages) {
        if (_token.isCancellationRequested) break;

        if (img.cached) {
            // Use cached description
            const cached = descriptionCache.get(img.hash)!;
            const existing = descriptionMap.get(img.msgIndex) ?? '';
            const prefix = existing ? '\n\n---\n\n' : '';
            descriptionMap.set(img.msgIndex, `${existing}${prefix}${cached}`);
            continue;
        }

        // Call Gemini for new image
        const prompt = buildVisionPrompt(messages, img.msgIndex);
        const result = await describeImage(img.data, img.mimeType, geminiKey, prompt);

        if (result.success) {
            // Cache the result
            descriptionCache.set(img.hash, result.description);

            const existing = descriptionMap.get(img.msgIndex) ?? '';
            const prefix = existing ? '\n\n---\n\n' : '';
            descriptionMap.set(img.msgIndex, `${existing}${prefix}${result.description}`);
        } else {
            errors.push(`Image: ${result.error ?? 'Unknown error'}`);
        }
    }

    if (errors.length > 0) {
        _progress.report(
            new vscode.LanguageModelTextPart(
                `\n\n*Warning: ${errors.length} image(s) could not be processed: ${errors.join('; ')}*\n\n`
            )
        );
    }

    // Inject descriptions into the DeepSeek messages
    const processedMessages = injectVisionDescriptions(deepseekMessages, descriptionMap);

    return { messages: processedMessages, hadImages: true, errors };
}

/**
 * Build a context-aware vision prompt.
 * If the user seems to be asking about text/content in the image,
 * we emphasize OCR and transcription.
 */
function buildVisionPrompt(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _imageMsgIndex: number
): string {
    // Gather recent user messages for context
    const userTexts: string[] = [];
    for (const msg of messages) {
        if (msg.role !== vscode.LanguageModelChatMessageRole.User) continue;
        const content = typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter(p => p instanceof vscode.LanguageModelTextPart)
                .map(p => (p as vscode.LanguageModelTextPart).value)
                .join(' ');
        if (content) userTexts.push(content);
    }

    const recentQueries = userTexts.slice(-3).join(' | ').toLowerCase();
    const wantsText = /chat|message|text|read|transcribe|extract|what does.*say|what.*written|ocr|screenshot|conversation/i.test(recentQueries);

    if (wantsText) {
        return `This is a screenshot. Your task is to transcribe ALL visible text exactly as it appears — every message, every word, line by line. Pay close attention to chat messages, names, timestamps, and any UI text. Do not summarize or paraphrase. Output the full transcript. If text is in a non-English language, transcribe it in that language.`;
    }

    return `Describe this image in detail. Include all visible text (transcribe it exactly if readable), UI elements, code, diagrams, charts, people, objects, colors, and layout. Be thorough and precise. If there is text in the image, transcribe it word-for-word.`;
}
