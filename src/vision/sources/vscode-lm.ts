import * as vscode from 'vscode';
import { IMAGE_DESCRIPTION_PROMPT } from '../consts.js';
import { visionLog } from '../log.js';
import type { VisionDescriber, VisionDescriptionRequest, VisionLanguageModelOption, VisionProxySource } from '../types.js';

/**
 * VS Code LM vision describer.
 *
 * Wraps a vscode.LanguageModelChat to describe images. This lets users pick
 * any vision-capable model already available in Copilot (e.g. GPT-4o, Claude,
 * Gemini via Nikas's provider, etc.) for image description.
 */

export class VSCodeLanguageModelVisionDescriber implements VisionDescriber {
    readonly source: VisionProxySource = 'vscode-lm';

    constructor(private readonly model: vscode.LanguageModelChat) { }

    get id(): string {
        return this.model.id;
    }

    async describe(request: VisionDescriptionRequest): Promise<string> {
        const visionMsg = vscode.LanguageModelChatMessage.User([
            ...request.images.map(
                (image) => new vscode.LanguageModelDataPart(image.data, image.mimeType),
            ),
            new vscode.LanguageModelTextPart(request.prompt),
        ] as (vscode.LanguageModelDataPart | vscode.LanguageModelTextPart)[]);

        let response: vscode.LanguageModelChatResponse;
        try {
            response = await this.model.sendRequest([visionMsg], {}, request.token);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            visionLog.warn(`Vision describe failed for ${this.model.id}: ${msg}`);
            if (msg.toLowerCase().includes('image')) {
                throw new Error(`The model "${this.model.id}" does not support image input through Copilot. Pick a different vision model.`);
            }
            throw err;
        }

        let description = '';
        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                description += chunk.value;
            }
        }
        return description.trim();
    }
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

/** Models and vendors to exclude from the vision model picker. */
const EXCLUDED_VISION_MODEL_IDS = new Set([
    'copilot-utility',
    'copilot-utility-small',
    // Nikas's DeepSeek models — they don't serve as vision describers
    'deepseek-v4-flash',
    'deepseek-v4-pro',
]);
const EXCLUDED_VISION_MODEL_VENDORS = new Set([
    'deepseek',
    'claude-code',
    'copilotcli',
]);

// A minimal valid 1x1 pixel PNG for probing vision capability.
// 68 bytes — small enough that countTokens is trivially fast.
const PROBE_IMAGE_DATA = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * List all available VS Code LM vision models suitable for image description.
 * Filters out models that don't accept image input by probing with
 * `countTokens` on a message containing a tiny image — fast, no network calls.
 */
export async function listVSCodeVisionModels(): Promise<VisionLanguageModelOption[]> {
    const models = await vscode.lm.selectChatModels();
    const visionModels: vscode.LanguageModelChat[] = [];

    for (const model of models) {
        if (EXCLUDED_VISION_MODEL_IDS.has(model.id)) continue;
        if (EXCLUDED_VISION_MODEL_VENDORS.has(model.vendor)) continue;
        if (await isVisionCapableModel(model)) {
            visionModels.push(model);
        }
    }

    return visionModels.map((model) => ({
        key: `${model.vendor}/${model.id}`,
        id: model.id,
        vendor: model.vendor,
        name: model.name ?? model.id,
        family: model.family ?? '',
        version: model.version ?? '',
        label: model.name && model.name !== model.id
            ? `${model.name} (${model.id}) - ${model.vendor}`
            : `${model.id} - ${model.vendor}`,
        description: `${model.vendor}${model.family ? ` / ${model.family}` : ''}`,
        costDescription: formatLanguageModelCost(model),
    }));
}

/**
 * Probe whether a model actually accepts image input by attempting a real
 * `sendRequest` with a tiny 68-byte PNG image.
 *
 * `countTokens` is unreliable for this — some models (like GPT-4o) accept
 * images in `countTokens` but reject them in `sendRequest`. With `sendRequest`
 * the validation error for non-vision models is thrown almost instantly (no
 * network call), while vision models accept the image and start streaming.
 *
 * For vision models a minimal inference does start, but the 68-byte 1×1 PNG
 * is trivial and we cancel the token immediately after the request is accepted.
 * This happens once per model per VS Code session.
 */
async function isVisionCapableModel(model: vscode.LanguageModelChat): Promise<boolean> {
    const cts = new vscode.CancellationTokenSource();
    const probeMsg = vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelDataPart(PROBE_IMAGE_DATA, 'image/png'),
        new vscode.LanguageModelTextPart('x'),
    ]);
    try {
        // Non-vision models throw fast with a validation error (no network).
        // Vision models accept the image and resolve.
        await model.sendRequest([probeMsg], {}, cts.token);
        // Vision-capable — cancel immediately to avoid token consumption.
        cts.cancel();
        return true;
    } catch (err) {
        cts.cancel();
        const msg = err instanceof Error ? err.message : String(err);
        const msgLower = msg.toLowerCase();
        // Image/media-type validation errors = model doesn't support images
        if (msgLower.includes('image') || msgLower.includes('media type') || msgLower.includes('media_type')) {
            return false;
        }
        // CancellationError or other transient errors — assume vision-capable
        return true;
    }
}

function formatLanguageModelCost(model: vscode.LanguageModelChat): string | undefined {
    // LanguageModelChat doesn't expose pricing info directly.
    return undefined;
}

/**
 * Get the configured vision prompt, falling back to the default.
 */
export function getVisionPrompt(): string {
    const config = vscode.workspace.getConfiguration('nikas');
    return config.get<string>('visionPrompt', IMAGE_DESCRIPTION_PROMPT).trim()
        || IMAGE_DESCRIPTION_PROMPT;
}

/**
 * Find a vision model by vendor and id using selectChatModels.
 * For Nikas-provided vision models, this should find them if registered
 * and onDidChangeLanguageModelChatInformation has fired.
 */
export async function findVisionModelByKey(
    key: string,
): Promise<vscode.LanguageModelChat | undefined> {
    const [vendor, id] = key.split('/');
    if (!vendor || !id) {
        visionLog.warn(`Invalid vision model key format: "${key}" (expected "vendor/id")`);
        return undefined;
    }

    // Approach 1: Specific vendor + id (most precise)
    try {
        const models = await vscode.lm.selectChatModels({ vendor, id });
        if (models.length > 0) {
            return models[0];
        }
    } catch {
        // Fall through
    }

    // Approach 2: Just vendor, then filter by id
    try {
        const vendorModels = await vscode.lm.selectChatModels({ vendor });
        const match = vendorModels.find((m) => m.id === id);
        if (match) return match;
    } catch {
        // Fall through
    }

    // Approach 3: No filter at all — get ALL models and filter manually.
    // This catches cases where selectChatModels doesn't accept certain vendor names
    // but still returns models from that vendor when unfiltered.
    try {
        const allModels = await vscode.lm.selectChatModels();
        const match = allModels.find((m) => m.vendor === vendor && m.id === id);
        if (match) return match;
    } catch {
        // Fall through
    }

    return undefined;
}
