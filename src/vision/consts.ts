/**
 * Vision pipeline constants.
 *
 * Keep these in English and stable so prompt shape and token estimates
 * remain consistent regardless of VS Code display language.
 */

/** Wrapper applied to vision model descriptions before insertion into the chat prompt. */
export const IMAGE_DESCRIPTION_PREFIX = '[Image Description: ';
export const IMAGE_DESCRIPTION_SUFFIX = ']';

/**
 * Stable fallback marker inserted when the vision model fails or is unavailable.
 */
export const IMAGE_DESCRIPTION_UNAVAILABLE = '[Image Description unavailable]';

/** MIME type used for replay markers embedded in assistant responses. */
export const REPLAY_MARKER_MIME = 'stateful_marker';

/** Writer ID embedded in replay markers to identify Nikas-generated markers. */
export const REPLAY_MARKER_WRITER_ID = 'nikas';

/**
 * Prompt sent to the vision model when describing image attachments.
 * Returns one concise factual description suitable for inserting into a text-only chat prompt.
 */
export const IMAGE_DESCRIPTION_PROMPT =
    'Describe all image attachments in this message.\n\n' +
    'If there is one image, describe it directly.\n' +
    'If there are multiple images:\n' +
    '1. Describe each image separately, preserving their order.\n' +
    '2. Then provide a combined description explaining the overall context and ' +
    'relationships across the images.\n\n' +
    'Return one concise factual description suitable for inserting into a ' +
    'text-only chat prompt. Include visible text, objects, UI elements, people, ' +
    'and relevant context. Do not invent details.';
