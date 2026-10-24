import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper
} from '@justybase/contracts';
import { valueForcesTextImportType, valueLooksLikePesel } from './importTypeInferenceUtils';
import {
    isDashZeroImportCell,
    parseFormattedImportNumber,
} from './importNumberParsing';

export interface ColumnTypeChooserOptions {
    forceText?: boolean;
    inferBoolean?: boolean;
}

/**
 * How many leading non-empty values participate in PESEL detection.
 * When all of them validate as PESEL the column is numeric — even when
 * values carry leading zeros, which would otherwise force text.
 */
const PESEL_VALUE_SAMPLE_SIZE = 3;

/** Trim only when the cell actually has edge whitespace (avoids re-allocating). */
function isImportTrimWhitespace(code: number): boolean {
    return code === 32
        || (code >= 9 && code <= 13)
        || code === 0xa0
        || code === 0x1680
        || (code >= 0x2000 && code <= 0x200b)
        || code === 0x2028
        || code === 0x2029
        || code === 0x202f
        || code === 0x205f
        || code === 0x3000
        || code === 0xfeff;
}

function trimImportCell(value: string): string {
    const length = value.length;
    if (length === 0) {
        return value;
    }
    if (
        !isImportTrimWhitespace(value.charCodeAt(0))
        && !isImportTrimWhitespace(value.charCodeAt(length - 1))
    ) {
        return value;
    }
    return value.trim();
}

function hasImportCellWhitespace(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (isImportTrimWhitespace(value.charCodeAt(index))) {
            return true;
        }
    }
    return false;
}

/** True when the value has at least two occurrences of `character`. */
function hasRepeatedCharacter(value: string, character: string): boolean {
    const first = value.indexOf(character);
    return first >= 0 && value.indexOf(character, first + 1) >= 0;
}

/** True when the value contains exactly two occurrences of `character`. */
function hasExactlyTwoCharacters(value: string, character: string): boolean {
    const first = value.indexOf(character);
    if (first < 0) {
        return false;
    }
    const second = value.indexOf(character, first + 1);
    if (second < 0) {
        return false;
    }
    return value.indexOf(character, second + 1) < 0;
}

/**
 * Matches a value that starts with a zero digit after any sign/currency
 * prefix, e.g. `0123`, `0 123`, `$0 123`.
 */
const LEADING_ZERO_NUMBER_PATTERN = /^[\s\u00A0\u202F\u2009(+\-−–—$£€¥₹]*0[\s\u00A0\u202F\u2009'’ʼ]*\d/;

/** `YYYY-MM-DD` with fixed digit positions. */
function isPlainIsoDate(value: string): boolean {
    if (value.length !== 10) {
        return false;
    }
    for (let index = 0; index < 10; index += 1) {
        if (index === 4 || index === 7) {
            if (value.charCodeAt(index) !== 45) {
                return false;
            }
            continue;
        }
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) {
            return false;
        }
    }
    return true;
}

/** `YYYY-MM-DD HH:MM[:SS]` / `YYYY-MM-DDTHH:MM[:SS]` with fixed positions. */
function isPlainIsoDateTime(value: string): boolean {
    const length = value.length;
    if (length !== 16 && length !== 19) {
        return false;
    }
    for (let index = 0; index < length; index += 1) {
        if (index === 4 || index === 7) {
            if (value.charCodeAt(index) !== 45) {
                return false;
            }
            continue;
        }
        if (index === 10) {
            const separator = value.charCodeAt(index);
            if (separator !== 32 && separator !== 84 && separator !== 124) {
                return false;
            }
            continue;
        }
        if (index === 13) {
            if (value.charCodeAt(index) !== 58) {
                return false;
            }
            continue;
        }
        if (length === 19 && index === 16) {
            if (value.charCodeAt(index) !== 58) {
                return false;
            }
            continue;
        }
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) {
            return false;
        }
    }
    return true;
}

