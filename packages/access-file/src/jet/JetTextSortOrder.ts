/**
 * Text sort-order encoding for index entries (port of TextSortOrder,
 * GeneralLegacyIndexCodes, GeneralIndexCodes and General97IndexCodes from
 * JustyBase.UCanAccessCs / Jackcess).
 *
 * The per-character code tables are generated into JetIndexCodesData.ts by
 * scripts/generate-index-codes.cjs.
 */

import {
    CODES_EXT_GEN,
    CODES_EXT_GEN_LEG,
    CODES_GEN,
    CODES_GEN_97,
    CODES_GEN_LEG,
    MAPPINGS_EXT_GEN_97,
} from './JetIndexCodesData';
import { flipBytes } from './JetIndexCodes';

export class JetTextSortOrder {
    public static readonly General97 = new JetTextSortOrder(1033, -1);
    public static readonly GeneralLegacy = new JetTextSortOrder(1033, 0);
    public static readonly General = new JetTextSortOrder(1033, 1);
    public static readonly Polish = new JetTextSortOrder(1045, 0);
    public static readonly Russian = new JetTextSortOrder(1049, 0);
    public static readonly Turkish = new JetTextSortOrder(1055, 0);
    public static readonly Ukrainian = new JetTextSortOrder(1058, 0);

    public readonly value: number;
    public readonly version: number;

    public constructor(value: number, version: number) {
        this.value = value;
        this.version = version;
    }

    public equals(other: JetTextSortOrder): boolean {
        return this.value === other.value && this.version === other.version;
    }
}

const MAX_TEXT_INDEX_CHAR_LENGTH = 255;

const END_TEXT = 0x01;
const END_EXTRA_TEXT = 0x00;

const UNPRINTABLE_COUNT_START = 7;
const UNPRINTABLE_COUNT_MULTIPLIER = 4;
const UNPRINTABLE_OFFSET_FLAGS = 0x8000;
const UNPRINTABLE_MIDFIX = 0x06;

const INTERNATIONAL_EXTRA_PLACEHOLDER = 0x02;

const CRAZY_CODE_START = 0x80;
const CRAZY_CODE_1 = 0x02;
const CRAZY_CODE_2 = 0x03;
const CRAZY_CODES_SUFFIX = [0xff, 0x02, 0x80, 0xff, 0x80];
const CRAZY_CODES_UNPRINT_SUFFIX = 0xff;

const SURROGATE_EXTRA_BYTE = 0x3f;

const FIRST_CHAR = 0x0000;
const LAST_CHAR = 0x00ff;
const FIRST_EXT_CHAR = 0x0100;
const LAST_EXT_CHAR = 0xffff;

export class ByteStream {
    private _buffer: Uint8Array;
    private _length = 0;

    public constructor(initialCapacity = 16) {
        this._buffer = new Uint8Array(Math.max(initialCapacity, 16));
    }

    public get length(): number {
        return this._length;
    }

    public writeByte(value: number): void {
        this.ensureCapacity(1);
        this._buffer[this._length++] = value & 0xff;
    }

    public writeBytes(bytes: Uint8Array): void {
        this.ensureCapacity(bytes.length);
        this._buffer.set(bytes, this._length);
        this._length += bytes.length;
    }

    public getAt(index: number): number {
        return this._buffer[index] ?? 0;
    }

    public setAt(index: number, value: number): void {
        this._buffer[index] = value & 0xff;
    }

    public getBytes(): Uint8Array {
        return this._buffer.subarray(0, this._length);
    }

    public reset(): void {
        this._length = 0;
    }

    public trimTrailing(minTrimCode: number, maxTrimCode: number): void {
        let newLen = this._length;
        while (newLen > 0) {
            const value = this._buffer[newLen - 1] ?? 0;
            if (value < minTrimCode || value > maxTrimCode) {
                break;
            }
            newLen--;
        }
        this._length = newLen;
    }

    private ensureCapacity(extra: number): void {
        if (this._length + extra > this._buffer.length) {
            const grown = new Uint8Array(Math.max(this._buffer.length * 2, this._length + extra));
            grown.set(this._buffer.subarray(0, this._length), 0);
            this._buffer = grown;
        }
    }
}

/** Extra-code stream that tracks a char count and an unprintable prefix length. */
class ExtraCodesStream extends ByteStream {
    private _numChars = 0;
    private _unprintablePrefixLen = 0;

    public constructor(length: number) {
        super(length);
    }

    public get numChars(): number {
        return this._numChars;
    }

    public incrementNumChars(inc: number): void {
        this._numChars += inc;
    }

