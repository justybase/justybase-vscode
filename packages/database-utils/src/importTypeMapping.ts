import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper
} from '@justybase/contracts';
import { valueForcesTextImportType, valueLooksLikePesel } from './importTypeInferenceUtils';
import {
    getFormattedImportNumberPrecision,
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
        const currentDbType = this.currentType.dbType;
        const strLen = strVal.length;

        if (this.forceText) {
            return this.createTextType(strVal);
        }

        // Lone dash cells (`-`/`–` for zero) never influence the inferred type;
        // they are resolved to 0/dash at formatting time.
        if (isDashZeroImportCell(strVal.trim())) {
            return this.currentType;
        }

        const trimmed = strVal.trim();
        const valueIsPesel = valueLooksLikePesel(trimmed);
        if (trimmed) {
            this.observePeselSample(valueIsPesel);
        }
        // PESEL-shaped values are identifiers: keep the column as text so
        // leading zeros survive. A PESEL while the TOP3 sample is still open,
        // or a sample where all three values validated, locks the column to
        // text; after a failed sample the normal rules apply.
        const peselTextColumn = this.peselColumnDetected
            || (valueIsPesel && !this.peselSamplingDone);
        if (peselTextColumn) {
            return this.createTextType(strVal);
        }

        if (valueForcesTextImportType(strVal)) {
            return this.createTextType(strVal);
        }

        const strValNoSpace = strVal.replace(/\s/g, '');

        if (this.inferBoolean && /^(true|false)$/i.test(strValNoSpace)) {
            this.firstTime = false;
            return new NetezzaDataType('BOOLEAN');
        }

        // Dotted dates are checked before numeric parsing: under a comma
        // decimal delimiter `17.06.2024` would otherwise lose its dots as
        // thousands separators and infer as an integer like `17062024`.
        if ((currentDbType === 'DATETIME' || this.firstTime) && (strVal.match(/\./g) || []).length >= 2) {
            const result = strVal.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
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
                            return new NetezzaDataType('DATETIME');
                        }
                    }
                } catch {
                    // Invalid datetime, continue.
                }
            }
        }

        const numericPrecision = ['BIGINT', 'NUMERIC'].includes(currentDbType)
            ? getFormattedImportNumberPrecision(strVal, this.decimalDelimInCsv)
            : null;
        if (numericPrecision) {
            const parsed = parseFormattedImportNumber(strVal, this.decimalDelimInCsv);
            const fractionLen = parsed?.fractionDigits.length ?? numericPrecision.scale;
            // Preserve leading zeros (`0123`, `0 123`): such values stay text
            // so the zeros are not lost by a numeric conversion.
            const rawLeading = strVal
                .replace(/^[\s\u00A0\u202F\u2009(+\-−–—$£€¥₹]+/, '')
                .replace(/[ \u00a0\u202F\u2009'’ʼ]/g, '');
            if (parsed && /^0\d/.test(rawLeading)) {
                return this.createTextType(strVal);
            }
            // Keep the historical length guard: overlong digit strings stay
            // text instead of overflowing NUMERIC precision.
            if (parsed && numericPrecision.precision <= 18) {
                this.firstTime = false;
                // Currency-marked values (`123 457 zł`, `£123,457`) are money:
                // infer NUMERIC even without a decimal part.
                if (
                    fractionLen === 0
                    && !parsed.wasCurrency
                    && currentDbType === 'BIGINT'
                    && parsed.integerDigits.length < 15
                ) {
                    return new NetezzaDataType('BIGINT');
                }

                this.maxPrecision = Math.max(this.maxPrecision, numericPrecision.precision);
                this.maxScale = Math.max(this.maxScale, numericPrecision.scale);

                const finalPrecision = Math.min(Math.max(this.maxPrecision, 16), 38);
                const finalScale = Math.min(this.maxScale, 18);

                return new NetezzaDataType('NUMERIC', finalPrecision, finalScale);
            }
        }

        if (
            (currentDbType === 'DATE' || this.firstTime) &&
            (strVal.match(/-/g) || []).length === 2 &&
            strLen >= 8 &&
            strLen <= 10
        ) {
            const parts = strVal.split('-');
            if (parts.length === 3 && parts.every(part => /^\d+$/.test(part))) {
                try {
                    const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    if (!isNaN(date.getTime())) {
                        this.firstTime = false;
                        return new NetezzaDataType('DATE');
                    }
                } catch {
                    // Invalid date, continue.
                }
            }
        }

        if (
            (currentDbType === 'DATETIME' || this.firstTime) &&
            (strVal.match(/-/g) || []).length === 2 &&
            strLen >= 12 &&
            strLen <= 20
        ) {
            const result = strVal.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\s|T](\d{2}):(\d{2})(:?(\d{2}))?$/);
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
                        return new NetezzaDataType('DATETIME');
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
