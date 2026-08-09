/**
 * DeepSeek API tool constraints and preflight constants.
 *
 * DeepSeek's API: "A max of 128 functions are supported" in one `tools`
 * request (https://api-docs.deepseek.com/api/create-chat-completion).
 */
export const DEEPSEEK_TOOLS_LIMIT = 128;

/** VS Code/Copilot virtual tool prefix (expanded by Copilot, not DeepSeek). */
export const ACTIVATE_TOOL_PREFIX = 'activate_';

/**
 * Provider-owned preflight tool call ID prefix.
 *
 * Format: `deepseek_preflight_activate_<round>_<sha256(toolName)[:32]>`.
 *
 * Alphanumeric/underscore ONLY (upstream #86, 2026-05-18): replayed Copilot
 * chat history is more likely to be accepted when the user switches to
 * another model provider mid-conversation. The old format
 * (`deepseek-preflight-activate:1:<url-encoded-name>`) contained characters
 * (`:`, `%`, ...) that some providers reject in tool call IDs.
 */
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'deepseek_preflight_activate_';
export const PREFLIGHT_CALL_ID_SEPARATOR = '_';
export const PREFLIGHT_TOOL_NAME_HASH_LENGTH = 32;

/** Max preflight activation rounds before giving up with an error. */
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

/**
 * Markers wrapping the tool-drift notice so it can be stripped from the
 * replayed history later (the notice is provider-owned, not user content).
 */
export const TOOL_DRIFT_NOTICE_START = '[nikas-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[nikas-tool-drift-notice-end]: #';
