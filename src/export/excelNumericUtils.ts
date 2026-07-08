const NUMERIC_TYPES = new Set([
    'INT8',
    'INT2',
    'INT4',
    'INT',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'BYTEINT',
    'NUMERIC',
    'DECIMAL',
    'NUMBER',
    'FIXED',
    'FLOAT',
    'FLOAT4',
    'FLOAT8',
    'REAL',
    'DOUBLE',
    'DOUBLE PRECISION',
    'DECFLOAT',
    'MONEY',
    'SMALLMONEY'
]);

const LOSSY_EXCEL_NUMERIC_TYPES = new Set([
  'FLOAT',
  'FLOAT4',
  'FLOAT8',
  'REAL',
  'DOUBLE',
  'DOUBLE PRECISION',
  'DECFLOAT'
]);

const NUMERIC_STRING_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function normalizeTypeName(type?: string): string | undefined {
    return type
        ?.trim()
        .replace(/\s+/g, ' ')
        .toUpperCase();
}

function getBaseType(type?: string): string | undefined {
    const normalized = normalizeTypeName(type);
    if (!normalized) {
        return undefined;
    }

    const parenIndex = normalized.indexOf('(');
    return (parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized).trim();
}

export function shouldConvertToExcelNumber(type?: string): boolean {
    const normalized = normalizeTypeName(type);
    if (!normalized) {
        return false;
    }

    return Array.from(NUMERIC_TYPES).some(baseType => normalized === baseType || normalized.startsWith(baseType + '('));
}

export function convertToExcelNumberIfNumericString(val: unknown, type?: string): unknown {
    if (typeof val === 'bigint') {
        if (type && shouldConvertToExcelNumber(type)) {
            if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
                return Number(val);
            }
        }
        return val;
    }
    if (typeof val !== 'string') {
        return val;
    }

    const trimmed = val.trim();
    if (trimmed.length === 0 || !NUMERIC_STRING_PATTERN.test(trimmed)) {
        return val;
    }

  const baseType = getBaseType(type);
  const allowLossyConversion = !!baseType && LOSSY_EXCEL_NUMERIC_TYPES.has(baseType);

  if (/^-?0\d+/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : val;
  }

  if (!allowLossyConversion) {
    if (trimmed.length > 15) {
      return val;
    }
  }

  const num = Number(trimmed);
  return Number.isFinite(num) ? num : val;
}

export function convertRowExcelNumericStrings(row: unknown[]): unknown[] {
    return row.map(value => convertToExcelNumberIfNumericString(value));
}
