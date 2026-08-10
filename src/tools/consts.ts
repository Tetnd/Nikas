/**
 * DeepSeek API tool constraints.
 *
 * DeepSeek's API: "A max of 128 functions are supported" in one `tools`
 * request (https://api-docs.deepseek.com/api/create-chat-completion).
 */
export const DEEPSEEK_TOOLS_LIMIT = 128;
