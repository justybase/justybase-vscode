export function isBinaryValue(value: unknown): value is Buffer {
    return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

/**
 * Canonical text representation used by data exports and the Oracle importer.
 * The prefix prevents a hexadecimal string from being confused with ordinary text.
 */
export function formatBinaryValue(value: unknown): string | undefined {
    if (!isBinaryValue(value)) {
        return undefined;
    }

    return `hex:${Buffer.from(value).toString('hex').toUpperCase()}`;
}

export function extractBinaryHex(value: string): string | undefined {
    const match = value.trim().match(/^(?:hex:|0x)([0-9a-f]+)$/i);
    if (!match || match[1].length % 2 !== 0) {
        return undefined;
    }

    return match[1].toUpperCase();
}
