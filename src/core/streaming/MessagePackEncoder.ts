/**
 * Handles MessagePack encoding with proper data sanitization.
 * Specifically handles BigInt, special types, and nested structures.
 */
export class MessagePackEncoder {
    /**
     * Sanitize data for MessagePack encoding, specifically handling BigInt.
     * Uses a fast recursive walker instead of JSON.stringify to avoid performance penalty.
     */
    sanitizeForMessagePack(data: unknown): unknown {
        if (data === null || typeof data !== 'object') {
            if (typeof data === 'bigint') {
                if (data >= Number.MIN_SAFE_INTEGER && data <= Number.MAX_SAFE_INTEGER) {
                    return Number(data);
                }
                return data.toString();
            }
            if (typeof data === 'function') {
                return undefined;
            }
            return data;
        }

        if (data instanceof Date) {
            return data;
        }

        if (Array.isArray(data)) {
            const arr = new Array(data.length);
            for (let i = 0; i < data.length; i++) {
                arr[i] = this.sanitizeForMessagePack(data[i]);
            }
            return arr;
        }

        // Handle Buffer/Uint8Array as they are supported by MessagePack
        if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))) {
            return data;
        }

        // If object has a toJSON method (like some driver types for Time/Interval), use it
        if (typeof (data as { toJSON?: unknown }).toJSON === 'function') {
            return (data as { toJSON: () => unknown }).toJSON();
        }

        const obj: Record<string, unknown> = {};
        for (const key in data as Record<string, unknown>) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                const val = this.sanitizeForMessagePack((data as Record<string, unknown>)[key]);
                if (val !== undefined) {
                    obj[key] = val;
                }
            }
        }
        return obj;
    }

    /**
     * Encode result sets to MessagePack binary format
     */
    encodeResultSets(resultSets: unknown[]): unknown {
        return this.sanitizeForMessagePack(resultSets);
    }

    /**
     * Encode a streaming chunk for transmission
     */
    encodeChunk(chunk: { rows: unknown[][] }): unknown {
        return this.sanitizeForMessagePack(chunk.rows);
    }
}
