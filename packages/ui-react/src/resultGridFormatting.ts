/**
 * Portable result-cell formatting shared by every product renderer.
 *
 * The VS Code Result Panel remains the behavioural reference. This module is
 * deliberately independent of React, VS Code and host persistence so that a
 * browser, Electron and a webview can render the same raw value identically.
 */

export type DataGridNumericKind = 'integer' | 'decimal';

export interface DataGridCellMetadata {
  readonly type?: string;
  readonly scale?: number;
  readonly inferredNumericKind?: DataGridNumericKind;
  readonly inferredDateInteger?: boolean;
}

export interface DataGridIntegerFormattingOptions {
  readonly useGrouping?: boolean;
  readonly groupSeparator?: string;
}

export interface DataGridDecimalFormattingOptions {
  readonly useGrouping?: boolean;
  readonly groupSeparator?: string;
  readonly decimalSeparator?: string;
  readonly scale?: number;
  readonly preserveTrailingZeros?: boolean;
  readonly roundingMode?: 'half-up' | 'half-even' | 'ceil' | 'floor' | 'truncate' | string;
}

export interface DataGridFormattingOptions {
  readonly integer?: DataGridIntegerFormattingOptions;
  readonly decimal?: DataGridDecimalFormattingOptions;
  /** Explicitly overrides the inferred/declaration-based numeric kind. */
  readonly numericKind?: DataGridNumericKind;
}

interface ParsedDecimalParts {
  readonly sign: '' | '-';
  readonly integerPart: string;
  readonly fractionalPart: string;
}

interface ParsedYyyymmddDate {
  readonly raw: string;
  readonly year: number;
  readonly month: string;
  readonly day: string;
}

interface RoundedDecimalParts {
  readonly integerPart: string;
  readonly fractionalPart: string;
}

const DEFAULT_INTEGER_FORMATTING: Required<DataGridIntegerFormattingOptions> = {
  useGrouping: true,
  groupSeparator: ' ',
};

const DEFAULT_DECIMAL_FORMATTING: Required<DataGridDecimalFormattingOptions> = {
  useGrouping: true,
  groupSeparator: ' ',
  decimalSeparator: '.',
  scale: 4,
  preserveTrailingZeros: true,
  roundingMode: 'half-up',
};

const INTEGER_TYPE_ALIASES = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'byteint',
  'serial', 'smallserial', 'bigserial', 'serial2', 'serial4', 'serial8',
  'int1', 'int2', 'int4', 'int8', 'int16', 'int32', 'int64',
  'utinyint', 'usmallint', 'uinteger', 'ubigint', 'hugeint', 'uhugeint',
  'uint8', 'uint16', 'uint32', 'uint64',
]);

const SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES = new Set(['numeric', 'decimal', 'dec', 'number', 'fixed']);

const DEFAULT_SCALE_DECIMAL_TYPE_ALIASES = new Set([
  'float', 'float4', 'float8', 'real', 'double', 'double precision',
  'binary_float', 'binary_double', 'single', 'single precision', 'decfloat',
]);

const ALWAYS_DECIMAL_TYPE_ALIASES = new Set(['money', 'smallmoney']);

const DECIMAL_TYPE_ALIASES = new Set([
  ...SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES,
  ...DEFAULT_SCALE_DECIMAL_TYPE_ALIASES,
  ...ALWAYS_DECIMAL_TYPE_ALIASES,
]);

const BINARY_TYPE_ALIASES = new Set([
  'binary', 'varbinary', 'longvarbinary', 'blob', 'tinyblob', 'mediumblob',
  'longblob', 'bytea', 'raw', 'image', 'ole', 'ole object', 'oid', 'byte',
]);

const YYYYMMDD_INTEGER_DATE_MIN = 10000101;
const YYYYMMDD_INTEGER_DATE_MAX = 99991231;
const YYYYMMDD_INTEGER_DATE_SAMPLE_LIMIT = 100;
const YYYYMMDD_INTEGER_DATE_MIN_MATCHES = 3;

