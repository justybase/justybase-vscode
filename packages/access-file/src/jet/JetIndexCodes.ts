/**
 * Constants for creating index entries (port of IndexCodes from
 * JustyBase.UCanAccessCs / Jackcess).
 */

export const ASC_START_FLAG = 0x7f;
export const ASC_NULL_FLAG = 0x00;
export const DESC_START_FLAG = 0x80;
export const DESC_NULL_FLAG = 0xff;

export const ASC_BOOLEAN_TRUE = 0x00;
export const ASC_BOOLEAN_FALSE = 0xff;
export const DESC_BOOLEAN_TRUE = ASC_BOOLEAN_FALSE;
export const DESC_BOOLEAN_FALSE = ASC_BOOLEAN_TRUE;

export function isNullEntry(startEntryFlag: number): boolean {
    return startEntryFlag === ASC_NULL_FLAG || startEntryFlag === DESC_NULL_FLAG;
}

export function getNullEntryFlag(isAscending: boolean): number {
    return isAscending ? ASC_NULL_FLAG : DESC_NULL_FLAG;
}

export function getStartEntryFlag(isAscending: boolean): number {
    return isAscending ? ASC_START_FLAG : DESC_START_FLAG;
}

/** Flips the bits in the given range of the byte array. */
export function flipBytes(value: Uint8Array, offset: number, length: number): void {
    for (let index = offset; index < offset + length; index++) {
        value[index] = ~value[index]! & 0xff;
    }
}
