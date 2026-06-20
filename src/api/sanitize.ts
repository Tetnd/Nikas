/**
 * Sanitization utilities for safe JSON serialization.
 *
 * JavaScript's JSON.stringify will produce lone surrogate escape sequences
 * (e.g., \uD800) when it encounters invalid UTF-16 surrogate pairs in a string.
 * This is technically valid JSON per the ECMAScript spec, but many servers
 * (including DeepSeek's API) reject it with a 400 error.
 *
 * These functions detect lone surrogates and replace them with U+FFFD
 * (Unicode Replacement Character) before serialization.
 */

/**
 * Sanitize a string by replacing lone surrogates (invalid Unicode) with U+FFFD.
 */
export function sanitizeLoneSurrogates(str: string): string {
    let result = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            // High surrogate: check if next char is a low surrogate (valid pair)
            if (i + 1 < str.length) {
                const next = str.charCodeAt(i + 1);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    result += str[i] + str[i + 1]; // valid surrogate pair
                    i++;
                } else {
                    result += '\uFFFD'; // lone high surrogate
                }
            } else {
                result += '\uFFFD'; // lone high surrogate at end of string
            }
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            result += '\uFFFD'; // lone low surrogate
        } else {
            result += str[i];
        }
    }
    return result;
}

/**
 * Recursively walk an object and sanitize all strings for lone surrogates.
 */
export function sanitizeForJson(obj: unknown): unknown {
    if (typeof obj === 'string') {
        return sanitizeLoneSurrogates(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(sanitizeForJson);
    }
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = sanitizeForJson(value);
        }
        return result;
    }
    return obj;
}

/**
 * Safe JSON.stringify that handles lone surrogates.
 */
export function safeStringify(obj: unknown): string {
    return JSON.stringify(sanitizeForJson(obj));
}