function normalizeTypeName(type: string | undefined | null): string {
  return String(type || '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function extractBaseTypeName(type: string | undefined | null): string {
  const normalizedType = normalizeTypeName(type)
    .replace(/\[\]$/u, '')
    .replace(/\s+(?:unsigned|signed|zerofill)\b/gu, '')
    .replace(/\s+(?:with|without)\s+time\s+zone\b/gu, '')
    .trim();
  const parenIndex = normalizedType.indexOf('(');
  return (parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType).trim();
}

function normalizeScale(scale: number | undefined | null): number | undefined {
  if (scale === undefined || scale === null || !Number.isFinite(scale)) return undefined;
  return Math.max(0, Math.min(1_000, Math.floor(scale)));
}

function getNumericScale(type: string | undefined | null): number | undefined {
  const normalizedType = normalizeTypeName(type);
  const baseType = extractBaseTypeName(normalizedType);
  if (!SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) return undefined;
  const scaleMatch = /\(\s*(?:\*|\d+)\s*(?:,\s*(-?\d+)\s*)?\)/u.exec(normalizedType);
  if (!scaleMatch) return undefined;
  if (scaleMatch[1] === undefined) return 0;
  return normalizeScale(Number(scaleMatch[1]));
}

function isDeclaredIntegerType(type: string | undefined): boolean {
  return INTEGER_TYPE_ALIASES.has(extractBaseTypeName(type));
}

function resolveDeclaredNumericKind(type: string | undefined, scale?: number | null): DataGridNumericKind | undefined {
  const baseType = extractBaseTypeName(type);
  if (INTEGER_TYPE_ALIASES.has(baseType)) return 'integer';
  if (SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) {
    const resolvedScale = normalizeScale(scale) ?? getNumericScale(type);
    return resolvedScale === 0 ? 'integer' : 'decimal';
  }
  if (DECIMAL_TYPE_ALIASES.has(baseType)) return 'decimal';
  return undefined;
}

function usesDefaultDecimalScale(type: string | undefined | null): boolean {
  return DEFAULT_SCALE_DECIMAL_TYPE_ALIASES.has(extractBaseTypeName(type));
}

function sanitizeNumericString(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[-+]?\d+(?:\.\d+)?$/u.test(trimmed) ? trimmed : undefined;
}

function parseNumericString(value: unknown): ParsedDecimalParts | undefined {
  const raw = sanitizeNumericString(value);
  if (!raw) return undefined;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(raw);
  if (!match) return undefined;
  return {
    sign: match[1] === '-' ? '-' : '',
    integerPart: match[2]!.replace(/^0+(?=\d)/u, '') || '0',
    fractionalPart: match[3] || '',
  };
}

function addGroupSeparators(integerPart: string, separator: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

function hasNonZeroDigits(value: string): boolean {
  return /[1-9]/u.test(value || '');
}

function incrementDigitString(value: string): string {
  let carry = 1;
  const digits = value.split('');
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]) + carry;
    if (digit >= 10) {
      digits[index] = '0';
      carry = 1;
    } else {
      digits[index] = String(digit);
      carry = 0;
      break;
    }
  }
  if (carry > 0) digits.unshift('1');
  return digits.join('');
}

function shouldRoundHalfEven(nextDigit: string, remainder: string, lastKeptDigit: string): boolean {
  if (nextDigit > '5') return true;
  if (nextDigit < '5') return false;
  if (hasNonZeroDigits(remainder)) return true;
  return Number(lastKeptDigit || '0') % 2 === 1;
}