    public get unprintablePrefixLen(): number {
        return this._unprintablePrefixLen;
    }

    public setUnprintablePrefixLen(len: number): void {
        this._unprintablePrefixLen = len;
    }

    public writeFill(count: number, value: number): void {
        for (let index = 0; index < count; index++) {
            this.writeByte(value);
        }
    }
}

export type JetCharType =
    | 'simple'
    | 'international'
    | 'unprintable'
    | 'unprintable-ext'
    | 'international-ext'
    | 'significant'
    | 'surrogate'
    | 'ignored';

export abstract class JetCharHandler {
    public abstract get type(): JetCharType;

    public getInlineBytes(c: number): Uint8Array | null {
        void c;
        return null;
    }

    public getExtraBytes(): Uint8Array | null {
        return null;
    }

    public getUnprintableBytes(): Uint8Array | null {
        return null;
    }

    public getExtraByteModifier(): number {
        return 0;
    }

    public getCrazyFlag(): number {
        return 0;
    }

    public isSignificantChar(): boolean {
        return false;
    }
}

class SimpleCharHandler extends JetCharHandler {
    private readonly _bytes: Uint8Array;

    public constructor(bytes: Uint8Array) {
        super();
        this._bytes = bytes;
    }

    public override get type(): JetCharType {
        return 'simple';
    }

    public override getInlineBytes(): Uint8Array {
        return this._bytes;
    }
}

class InternationalCharHandler extends JetCharHandler {
    private readonly _bytes: Uint8Array;
    private readonly _extraBytes: Uint8Array;

    public constructor(bytes: Uint8Array, extraBytes: Uint8Array) {
        super();
        this._bytes = bytes;
        this._extraBytes = extraBytes;
    }

    public override get type(): JetCharType {
        return 'international';
    }

    public override getInlineBytes(): Uint8Array {
        return this._bytes;
    }

    public override getExtraBytes(): Uint8Array {
        return this._extraBytes;
    }
}

class UnprintableCharHandler extends JetCharHandler {
    private readonly _unprintBytes: Uint8Array;

    public constructor(unprintBytes: Uint8Array) {
        super();
        this._unprintBytes = unprintBytes;
    }

    public override get type(): JetCharType {
        return 'unprintable';
    }

    public override getUnprintableBytes(): Uint8Array {
        return this._unprintBytes;
    }
}

class UnprintableExtCharHandler extends JetCharHandler {
    private readonly _extraByteMod: number;

    public constructor(extraByteMod: number) {
        super();
        this._extraByteMod = extraByteMod;
    }

    public override get type(): JetCharType {
        return 'unprintable-ext';
    }

    public override getExtraByteModifier(): number {
        return this._extraByteMod;
    }
}

class InternationalExtCharHandler extends JetCharHandler {
    private readonly _bytes: Uint8Array;
    private readonly _extraBytes: Uint8Array | null;
    private readonly _crazyFlag: number;

    public constructor(bytes: Uint8Array, extraBytes: Uint8Array | null, crazyFlag: number) {
        super();
        this._bytes = bytes;
        this._extraBytes = extraBytes;
        this._crazyFlag = crazyFlag;
    }

    public override get type(): JetCharType {
        return 'international-ext';
    }

    public override getInlineBytes(): Uint8Array {
        return this._bytes;
    }

    public override getExtraBytes(): Uint8Array | null {
        return this._extraBytes;
    }

    public override getCrazyFlag(): number {
        return this._crazyFlag;
    }
}

class SignificantCharHandler extends JetCharHandler {
    private readonly _bytes: Uint8Array;

    public constructor(bytes: Uint8Array) {
        super();
        this._bytes = bytes;
    }

    public override get type(): JetCharType {
        return 'significant';
    }

    public override getInlineBytes(): Uint8Array {
        return this._bytes;
    }

    public override isSignificantChar(): boolean {
        return true;
    }
}

class IgnoredCharHandlerClass extends JetCharHandler {
    public override get type(): JetCharType {
        return 'ignored';
    }
}

const IGNORED_CHAR_HANDLER = new IgnoredCharHandlerClass();

function toSurrogateInlineBytes(idxC: number): Uint8Array {
    const bytes = new Uint8Array(2);
    bytes[0] = (idxC >> 8) & 0xff;
    bytes[1] = idxC & 0xff;
    return bytes;
}

class SurrogateCharHandler extends JetCharHandler {
    private readonly _isHigh: boolean;

    public constructor(isHigh: boolean) {
        super();
        this._isHigh = isHigh;
    }

    public override get type(): JetCharType {
        return 'surrogate';
    }