/** Plain `[-+]?digits` with no separators, currency or exponent. */
function plainIntegerDigitCount(value: string): number {
    const length = value.length;
    if (length === 0) {
        return 0;
    }
    let index = 0;
    const first = value.charCodeAt(0);
    if (first === 43 || first === 45 || first === 0x2212 || first === 0x2013 || first === 0x2014) {
        index = 1;
    }
    if (index >= length) {
        return 0;
    }
    for (let cursor = index; cursor < length; cursor += 1) {
        const code = value.charCodeAt(cursor);
        if (code < 48 || code > 57) {
            return 0;
        }
    }
    return length - index;
}

export class NetezzaDataType implements DatabaseImportDataType {
    constructor(
        public dbType: string,
        public precision?: number,
        public scale?: number,
        public length?: number
    ) { }

    toString(): string {
        if (['BIGINT', 'DATE', 'DATETIME', 'BOOLEAN'].includes(this.dbType)) {
            return this.dbType;
        }
        if (this.dbType === 'NUMERIC') {
            return `${this.dbType}(${this.precision},${this.scale})`;
        }
        if (this.dbType === 'NVARCHAR') {
            return `${this.dbType}(${this.length})`;
        }
        return 'NVARCHAR(255)';
    }
}

export class ColumnTypeChooser implements DatabaseColumnTypeChooser {
    currentType: NetezzaDataType;
    private decimalDelimInCsv: string = '.';
    private firstTime: boolean = true;
    private maxPrecision: number = 0;
    private maxScale: number = 0;
    private readonly forceText: boolean;
    private readonly inferBoolean: boolean;
    private peselSamplesSeen = 0;
    private peselSamplingDone = false;
    private peselColumnDetected = false;

    constructor(decimalDelimiter: string = '.', options?: ColumnTypeChooserOptions) {
        this.forceText = options?.forceText === true;
        this.inferBoolean = options?.inferBoolean === true;
        this.currentType = this.forceText
            ? new NetezzaDataType('NVARCHAR', undefined, undefined, 20)
            : new NetezzaDataType('BIGINT');
        this.decimalDelimInCsv = decimalDelimiter;
    }

    getMaxScale(): number {
        return this.maxScale;
    }

    getMaxPrecision(): number {
        return this.maxPrecision;
    }

    private createTextType(strVal: string): NetezzaDataType {
        const strLen = strVal.length;
        let tmpLen = Math.max(strLen + 5, 20);
        if (this.currentType.length !== undefined && tmpLen < this.currentType.length) {
            tmpLen = this.currentType.length;
        }

        this.firstTime = false;
        if (this.currentType.dbType === 'NVARCHAR' && this.currentType.length === tmpLen) {
            return this.currentType;
        }
        return new NetezzaDataType('NVARCHAR', undefined, undefined, tmpLen);
    }

    /**
     * Sample up to {@link PESEL_VALUE_SAMPLE_SIZE} leading values. When all of
     * them validate as PESEL the column is an identifier and must stay text so
     * leading zeros survive the import. Detection is value-based; the column
     * header is irrelevant.
     */
    private observePeselSample(valueIsPesel: boolean): void {
        if (this.peselSamplingDone) {
            return;
        }

        this.peselSamplesSeen += 1;
        if (!valueIsPesel) {
            this.peselSamplingDone = true;
            this.peselColumnDetected = false;
            return;
        }
        if (this.peselSamplesSeen >= PESEL_VALUE_SAMPLE_SIZE) {
            this.peselSamplingDone = true;
            this.peselColumnDetected = true;
        }
    }

