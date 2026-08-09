/**
 * DeepSeek API request/response types (OpenAI-compatible).
 */
export interface DeepSeekMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | DeepSeekContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: DeepSeekToolCall[];
    /**
     * Chain-of-thought (thinking mode). DeepSeek REQUIRES this to be passed
     * back on assistant messages when tools are used with thinking enabled —
     * omitting it makes the API return HTTP 400
     * ("The reasoning_text in the thinking mode must be passed back").
     */
    reasoning_content?: string;
}

export interface DeepSeekContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string; // data:image/...;base64,... or https://...
        detail?: 'auto' | 'low' | 'high';
    };
}

export interface DeepSeekToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface DeepSeekTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface DeepSeekRequest {
    model: string;
    messages: DeepSeekMessage[];
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stream: boolean;
    stop?: string[];
    tools?: DeepSeekTool[];
    tool_choice?: 'none' | 'auto' | 'required';
    thinking?: {
        type: 'enabled' | 'disabled';
    };
    reasoning_effort?: 'low' | 'high' | 'max';
    stream_options?: {
        include_usage: boolean;
    };
}

export interface DeepSeekResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    /**
     * Server-side fingerprint. Changes when the backend serving the model
     * changes (e.g. a checkpoint swap like Preview → 0731), so it's the best
     * runtime signal that we're actually hitting the new version.
     */
    system_fingerprint?: string;
    choices: DeepSeekChoice[];
    usage?: DeepSeekUsage;
}

export interface DeepSeekChoice {
    index: number;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    message?: DeepSeekMessage;
    delta?: DeepSeekDelta;
}

export interface DeepSeekDelta {
    role?: string;
    content?: string;
    /** Thinking-mode CoT, streamed alongside content (chat-completions). */
    reasoning_content?: string;
    tool_calls?: DeepSeekToolCallDelta[];
}

export interface DeepSeekToolCallDelta {
    index: number;
    id?: string;
    type?: 'function';
    function?: {
        name?: string;
        arguments?: string;
    };
}

export interface DeepSeekUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: {
        reasoning_tokens: number;
    };
}

export interface DeepSeekErrorResponse {
    error: {
        message: string;
        type: string;
        code?: string;
    };
}

// --- Responses API (POST /responses, currently flash-only) ---

export interface DeepSeekResponsesRequest {
    model: string;
    /** String or input item list. At least one of `input` and `instructions` is required. */
    input: string | DeepSeekResponsesInputItem[];
    /** Inserted as the first system message. */
    instructions?: string;
    stream: boolean;
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    reasoning?: {
        effort?: 'none' | 'low' | 'high' | 'max';
    };
    tools?: DeepSeekResponsesTool[];
    tool_choice?: 'none' | 'auto' | 'required';
}

/**
 * A function tool in the Responses API format.
 *
 * NOTE: unlike Chat Completions, the Responses API FLATTENS the function
 * definition — `name`, `description`, and `parameters` sit at the top level of
 * the tool object, NOT under a nested `function` key. Sending the Chat
 * Completions shape (`{ type, function: { name, ... } }`) fails with
 * `tools[0]: missing field name`.
 */
export interface DeepSeekResponsesTool {
    type: 'function';
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
}

export type DeepSeekResponsesInputItem =
    | DeepSeekResponsesMessageItem
    | DeepSeekResponsesReasoningTextItem
    | DeepSeekResponsesReasoningSummaryItem
    | DeepSeekResponsesFunctionCallItem
    | DeepSeekResponsesFunctionCallOutputItem;

/**
 * Thinking-mode reasoning item. DeepSeek REQUIRES the model's reasoning_text
 * to be passed back as an input item in subsequent requests when tools are
 * used with thinking enabled (HTTP 400 otherwise). It must be placed right
 * before the assistant message / function_call it belongs to.
 */
export interface DeepSeekResponsesReasoningTextItem {
    type: 'reasoning_text';
    text: string;
}

/**
 * OpenAI-style reasoning item (some Responses API variants emit the CoT as
 * `reasoning` with a `summary` instead of `reasoning_text` with `text`).
 * Captured from the stream so it can be round-tripped verbatim.
 */
export interface DeepSeekResponsesReasoningSummaryItem {
    type: 'reasoning';
    summary: string | Array<{ type: 'summary_text'; text: string }>;
}

export interface DeepSeekResponsesMessageItem {
    type: 'message';
    role: 'system' | 'developer' | 'user' | 'assistant';
    content: string | DeepSeekResponsesContentPart[];
}

export interface DeepSeekResponsesContentPart {
    type: 'input_text' | 'output_text';
    text: string;
}

export interface DeepSeekResponsesFunctionCallItem {
    type: 'function_call';
    /** OpenAI-style call id (some providers also emit `id`). */
    call_id?: string;
    id?: string;
    name: string;
    /** JSON string */
    arguments: string;
}

export interface DeepSeekResponsesFunctionCallOutputItem {
    type: 'function_call_output';
    call_id: string;
    output: string;
}

/**
 * A single SSE event from the Responses API stream.
 * Events carry `type` + `sequence_number`; the stream ends with
 * response.completed / response.incomplete / response.failed (no `[DONE]`).
 */
export interface DeepSeekResponsesEvent {
    type: string;
    sequence_number?: number;
    output_index?: number;
    delta?: string;
    item?: DeepSeekResponsesInputItem & { output_index?: number };
    response?: DeepSeekResponsesResponse;
}

export interface DeepSeekResponsesResponse {
    id: string;
    object: string;
    status: string;
    model?: string;
    system_fingerprint?: string;
    output: DeepSeekResponsesInputItem[];
    error?: {
        message?: string;
        code?: string;
    };
    usage?: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        input_tokens_details?: {
            cached_tokens?: number;
        };
        output_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
}