    public override getExtraBytes(): Uint8Array {
        return new Uint8Array([SURROGATE_EXTRA_BYTE]);
    }

    public override getInlineBytes(c: number): Uint8Array {
        if (this._isHigh) {
            const idxC = c - 10238;
            return toSurrogateInlineBytes(idxC);
        }
        const charOffset = (c - 0xdc00) % 1024;
        let idxOffset: number;
        if (charOffset < 8) {
            idxOffset = 9992;
        } else if (charOffset < 8 + 254) {
            idxOffset = 9990;
        } else if (charOffset < 8 + 254 + 254) {
            idxOffset = 9988;
        } else if (charOffset < 8 + 254 + 254 + 254) {
            idxOffset = 9986;
        } else {
            idxOffset = 9984;
        }
        return toSurrogateInlineBytes(c - idxOffset);
    }
}

const HIGH_SURROGATE_HANDLER = new SurrogateCharHandler(true);
const LOW_SURROGATE_HANDLER = new SurrogateCharHandler(false);

function codesToBytes(codes: string, required: boolean): Uint8Array | null {
    if (codes.length === 0) {
        if (required) {
            throw new Error('empty code bytes');
        }
        return null;
    }
    let normalized = codes;
    if (normalized.length % 2 !== 0) {
        normalized = '0' + normalized;
    }
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = parseInt(normalized.substring(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function parseCodes(codeLine: string): JetCharHandler {
    const prefix = codeLine.substring(0, 1);
    const suffix = codeLine.length > 1 ? codeLine.substring(1) : '';
    const codeStrings = suffix.length > 0 ? suffix.split(',') : [];
    switch (prefix) {
        case 'S':
            if (codeStrings.length !== 1) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            return new SimpleCharHandler(codesToBytes(codeStrings[0] ?? '', true)!);
        case 'I':
            if (codeStrings.length !== 2) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            return new InternationalCharHandler(
                codesToBytes(codeStrings[0] ?? '', true)!,
                codesToBytes(codeStrings[1] ?? '', true)!,
            );
        case 'U':
            if (codeStrings.length !== 1) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            return new UnprintableCharHandler(codesToBytes(codeStrings[0] ?? '', true)!);
        case 'P': {
            if (codeStrings.length !== 1) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            const bytes = codesToBytes(codeStrings[0] ?? '', true)!;
            if (bytes.length !== 1) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            return new UnprintableExtCharHandler(bytes[0] ?? 0);
        }
        case 'Z': {
            if (codeStrings.length !== 3) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            const crazyFlag = codeStrings[2] === '1' ? CRAZY_CODE_1 : CRAZY_CODE_2;
            return new InternationalExtCharHandler(
                codesToBytes(codeStrings[0] ?? '', true)!,
                codesToBytes(codeStrings[1] ?? '', false),
                crazyFlag,
            );
        }
        case 'G':
            if (codeStrings.length !== 1) {
                throw new Error(`unexpected code strings ${codeStrings.join(',')}`);
            }
            return new SignificantCharHandler(codesToBytes(codeStrings[0] ?? '', true)!);
        case 'X':
            return IGNORED_CHAR_HANDLER;
        default:
            throw new Error(`unrecognized codes line: ${codeLine}`);
    }
}

function loadCodes(lines: readonly string[], firstChar: number, lastChar: number): JetCharHandler[] {
    const numCodes = lastChar - firstChar + 1;
    const values: JetCharHandler[] = new Array(numCodes);
    let lineIdx = 0;
    for (let c = firstChar; c <= lastChar; c++) {
        let handler: JetCharHandler;
        if (c >= 0xd800 && c <= 0xdbff) {
            handler = HIGH_SURROGATE_HANDLER;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            handler = LOW_SURROGATE_HANDLER;
        } else {
            handler = parseCodes(lines[lineIdx++] ?? '');
        }
        values[c - firstChar] = handler;
    }
    return values;
}

const CODES_VALUES = loadCodes(CODES_GEN_LEG, FIRST_CHAR, LAST_CHAR);
const EXT_CODES_VALUES = loadCodes(CODES_EXT_GEN_LEG, FIRST_EXT_CHAR, LAST_EXT_CHAR);

const GEN_CODES_VALUES = loadCodes(CODES_GEN, FIRST_CHAR, LAST_CHAR);
const GEN_EXT_CODES_VALUES = loadCodes(CODES_EXT_GEN, FIRST_EXT_CHAR, LAST_EXT_CHAR);

const GEN97_CODES_VALUES = loadCodes(CODES_GEN_97, FIRST_CHAR, LAST_CHAR);

/** mappings for the extended chars used by the General 97 sort order */
const EXT_MAPPINGS_97 = new Map<number, number>();
for (const line of MAPPINGS_EXT_GEN_97) {
    const [from, to] = line.split(',');
    if (from && to) {
        EXT_MAPPINGS_97.set(parseInt(from, 16), parseInt(to, 16));
    }
}

function asUnsignedChar(c: number): number {
    return c & 0xffff;
}

export class JetGeneralIndexCodes {
    public static readonly GenLegacy = new JetGeneralIndexCodes('legacy');
    public static readonly Gen = new JetGeneralIndexCodes('general');
    public static readonly Gen97 = new JetGeneralIndexCodes('general97');

    private readonly _variant: 'legacy' | 'general' | 'general97';

    private constructor(variant: 'legacy' | 'general' | 'general97') {
        this._variant = variant;
    }

    public getCharHandler(c: number): JetCharHandler {
        if (this._variant === 'general97') {
            if (c <= LAST_CHAR) {
                return GEN97_CODES_VALUES[c] ?? IGNORED_CHAR_HANDLER;
            }
            const mapped = EXT_MAPPINGS_97.get(c);
            if (mapped !== undefined) {
                return GEN97_CODES_VALUES[mapped] ?? IGNORED_CHAR_HANDLER;
            }
            return IGNORED_CHAR_HANDLER;
        }
        if (c <= LAST_CHAR) {
            return this._variant === 'general' ? GEN_CODES_VALUES[c] ?? IGNORED_CHAR_HANDLER : CODES_VALUES[c] ?? IGNORED_CHAR_HANDLER;
        }
        const extOffset = asUnsignedChar(c) - asUnsignedChar(FIRST_EXT_CHAR);
        return this._variant === 'general'
            ? GEN_EXT_CODES_VALUES[extOffset] ?? IGNORED_CHAR_HANDLER
            : EXT_CODES_VALUES[extOffset] ?? IGNORED_CHAR_HANDLER;
    }

    /**
     * Converts an index value for a text column into the entry value (based on
     * the Access per-character codes; port of WriteNonNullIndexTextValue).
     */
    public writeNonNullIndexTextValue(value: unknown, bout: ByteStream, isAscending: boolean): void {
        const str = toIndexCharSequence(value);

        const prevLength = bout.length;

        let extraCodes: ExtraCodesStream | null = null;
        let unprintableCodes: ByteStream | null = null;
        let crazyCodes: ByteStream | null = null;
        let charOffset = 0;
        for (let index = 0; index < str.length; index++) {
            const c = str.charCodeAt(index);
            const handler = this.getCharHandler(c);

            const curCharOffset = charOffset;
            const bytes = handler.getInlineBytes(c);
            if (bytes !== null) {
                bout.writeBytes(bytes);
                charOffset++;
            }

            if (handler.type === 'simple') {
                continue;
            }

            const extra = handler.getExtraBytes();
            const extraCodeModifier = handler.getExtraByteModifier();
            if (extra !== null || extraCodeModifier !== 0) {
                if (extraCodes === null) {
                    extraCodes = new ExtraCodesStream(str.length);
                }
                this.writeExtraCodes(curCharOffset, extra, extraCodeModifier, extraCodes);
            }

            const unprintable = handler.getUnprintableBytes();
            if (unprintable !== null) {
                if (unprintableCodes === null) {
                    unprintableCodes = new ByteStream();
                }
                this.writeUnprintableCodes(curCharOffset, unprintable, unprintableCodes, extraCodes);
            }

            const crazyFlag = handler.getCrazyFlag();
            if (crazyFlag !== 0) {
                if (crazyCodes === null) {
                    crazyCodes = new ByteStream();
                }
                crazyCodes.writeByte(crazyFlag);
            }
        }

        bout.writeByte(END_TEXT);

        const hasExtraCodes = trimExtraCodes(extraCodes, 0, INTERNATIONAL_EXTRA_PLACEHOLDER);
        const hasUnprintableCodes = unprintableCodes !== null;
        const hasCrazyCodes = crazyCodes !== null;
        if (hasExtraCodes || hasUnprintableCodes || hasCrazyCodes) {
            if (hasExtraCodes) {
                bout.writeBytes(extraCodes!.getBytes());
            }

            if (hasCrazyCodes || hasUnprintableCodes) {
                bout.writeByte(END_TEXT);
                bout.writeByte(END_TEXT);

                if (hasCrazyCodes) {
                    this.writeCrazyCodes(crazyCodes!, bout);
                    if (hasUnprintableCodes) {
                        bout.writeByte(CRAZY_CODES_UNPRINT_SUFFIX);
                    }
                }

                if (hasUnprintableCodes) {
                    bout.writeByte(END_TEXT);
                    bout.writeBytes(unprintableCodes!.getBytes());
                }
            }
        }

        if (!isAscending) {
            bout.writeByte(END_EXTRA_TEXT);
            flipBytes(bout.getBytes(), prevLength, bout.length - prevLength);
        }

        bout.writeByte(END_EXTRA_TEXT);
    }

    private writeExtraCodes(charOffset: number, bytes: Uint8Array | null, extraCodeModifier: number, extraCodes: ExtraCodesStream): void {
        const numChars = extraCodes.numChars;
        if (numChars < charOffset) {
            const fillChars = charOffset - numChars;
            extraCodes.writeFill(fillChars, INTERNATIONAL_EXTRA_PLACEHOLDER);
            extraCodes.incrementNumChars(fillChars);
        }

        if (bytes !== null) {
            extraCodes.writeBytes(bytes);
            extraCodes.incrementNumChars(1);
        } else {
            const lastIdx = extraCodes.length - 1;
            if (lastIdx >= 0) {
                const lastByte = extraCodes.getAt(lastIdx);
                extraCodes.setAt(lastIdx, lastByte + extraCodeModifier);
            } else {
                extraCodes.writeByte(extraCodeModifier);
                extraCodes.setUnprintablePrefixLen(1);
            }
        }
    }

    private writeUnprintableCodes(charOffset: number, bytes: Uint8Array, unprintableCodes: ByteStream, extraCodes: ExtraCodesStream | null): void {
        let unprintCharOffset = charOffset;
        if (extraCodes !== null) {
            unprintCharOffset = extraCodes.length + charOffset - extraCodes.numChars - extraCodes.unprintablePrefixLen;
        }

        const offset = UNPRINTABLE_COUNT_START + UNPRINTABLE_COUNT_MULTIPLIER * unprintCharOffset | UNPRINTABLE_OFFSET_FLAGS;
        unprintableCodes.writeByte((offset >> 8) & 0xff);
        unprintableCodes.writeByte(offset & 0xff);

        unprintableCodes.writeByte(UNPRINTABLE_MIDFIX);
        unprintableCodes.writeBytes(bytes);
    }

    private writeCrazyCodes(crazyCodes: ByteStream, bout: ByteStream): void {
        trimExtraCodes(crazyCodes, CRAZY_CODE_2, CRAZY_CODE_2);

        if (crazyCodes.length > 0) {
            let curByte = CRAZY_CODE_START;
            let idx = 0;
            for (let index = 0; index < crazyCodes.length; index++) {
                let nextByte = crazyCodes.getAt(index);
                nextByte = (nextByte << (2 - idx) * 2) & 0xff;
                curByte = (curByte | nextByte) & 0xff;

                idx++;
                if (idx === 3) {
                    bout.writeByte(curByte);
                    curByte = CRAZY_CODE_START;
                    idx = 0;
                }
            }
            if (idx > 0) {
                bout.writeByte(curByte);
            }
        }

        for (const value of CRAZY_CODES_SUFFIX) {
            bout.writeByte(value);
        }
    }
}

function trimExtraCodes(extraCodes: ByteStream | null, minTrimCode: number, maxTrimCode: number): boolean {
    if (extraCodes === null) {
        return false;
    }
    extraCodes.trimTrailing(minTrimCode, maxTrimCode);
    return extraCodes.length > 0;
}

function toIndexCharSequence(value: unknown): string {
    let str = String(value ?? '');
    if (str.length > MAX_TEXT_INDEX_CHAR_LENGTH) {
        str = str.substring(0, MAX_TEXT_INDEX_CHAR_LENGTH);
    }
    // trailing spaces are ignored for text index entries
    let len = str.length;
    if (len > 0 && str.charCodeAt(len - 1) === 0x20) {
        do {
            len--;
        } while (len > 0 && str.charCodeAt(len - 1) === 0x20);
        str = str.substring(0, len);
    }
    return str;
}

/** Resolves the index-codes variant for a text sort order. */
export function indexCodesFor(sortOrder: JetTextSortOrder | null | undefined): JetGeneralIndexCodes {
    if (sortOrder && sortOrder.equals(JetTextSortOrder.General)) {
        return JetGeneralIndexCodes.Gen;
    }
    if (sortOrder && sortOrder.equals(JetTextSortOrder.General97)) {
        return JetGeneralIndexCodes.Gen97;
    }
    // GeneralLegacy (default for Jet 4) plus Polish/Russian/Turkish/Ukrainian
    // all use the legacy encoding
    return JetGeneralIndexCodes.GenLegacy;
}