    private getType(strVal: string): NetezzaDataType {
        if (this.forceText) {
            return this.createTextType(strVal);
        }

        const trimmed = trimImportCell(strVal);
        const trimmedLength = trimmed.length;

        // Lone dash cells (`-`/`–` for zero) never influence the inferred type;
        // they are resolved to 0/dash at formatting time.
        if (trimmedLength <= 1 && isDashZeroImportCell(trimmed)) {
            return this.currentType;
        }

        // PESEL sampling only runs for the first few values of a column.
        let valueIsPesel = false;
        if (!this.peselSamplingDone && trimmedLength > 0) {
            valueIsPesel = valueLooksLikePesel(trimmed);
            this.observePeselSample(valueIsPesel);
        }
        // PESEL-shaped values are identifiers: keep the column as text so
        // leading zeros survive. A PESEL while the TOP3 sample is still open,
        // or a sample where all three values validated, locks the column to
        // text; after a failed sample the normal rules apply.
        if (this.peselColumnDetected || (valueIsPesel && !this.peselSamplingDone)) {
            return this.createTextType(strVal);
        }

        // Leading-zero values (`0123`, `0 123`) are identifiers, not numbers.
        if (trimmedLength > 1 && trimmed.charCodeAt(0) === 48 && valueForcesTextImportType(trimmed)) {
            return this.createTextType(strVal);
        }

        if (this.inferBoolean && trimmedLength >= 4 && trimmedLength <= 10) {
            const firstCode = trimmed.charCodeAt(0) | 0x20;
            if (firstCode === 0x74 || firstCode === 0x66) {
                const compact = hasImportCellWhitespace(trimmed)
                    ? trimmed.replace(/\s/g, '')
                    : trimmed;
                if (/^(true|false)$/i.test(compact)) {
                    this.firstTime = false;
                    return this.currentType.dbType === 'BOOLEAN'
                        ? this.currentType
                        : new NetezzaDataType('BOOLEAN');
                }
            }
        }

        const currentDbType = this.currentType.dbType;

        // Once a column is text nothing can narrow it again: the date and
        // number branches are all gated on a non-text current type, so the
        // only remaining work is widening the NVARCHAR length.
        if (currentDbType === 'NVARCHAR') {
            return this.createTextType(strVal);
        }

        // Dotted dates are checked before numeric parsing: under a comma
        // decimal delimiter `17.06.2024` would otherwise lose its dots as
        // thousands separators and infer as an integer like `17062024`.
        if (
            (currentDbType === 'DATETIME' || this.firstTime)
            && trimmedLength >= 8
            && hasRepeatedCharacter(trimmed, '.')
        ) {
            const result = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
            if (result) {
                try {
                    const day = parseInt(result[1]);
                    const month = parseInt(result[2]) - 1;
                    const year = parseInt(result[3]);
                    const hour = result[4] ? parseInt(result[4]) : 0;
                    const min = result[5] ? parseInt(result[5]) : 0;
                    const sec = result[6] ? parseInt(result[6]) : 0;

                    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
                        const date = new Date(year, month, day, hour, min, sec);
                        if (
                            !isNaN(date.getTime()) &&
                            date.getFullYear() === year &&
                            date.getMonth() === month &&
                            date.getDate() === day
                        ) {
                            this.firstTime = false;
                            return currentDbType === 'DATETIME'
                                ? this.currentType
                                : new NetezzaDataType('DATETIME');
                        }
                    }
                } catch {
                    // Invalid datetime, continue.
                }
            }
        }

