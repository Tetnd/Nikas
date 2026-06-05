/**
 * DeepSeek API request/response types (OpenAI-compatible).
 */
export interface DeepSeekMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | DeepSeekContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: DeepSeekToolCall[];
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
    thinking_tokens?: number;
    stream_options?: {
        include_usage: boolean;
    };
}

export interface DeepSeekResponse {
    id: string;
    object: string;
    created: number;
    model: string;
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
