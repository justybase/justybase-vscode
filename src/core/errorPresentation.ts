/**
 * Extracts a non-empty, human-readable message from any thrown value.
 *
 * Result panels must never render a bare "unknown error": an empty driver
 * message is a real possibility (for example a transport error whose only
 * detail lives in `code`), and an `Error` with an empty message is still an
 * error. Walk the cause chain, keep the most specific text, and fall back to
 * the first stable code when no text exists.
 */
const MAX_CAUSE_DEPTH = 5;
const DEFAULT_FALLBACK = 'Query execution failed.';

interface ErrorLike {
    message?: unknown;
    cause?: unknown;
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    hostname?: unknown;
    address?: unknown;
    port?: unknown;
}

interface CollectedError {
    messages: string[];
    codes: string[];
}

function normalizeForComparison(message: string): string {
    return message.trim().replace(/^error\s*:\s*/iu, '').toLowerCase();
}

function addCode(codes: string[], value: unknown): void {
    if (typeof value === 'string' && value.trim()) {
        codes.push(value.trim());
        return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        codes.push(String(value));
    }
}

function collectError(error: unknown): CollectedError {
    const messages: string[] = [];
    const codes: string[] = [];
    let current: unknown = error;

    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
        if (current instanceof Error) {
            if (current.message.trim()) messages.push(current.message.trim());
            const candidate = current as Error & ErrorLike;
            addCode(codes, candidate.code);
            addCode(codes, candidate.errno);
            current = candidate.cause;
            continue;
        }
        if (typeof current === 'object') {
            const candidate = current as ErrorLike;
            if (typeof candidate.message === 'string' && candidate.message.trim()) {
                messages.push(candidate.message.trim());
            }
            addCode(codes, candidate.code);
            addCode(codes, candidate.errno);
            current = candidate.cause;
            continue;
        }
        if (typeof current === 'string' && current.trim()) {
            messages.push(current.trim());
        }
        break;
    }

    return { messages, codes };
}

function dedupeMessages(messages: readonly string[]): string[] {
    const unique: string[] = [];
    for (const message of messages) {
        const key = normalizeForComparison(message);
        if (!key) continue;
        if (unique.some(existing => normalizeForComparison(existing).includes(key))) continue;
        for (let index = unique.length - 1; index >= 0; index -= 1) {
            if (key.includes(normalizeForComparison(unique[index]))) unique.splice(index, 1);
        }
        unique.push(message);
    }
    return unique;
}

/**
 * Return a non-empty user-facing query error message. A structured backend
 * message is preserved verbatim; wrapper phrases are joined only when they add
 * information. When the error carries no message at all, the stable error code
 * (for example `ECONNREFUSED`) makes the fallback actionable.
 */
export function describeQueryError(error: unknown, fallback = DEFAULT_FALLBACK): string {
    const collected = collectError(error);
    const messages = dedupeMessages(collected.messages);
    if (messages.length > 0) {
        return messages.join(' — ');
    }
    const code = collected.codes[0];
    return code ? `${fallback} (${code})` : fallback;
}

/** Keep a non-empty message, replacing blank values with the described error. */
export function ensureQueryErrorMessage(
    message: string | undefined,
    error?: unknown,
    fallback = DEFAULT_FALLBACK,
): string {
    const trimmed = message?.trim();
    return trimmed ? trimmed : describeQueryError(error, fallback);
}