        if (currentDbType === 'BIGINT' || currentDbType === 'NUMERIC') {
            // Fast path for plain integers: no separators, currency or
            // exponent, so the formatted-number parser is not needed.
            if (currentDbType === 'BIGINT') {
                const digits = plainIntegerDigitCount(trimmed);
                if (digits > 0 && digits < 15 && !(digits > 1 && trimmed.charCodeAt(trimmed.length - digits) === 48)) {
                    this.firstTime = false;
                    return this.currentType;
                }
            }

            const parsed = parseFormattedImportNumber(trimmed, this.decimalDelimInCsv);
            if (parsed) {
                const precision = parsed.integerDigits.length + parsed.fractionDigits.length;
                const scale = parsed.fractionDigits.length;
                // Preserve leading zeros (`0123`, `0 123`): such values stay
                // text so the zeros are not lost by a numeric conversion.
                if (LEADING_ZERO_NUMBER_PATTERN.test(trimmed)) {
                    return this.createTextType(strVal);
                }
                // Keep the historical length guard: overlong digit strings stay
                // text instead of overflowing NUMERIC precision.
                if (precision <= 18) {
                    this.firstTime = false;
                    // Currency-marked values (`123 457 zł`, `£123,457`) are money:
                    // infer NUMERIC even without a decimal part.
                    if (
                        scale === 0
                        && !parsed.wasCurrency
                        && currentDbType === 'BIGINT'
                        && parsed.integerDigits.length < 15
                    ) {
                        return this.currentType;
                    }

                    this.maxPrecision = Math.max(this.maxPrecision, precision);
                    this.maxScale = Math.max(this.maxScale, scale);

                    const finalPrecision = Math.min(Math.max(this.maxPrecision, 16), 38);
                    const finalScale = Math.min(this.maxScale, 18);

                    if (
                        this.currentType.dbType === 'NUMERIC'
                        && this.currentType.precision === finalPrecision
                        && this.currentType.scale === finalScale
                    ) {
                        return this.currentType;
                    }
                    return new NetezzaDataType('NUMERIC', finalPrecision, finalScale);
                }
            }
        }

        if (
            (currentDbType === 'DATE' || this.firstTime)
            && trimmedLength >= 8
            && trimmedLength <= 10
            && hasExactlyTwoCharacters(trimmed, '-')
        ) {
            if (currentDbType === 'DATE' && isPlainIsoDate(trimmed)) {
                this.firstTime = false;
                return this.currentType;
            }
            const parts = trimmed.split('-');
            if (parts.length === 3 && parts.every(part => /^\d+$/.test(part))) {
                try {
                    const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    if (!isNaN(date.getTime())) {
                        this.firstTime = false;
                        return currentDbType === 'DATE'
                            ? this.currentType
                            : new NetezzaDataType('DATE');
                    }
                } catch {
                    // Invalid date, continue.
                }
            }
        }

        if (
            (currentDbType === 'DATETIME' || this.firstTime)
            && trimmedLength >= 12
            && trimmedLength <= 20
            && hasExactlyTwoCharacters(trimmed, '-')
        ) {
            if (currentDbType === 'DATETIME' && isPlainIsoDateTime(trimmed)) {
                this.firstTime = false;
                return this.currentType;
            }
            const result = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\s|T](\d{2}):(\d{2})(:?(\d{2}))?$/);
            if (result) {
                try {
                    const sec = result[7] ? parseInt(result[7]) : 0;
                    const date = new Date(
                        parseInt(result[1]),
                        parseInt(result[2]) - 1,
                        parseInt(result[3]),
                        parseInt(result[4]),
                        parseInt(result[5]),
                        sec
                    );
                    if (!isNaN(date.getTime())) {
                        this.firstTime = false;
                        return currentDbType === 'DATETIME'
                            ? this.currentType
                            : new NetezzaDataType('DATETIME');
                    }
                } catch {
                    // Invalid datetime, continue.
                }
            }
        }

        return this.createTextType(strVal);
    }

    refreshCurrentType(strVal: string): NetezzaDataType {
        this.currentType = this.getType(strVal);
        return this.currentType;
    }
}

export const netezzaImportTypeMapper: DatabaseImportTypeMapper = {
    createDataType(
        dbType: string,
        precision?: number,
        scale?: number,
        length?: number
    ): DatabaseImportDataType {
        return new NetezzaDataType(dbType, precision, scale, length);
    },
    createColumnTypeChooser(decimalDelimiter?: string): DatabaseColumnTypeChooser {
        return new ColumnTypeChooser(decimalDelimiter);
    }
};
