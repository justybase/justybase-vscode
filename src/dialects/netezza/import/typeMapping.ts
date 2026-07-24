import type {
    DatabaseColumnTypeChooser,
    DatabaseImportDataType,
    DatabaseImportTypeMapper
} from '../../../contracts/database';
import { valueForcesTextImportType } from '../../../import/importTypeInferenceUtils';

export interface ColumnTypeChooserOptions {
    forceText?: boolean;
    inferBoolean?: boolean;
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

    private getType(strVal: string): NetezzaDataType {
        const currentDbType = this.currentType.dbType;
        const strLen = strVal.length;

        if (this.forceText || valueForcesTextImportType(strVal)) {
            return this.createTextType(strVal);
        }

        const strValNoSpace = strVal.replace(/\s/g, '');
        const strLenNoSpace = strValNoSpace.length;

        if (this.inferBoolean && /^(true|false)$/i.test(strValNoSpace)) {
            this.firstTime = false;
            return new NetezzaDataType('BOOLEAN');
        }

        if (
            currentDbType === 'BIGINT' &&
            /^\d+$/.test(strValNoSpace) &&
            strLenNoSpace > 0 &&
            strLenNoSpace < 15 &&
            (strValNoSpace === '0' || !strValNoSpace.startsWith('0'))
        ) {
            this.firstTime = false;
            return new NetezzaDataType('BIGINT');
        }

        const delim = this.decimalDelimInCsv === '.' ? '\\.' : this.decimalDelimInCsv;
        const decimalCnt = (strValNoSpace.match(new RegExp(`${delim}`, 'g')) || []).length;

        if (['BIGINT', 'NUMERIC'].includes(currentDbType) && decimalCnt <= 1) {
            const strValClean = strValNoSpace.replace(this.decimalDelimInCsv, '');

            if (
                /^\d+$/.test(strValClean) &&
                strLenNoSpace > 0 &&
                strLenNoSpace < 20 &&
                (!strValClean.startsWith('0') || decimalCnt > 0 || strValClean === '0')
            ) {
                this.firstTime = false;

                const parts = strValNoSpace.split(this.decimalDelimInCsv);
                const integerPart = parts[0] || '0';
                const decimalPart = parts[1] || '';

                const precision = integerPart.length + decimalPart.length;
                const scale = decimalPart.length;

                this.maxPrecision = Math.max(this.maxPrecision, precision);
                this.maxScale = Math.max(this.maxScale, scale);

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
