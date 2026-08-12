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
 * Prompt sent to the vision model when describing image/PDF attachments.
 * Returns one concise factual description suitable for inserting into a text-only chat prompt.
 */
export const IMAGE_DESCRIPTION_PROMPT =
    'Describe all attached images and/or PDF documents in this message.\n\n' +
    'If there is one attachment, describe it directly.\n' +
    'If there are multiple attachments:\n' +
    '1. Describe each one separately, preserving their order.\n' +
    '2. Then provide a combined description explaining the overall context and ' +
    'relationships across the attachments.\n\n' +
    'For PDF documents, read the pages and transcribe the meaningful content — ' +
    'text, tables, code, diagrams, and layout — as completely and accurately as ' +
    'possible, including any text visible in scanned pages.\n\n' +
    'Return one concise factual description suitable for inserting into a ' +
    'text-only chat prompt. Include visible text, objects, UI elements, people, ' +
    'and relevant context. Do not invent details.';

/**
 * Structured image-extraction prompt (v0.7.85). Richer than the generic
 * prompt: asks the vision model to OCR text verbatim, transcribe tables in
 * markdown, and report layout/dimensions — the details DeepSeek actually
 * needs when it can't see the original image. Kept stable and English.
 */
export const IMAGE_DESCRIPTION_PROMPT_STRUCTURED =
    'Extract the VISUAL content of the attached image(s) as faithfully as possible, ' +
    'in a way that lets a coding assistant reason about them without seeing the original.\n\n' +
    'For each image, in order:\n' +
    '- OCR: transcribe ALL visible text verbatim (labels, headings, numbers, error messages, code).\n' +
    '- Tables: transcribe every cell, row by row, as a markdown table.\n' +
    '- Layout: describe the structure — sections, panels, diagrams, charts, arrows, flow.\n' +
    '- UI: list elements (buttons, inputs, menus) with their visible labels.\n' +
    '- For drawings/diagrams/plans: note dimensions, parts, connections, and annotations.\n\n' +
    'Rules:\n' +
    '- Do NOT invent content that is not visible. If a region is unreadable or blurry, say so.\n' +
    '- Be concrete and structured (short bullets, markdown tables).\n' +
    '- If there are multiple images, describe each one separately preserving their order, ' +
    'then give one combined paragraph on how they relate.';