function roundDecimalParts(parsed: ParsedDecimalParts, scale: number, roundingMode: string): RoundedDecimalParts {
  const fractional = parsed.fractionalPart || '';
  const discarded = fractional.slice(scale);
  let integerPart = parsed.integerPart;
  let fractionalPart = fractional.slice(0, scale);
  if (discarded.length === 0) return { integerPart, fractionalPart };

  const nextDigit = discarded[0]!;
  const remainder = discarded.slice(1);
  const discardedHasValue = hasNonZeroDigits(discarded);
  let shouldRoundUp = false;
  switch (roundingMode) {
    case 'ceil': shouldRoundUp = parsed.sign !== '-' && discardedHasValue; break;
    case 'floor': shouldRoundUp = parsed.sign === '-' && discardedHasValue; break;
    case 'truncate': shouldRoundUp = false; break;
    case 'half-even': shouldRoundUp = shouldRoundHalfEven(nextDigit, remainder, (fractionalPart || integerPart).slice(-1)); break;
    case 'half-up':
    default: shouldRoundUp = nextDigit >= '5'; break;
  }

  if (shouldRoundUp) {
    const combined = incrementDigitString(`${integerPart}${fractionalPart}` || '0');
    const splitIndex = Math.max(0, combined.length - scale);
    integerPart = (scale > 0 ? combined.slice(0, splitIndex) : combined) || '0';
    fractionalPart = scale > 0 ? combined.slice(splitIndex).padStart(scale, '0') : '';
  }
  return { integerPart, fractionalPart };
}

function formatIntegerString(parsed: ParsedDecimalParts, options: DataGridIntegerFormattingOptions): string {
  const grouped = options.useGrouping
    ? addGroupSeparators(parsed.integerPart, options.groupSeparator || ' ')
    : parsed.integerPart;
  return `${parsed.sign}${grouped}`;
}

function formatDecimalString(
  parsed: ParsedDecimalParts,
  options: DataGridDecimalFormattingOptions,
  explicitScale: number | undefined,
  allowOptionsScaleFallback: boolean,
): string {
  const resolvedScale = explicitScale !== undefined
    ? explicitScale
    : (allowOptionsScaleFallback && Number.isFinite(options.scale) ? normalizeScale(options.scale) : undefined);
  if (resolvedScale === undefined) {
    const integerPart = options.useGrouping
      ? addGroupSeparators(parsed.integerPart, options.groupSeparator || ' ')
      : parsed.integerPart;
    let fractionalPart = parsed.fractionalPart || '';
    if (fractionalPart.length > 0 && !options.preserveTrailingZeros) fractionalPart = fractionalPart.replace(/0+$/u, '');
    const decimalSeparator = options.decimalSeparator || '.';
    return `${parsed.sign}${integerPart}${fractionalPart.length > 0 ? `${decimalSeparator}${fractionalPart}` : ''}`;
  }

  const rounded = roundDecimalParts(parsed, resolvedScale, options.roundingMode || 'half-up');
  const integerPart = options.useGrouping
    ? addGroupSeparators(rounded.integerPart, options.groupSeparator || ' ')
    : rounded.integerPart;
  let fractionalPart = rounded.fractionalPart;
  if (resolvedScale > 0 && options.preserveTrailingZeros) fractionalPart = fractionalPart.padEnd(resolvedScale, '0');
  else if (!options.preserveTrailingZeros) fractionalPart = fractionalPart.replace(/0+$/u, '');
  const decimalSeparator = options.decimalSeparator || '.';
  return `${parsed.sign}${integerPart}${fractionalPart.length > 0 ? `${decimalSeparator}${fractionalPart}` : ''}`;
}

function parseYyyymmddIntegerDate(value: unknown): ParsedYyyymmddDate | undefined {
  const raw = sanitizeNumericString(value);
  if (!raw || raw.startsWith('-') || raw.startsWith('+') || raw.includes('.')) return undefined;
  if (!/^\d{8}$/u.test(raw)) return undefined;
  const numericValue = Number(raw);
  if (!Number.isFinite(numericValue) || numericValue < YYYYMMDD_INTEGER_DATE_MIN || numericValue > YYYYMMDD_INTEGER_DATE_MAX) return undefined;
  const year = Number(raw.slice(0, 4));
  const monthNumber = Number(raw.slice(4, 6));
  const dayNumber = Number(raw.slice(6, 8));
  const parsedDate = new Date(Date.UTC(year, monthNumber - 1, dayNumber));
  if (
    parsedDate.getUTCFullYear() !== year
    || parsedDate.getUTCMonth() !== monthNumber - 1
    || parsedDate.getUTCDate() !== dayNumber
  ) return undefined;
  return { raw, year, month: String(monthNumber).padStart(2, '0'), day: String(dayNumber).padStart(2, '0') };
}

