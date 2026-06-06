import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { DeepSeekMessage } from '../api/types.js';
import { extractImageParts, injectVisionDescriptions, hasImageParts } from '../transform/messages.js';
import { describeImage as describeWithGemini } from './gemini.js';
import { describeImage as describeWithGemma4 } from './gemma4.js';
import { getVisionModel, getOllamaBaseUrl, VISION_MODELS } from '../config.js';
import { log } from '../log.js';
import type { SecretStore } from '../secrets.js';

/**
 * Vision preprocessing pipeline.
 *
 * When messages contain image parts:
 * 1. Hash each image to identify duplicates (same image re-sent in history)
 * 2. Send NEW images to the configured vision model (Gemma 4 / Gemini) for description
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

    const visionModelId = getVisionModel();
    const providerInfo = VISION_MODELS.find(m => m.id === visionModelId) ?? VISION_MODELS[0];
    const providerName = providerInfo.name;

    // Resolve credentials / endpoint based on provider
    let describeFn: (data: Uint8Array, mimeType: string, credential: string, prompt?: string) => Promise<import('./types.js').VisionResult>;
    let credential: string;

    if (visionModelId === 'gemini' || visionModelId === 'gemini-flash-lite') {
        // Both Gemini variants use the same API key but different model endpoints
        const geminiModel = visionModelId === 'gemini-flash-lite' ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash';
        describeFn = (data, mimeType, apiKey, prompt) =>
            describeWithGemini(data, mimeType, apiKey, geminiModel, prompt);
        const key = await secrets.getGeminiApiKey();
        if (!key) {
            return {
                messages: deepseekMessages,
                hadImages: true,
                errors: ['No Gemini API key configured. Images cannot be processed. Run "Nika: Manage Nika Models" and select "Input Gemini API Key". Get a free key at https://aistudio.google.com/apikey'],
            };
        }
        credential = key;
    } else {
        // ollama-gemma4 (default) — no API key needed
        describeFn = describeWithGemma4 as typeof describeWithGemini;
        credential = getOllamaBaseUrl();
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
            `\n\n*Analyzing ${newImageCount} image(s) with ${providerName} vision...*\n\n`
        ));
    }

    // Process each image — only call the vision provider for uncached ones
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

        // Call the selected vision provider for new image
        const prompt = buildVisionPrompt(messages, img.msgIndex);
        const result = await describeFn(img.data, img.mimeType, credential, prompt);

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
        log.warn(`Vision preprocessing: ${errors.length} image(s) failed`, new Error(errors.join('; ')));
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
