import { log } from '../log.js';

/**
 * Vision-specific diagnostic logging.
 * Wraps the main Nikas logger with a vision prefix for easy filtering.
 */

const PREFIX = '[Vision]';

export const visionLog = {
    info: (message: string): void => {
        log.info(`${PREFIX} ${message}`);
    },

    warn: (message: string, err?: unknown): void => {
        log.warn(`${PREFIX} ${message}`, err);
    },

    error: (message: string, err?: unknown): void => {
        log.error(`${PREFIX} ${message}`, err);
    },
};