function formatParsedYyyymmddIntegerDate(parsed: ParsedYyyymmddDate | undefined): string | undefined {
  return parsed ? `${parsed.year} ${parsed.month} ${parsed.day}` : undefined;
}

function inferNumericKind(values: readonly unknown[]): DataGridNumericKind | undefined {
  let sawDecimal = false;
  let sawInteger = false;
  for (const value of values.slice(0, 100)) {
    const parsed = parseNumericString(value);
    if (!parsed) continue;
    if (parsed.fractionalPart.length > 0) sawDecimal = true;
    else sawInteger = true;
  }
  return sawDecimal ? 'decimal' : sawInteger ? 'integer' : undefined;
}

/** Adds the same value-derived metadata that the canonical grid prepares. */
export function inferDataGridColumnMetadata(
  metadata: DataGridCellMetadata,
  values: readonly unknown[],
): DataGridCellMetadata {
  const next: DataGridCellMetadata = { ...metadata };
  if (!metadata.type && metadata.inferredNumericKind === undefined) {
    const numericKind = inferNumericKind(values);
    if (numericKind) return { ...next, inferredNumericKind: numericKind, scale: metadata.scale ?? (numericKind === 'decimal' ? 4 : undefined) };
  }
  if (metadata.inferredDateInteger === undefined && isDeclaredIntegerType(metadata.type)) {
    let inspected = 0;
    let valid = true;
    for (const value of values.slice(0, YYYYMMDD_INTEGER_DATE_SAMPLE_LIMIT)) {
      if (value === null || value === undefined || value === '') continue;
      inspected += 1;
      if (!parseYyyymmddIntegerDate(value)) {
        valid = false;
        break;
      }
    }
    if (valid && inspected >= YYYYMMDD_INTEGER_DATE_MIN_MATCHES) return { ...next, inferredDateInteger: true };
  }
  return next;
}

export function isDataGridBinaryType(type: string | undefined | null): boolean {
  return BINARY_TYPE_ALIASES.has(extractBaseTypeName(type));
}

export function isDataGridIntegerType(type: string | undefined): boolean {
  return isDeclaredIntegerType(type);
}

export function isDataGridNumericColumn(metadata: DataGridCellMetadata): boolean {
  return resolveDeclaredNumericKind(metadata.type, metadata.scale) !== undefined || metadata.inferredNumericKind !== undefined;
}

export function isDataGridTemporalColumn(metadata: DataGridCellMetadata): boolean {
  const normalizedType = normalizeTypeName(metadata.type);
  return metadata.inferredDateInteger === true
    || normalizedType.includes('date')
    || normalizedType.includes('time');
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(1)} KB`;
  return `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDataGridBinaryPlaceholder(value: unknown, type?: string | null): string {
  const label = extractBaseTypeName(type) === 'ole' ? 'OLE Object' : 'BLOB';
  if (typeof value !== 'string' || value.length === 0) return `[${label}]`;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteCount = Math.max(0, Math.floor((value.length * 3) / 4) - padding);
  return `[${label} · ${formatBytes(byteCount)}]`;
}

function resolveNumericKind(
  metadata: DataGridCellMetadata,
  value: unknown,
  formatting: DataGridFormattingOptions,
): DataGridNumericKind | undefined {
  const declaredKind = resolveDeclaredNumericKind(metadata.type, metadata.scale);
  if (declaredKind !== undefined) return formatting.numericKind ?? declaredKind;
  if (formatting.numericKind !== undefined) return formatting.numericKind;
  if (metadata.inferredNumericKind !== undefined) return metadata.inferredNumericKind;
  if (typeof value === 'number' || typeof value === 'bigint') return 'integer';
  return undefined;
}

function resolveDisplayDecimalScale(
  type: string | undefined,
  scale: number | undefined,
  defaultScale: number | undefined,
): number | undefined {
  const fromMetadata = normalizeScale(scale) ?? getNumericScale(type);
  if (usesDefaultDecimalScale(type)) {
    if (fromMetadata === 0) return defaultScale;
    if (fromMetadata === undefined) return undefined;
    return fromMetadata;
  }
  return fromMetadata ?? defaultScale;
}

