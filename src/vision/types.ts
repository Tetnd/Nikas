/**
 * Shared vision types used by the vision pipeline.
 */

/** Result from a single vision model describe call. */
export interface VisionResult {
    description: string;
    success: boolean;
    error?: string;
}

/** A single image part with raw bytes and MIME type. */
export interface VisionImagePart {
    mimeType: string;
    data: Uint8Array;
}

/** Request sent to a vision describer. */
export interface VisionDescriptionRequest {
    prompt: string;
    images: readonly VisionImagePart[];
    token: vscode.CancellationToken;
}

/** Vision describer abstraction — can wrap a VS Code LM model or a custom API endpoint. */
export interface VisionDescriber {
    readonly id: string;
    readonly source: VisionProxySource;
    describe(request: VisionDescriptionRequest): Promise<string>;
}

export type VisionProxySource = 'vscode-lm' | 'api-endpoint';

/** Stats collected during vision resolution for diagnostics. */
export interface VisionResolutionStats {
    inputImageParts: number;
    inputImageMessages: number;
    currentImageMessages: number;
    generatedImageMessages: number;
    replayedImageMessages: number;
    omittedImageMessages: number;
    unavailableImageMessages: number;
    failedImageMessages: number;
    droppedImageParts: number;
    markerVisionTextChars: number;
    invalidMarkerVisionMetadata: number;
}

/** Full result of vision resolution. */
export interface VisionResolutionResult {
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    stats: VisionResolutionStats;
    replayMarkerMetadata: ReplayMarkerMetadata;
    visionModelId?: string;
    visionProxySource?: VisionProxySource;
    initialResponseNotice?: string;
}

/** Metadata carried in replay markers for the next turn. */
export interface ReplayMarkerMetadata {
    visionText?: string;
    reasoningText?: string;
}

/** Represents a selectable VS Code LM model option for vision. */
export interface VisionLanguageModelOption {
    key: string;
    id: string;
    vendor: string;
    name: string;
    family: string;
    version: string;
    label: string;
    description: string;
    costDescription?: string;
}

import * as vscode from 'vscode';