function formatNumericValue(
  value: unknown,
  metadata: DataGridCellMetadata,
  formatting: DataGridFormattingOptions,
): string {
  const parsed = parseNumericString(value);
  if (!parsed) return String(value);
  const integerOptions = { ...DEFAULT_INTEGER_FORMATTING, ...(formatting.integer || {}) };
  const decimalOptions = { ...DEFAULT_DECIMAL_FORMATTING, ...(formatting.decimal || {}) };
  const numericKind = resolveNumericKind(metadata, value, formatting);
  if (numericKind === 'integer') return formatIntegerString(parsed, integerOptions);
  if (numericKind === 'decimal') {
    const decimalScale = resolveDisplayDecimalScale(metadata.type, metadata.scale, decimalOptions.scale);
    const allowOptionsScaleFallback = decimalScale !== undefined || !usesDefaultDecimalScale(metadata.type);
    return formatDecimalString(parsed, decimalOptions, decimalScale, allowOptionsScaleFallback);
  }
  return String(value);
}

function formatDateValue(value: Date, type?: string): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  const lowerType = normalizeTypeName(type);
  if (lowerType === 'date') return `${year}-${month}-${day}`;
  if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType.includes('time')) {
    const hours = String(value.getUTCHours()).padStart(2, '0');
    const minutes = String(value.getUTCMinutes()).padStart(2, '0');
    const seconds = String(value.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
  try {
    return value.toISOString().replace('T', ' ').substring(0, 19);
  } catch {
    return String(value);
  }
}

/** Canonical formatter without the VS Code-only formatting preference store. */
export function formatCanonicalDataGridCellValue(
  value: unknown,
  metadata: DataGridCellMetadata = {},
  formatting: DataGridFormattingOptions = {},
): string | null {
  if (value === null || value === undefined) return null;
  const type = metadata.type;
  const lowerType = normalizeTypeName(type);
  const numericScale = normalizeScale(metadata.scale) ?? getNumericScale(type);

  if (isDataGridBinaryType(type)) {
    if (typeof value !== 'number' && typeof value !== 'bigint') return formatDataGridBinaryPlaceholder(value, type);
    return formatNumericValue(value, { ...metadata, type: undefined, scale: undefined }, formatting);
  }

  if (metadata.inferredDateInteger) {
    const inferredDateDisplay = formatParsedYyyymmddIntegerDate(parseYyyymmddIntegerDate(value));
    if (inferredDateDisplay) return inferredDateDisplay;
  }

  if (isDataGridNumericColumn({ ...metadata, scale: numericScale })) return formatNumericValue(value, { ...metadata, scale: numericScale }, formatting);

  if (value instanceof Date) return formatDateValue(value, type);

  if (typeof value === 'number' && lowerType === 'date' && value > 19000000 && value < 21000000) {
    const date = String(value);
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }

  if (typeof value === 'object') {
    const stringValue = String(value);
    if (stringValue !== '[object Object]') return stringValue;
    if ('hours' in value || 'minutes' in value || 'seconds' in value) {
      const timeValue = value as { hours?: unknown; minutes?: unknown; seconds?: unknown };
      return `${String(timeValue.hours ?? 0).padStart(2, '0')}:${String(timeValue.minutes ?? 0).padStart(2, '0')}:${String(timeValue.seconds ?? 0).padStart(2, '0')}`;
    }
  }

  return String(value);
}

/** Formats the value exactly as it appears in the shared React grid. */
export function formatDataGridCellValue(
  value: unknown,
  type?: string,
  metadata: Omit<DataGridCellMetadata, 'type'> & { readonly type?: string } = {},
): string {
  const cellMetadata: DataGridCellMetadata = { ...metadata, type: type ?? metadata.type };
  if (value === null || value === undefined) return 'NULL';
  if (cellMetadata.type !== undefined && /BOOL/u.test(cellMetadata.type.toUpperCase())) {
    const isTrue = value === true || value === 1 || value === '1'
      || (typeof value === 'string' && ['t', 'true', 'yes'].includes(value.trim().toLowerCase()));
    return isTrue ? '✓ true' : '✗ false';
  }
  return formatCanonicalDataGridCellValue(value, cellMetadata) ?? 'NULL';
}
