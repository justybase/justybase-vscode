import type { ResultColumn } from './state';

export type FilterConditionType =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'like'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'between';

export interface ResultFilterCondition {
  type: FilterConditionType;
  value: string;
  value2?: string;
}

export interface ResultConditionOptions {
  /** Treat an eight-digit integer as a YYYYMMDD date for legacy result columns. */
  readonly inferredDateInteger?: boolean;
}

export interface ResultConditionFilter {
  readonly _isConditionFilter: true;
  readonly conditions: readonly ResultFilterCondition[];
  readonly logic: 'and' | 'or';
}

export type ResultColumnFilterValue = readonly string[] | ResultConditionFilter | undefined;

export interface ResultColumnFilter {
  readonly columnIndex: number;
  readonly value: ResultColumnFilterValue;
}

export interface ResultFilterQuery {
  readonly globalFilter?: string;
  readonly columnFilters?: readonly ResultColumnFilter[];
}

export type AggregationFunction = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max' | 'stdev' | 'median';

export interface AggregationRequest {
  readonly columnIndex: number;
  readonly function: AggregationFunction;
  /** Decimal places used for non-terminating averages and standard deviation. */
  readonly precision?: number;
  /** Optional type metadata used to canonicalize numeric distinct values. */
  readonly dataType?: string;
  readonly scale?: number;
  /** Set when the column is numeric but its source type is inferred or unavailable. */
  readonly numeric?: boolean;
}

export interface AggregationValue {
  readonly columnIndex: number;
  readonly function: AggregationFunction;
  readonly count: number;
  /** Counts are numbers; numeric calculations stay exact strings when needed. */
  readonly value: number | string | null;
}

interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

const GROUPING_PATTERN = /[\s\u00a0\u202f,]/g;
const DEFAULT_DECIMAL_PRECISION = 10;
const MAX_DECIMAL_SCALE = 1_000;
const MAX_DECIMAL_DIGITS = 10_000;
const MAX_DISPLAY_PRECISION = 30;

function decimalPower(scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new RangeError(`Decimal scale must be an integer between 0 and ${MAX_DECIMAL_SCALE}.`);
  }
  return 10n ** BigInt(scale);
}

function boundedPrecision(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_DISPLAY_PRECISION, Math.max(0, Math.trunc(value)));
}

function normaliseDecimal(value: DecimalValue): DecimalValue {
  let coefficient = value.coefficient;
  let scale = Math.max(0, value.scale);
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function parseDecimal(value: unknown): DecimalValue | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? String(value) : typeof value === 'bigint' ? value.toString() : String(value);
  const compact = raw.replace(GROUPING_PATTERN, '');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(compact);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_SCALE) return null;
  const scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale) || scale < -MAX_DECIMAL_SCALE || scale > MAX_DECIMAL_SCALE) return null;
  if (match[2].length + fraction.length > MAX_DECIMAL_DIGITS) return null;
  const coefficient = sign * BigInt(`${match[2]}${fraction}`);
  if (scale < 0) return normaliseDecimal({ coefficient: coefficient * decimalPower(-scale), scale: 0 });
  return normaliseDecimal({ coefficient, scale });
}

function compareDecimal(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * decimalPower(scale - left.scale);
  const b = right.coefficient * decimalPower(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function addDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  return normaliseDecimal({
    coefficient: left.coefficient * decimalPower(scale - left.scale) + right.coefficient * decimalPower(scale - right.scale),
    scale,
  });
}

function decimalToString(value: DecimalValue): string {
  const normalised = normaliseDecimal(value);
  const negative = normalised.coefficient < 0n;
  const digits = (negative ? -normalised.coefficient : normalised.coefficient).toString();
  if (normalised.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(normalised.scale + 1, '0');
  const split = padded.length - normalised.scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

function roundDecimal(value: DecimalValue, scale: number): DecimalValue {
  const targetScale = Math.max(0, scale);
  if (value.scale <= targetScale) {
    return { coefficient: value.coefficient * decimalPower(targetScale - value.scale), scale: targetScale };
  }
  const divisor = decimalPower(value.scale - targetScale);
  let coefficient = value.coefficient / divisor;
  const remainder = value.coefficient < 0n ? -(value.coefficient % divisor) : value.coefficient % divisor;
  if (remainder * 2n >= divisor) coefficient += value.coefficient < 0n ? -1n : 1n;
  return { coefficient, scale: targetScale };
}

/** Formats an exact aggregate value without routing DECIMAL/BIGINT through Number. */
export function formatExactAggregationValue(
  value: number | string,
  hasDecimal: boolean,
  precision: number | null = null,
): string {
  const parsed = parseDecimal(value);
  if (!parsed) return String(value);
  const resolvedPrecision = precision !== null
    ? boundedPrecision(precision, hasDecimal ? 4 : 0)
    : hasDecimal ? 4 : 0;
  const rounded = roundDecimal(parsed, resolvedPrecision);
  const rendered = decimalToString(rounded);
  const parts = rendered.split('.');
  const integerPart = parts[0] ?? '0';
  const decimalPart = parts[1] ?? '';
  const paddedDecimal = resolvedPrecision > 0 ? decimalPart.padEnd(resolvedPrecision, '0') : '';
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return paddedDecimal.length > 0 ? `${formattedInteger}.${paddedDecimal}` : formattedInteger;
}

function divideDecimal(numerator: DecimalValue, denominator: bigint, precision: number): string {
  if (denominator === 0n) return '';
  const safePrecision = boundedPrecision(precision, DEFAULT_DECIMAL_PRECISION);
  const negative = (numerator.coefficient < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator.coefficient < 0n ? -numerator.coefficient : numerator.coefficient;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const effectiveDenominator = absoluteDenominator * decimalPower(numerator.scale);
  const scaled = absoluteNumerator * decimalPower(safePrecision);
  let quotient = scaled / effectiveDenominator;
  const remainder = scaled % effectiveDenominator;
  if (remainder * 2n >= effectiveDenominator) quotient += 1n;
  const result = decimalToString({ coefficient: quotient, scale: safePrecision });
  return negative && result !== '0' ? `-${result}` : result;
}

function formatSearchValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function searchText(value: string): { lower: string; compact: string } {
  const lower = value.toLowerCase();
  return { lower, compact: lower.replace(GROUPING_PATTERN, '') };
}

function containsSearch(value: string, term: string): boolean {
  const display = searchText(value);
  const search = searchText(term);
  return display.lower.includes(search.lower) || (search.compact.length > 0 && display.compact.includes(search.compact));
}

function startsSearch(value: string, term: string): boolean {
  const display = searchText(value);
  const search = searchText(term);
  return display.lower.startsWith(search.lower) || (search.compact.length > 0 && display.compact.startsWith(search.compact));
}

function endsSearch(value: string, term: string): boolean {
  const display = searchText(value);
  const search = searchText(term);
  return display.lower.endsWith(search.lower) || (search.compact.length > 0 && display.compact.endsWith(search.compact));
}

function isTemporalType(type: string | undefined): boolean {
  return /DATE|TIME|TIMESTAMP/i.test(type ?? '');
}

function parseDate(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : parsed;
}

function parseYyyymmdd(value: unknown): number | null {
  const digits = String(value).replace(GROUPING_PATTERN, '');
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(digits);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? timestamp
    : null;
}

function likeSearch(value: string, pattern: string): boolean {
  if (!pattern) return false;
  try {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(value);
  } catch {
    return false;
  }
}

function compareValues(
  value: unknown,
  filter: string,
  type: string | undefined,
  options: ResultConditionOptions = {},
): number | null {
  if (isTemporalType(type) || options.inferredDateInteger) {
    const parseTemporal = (candidate: unknown): number | null => {
      if (options.inferredDateInteger || /^date$/iu.test(type ?? '')) {
        return parseYyyymmdd(candidate) ?? parseDate(candidate);
      }
      return parseDate(candidate);
    };
    const left = parseTemporal(value);
    const right = parseTemporal(filter);
    if (left === null || right === null) return null;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftDecimal = parseDecimal(value);
  const rightDecimal = parseDecimal(filter);
  if (leftDecimal && rightDecimal) return compareDecimal(leftDecimal, rightDecimal);
  const left = formatSearchValue(value).toLowerCase();
  const right = filter.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Applies one condition with the same NULL and case rules as the desktop grid. */
export function evaluateResultCondition(
  value: unknown,
  condition: ResultFilterCondition,
  dataType?: string,
  options: ResultConditionOptions = {},
): boolean {
  const display = formatSearchValue(value);
  const isNull = display === 'NULL';
  const comparison = (operator: (result: number) => boolean): boolean => {
    const result = compareValues(value, condition.value, dataType, options);
    return result !== null && !isNull && operator(result);
  };

  switch (condition.type) {
    case 'contains': return !isNull && containsSearch(display, condition.value);
    case 'notContains': return isNull || !containsSearch(display, condition.value);
    case 'startsWith': return !isNull && startsSearch(display, condition.value);
    case 'endsWith': return !isNull && endsSearch(display, condition.value);
    case 'like': return !isNull && likeSearch(display, condition.value);
    case 'isEmpty': return isNull;
    case 'isNotEmpty': return !isNull;
    case 'equals': {
      const result = compareValues(value, condition.value, dataType, options);
      return result === 0 || (result === null && display.toLowerCase() === condition.value.toLowerCase());
    }
    case 'notEquals': {
      const result = compareValues(value, condition.value, dataType, options);
      return result !== 0 && (result !== null || display.toLowerCase() !== condition.value.toLowerCase());
    }
    case 'greaterThan': return comparison(result => result > 0);
    case 'greaterThanOrEqual': return comparison(result => result >= 0);
    case 'lessThan': return comparison(result => result < 0);
    case 'lessThanOrEqual': return comparison(result => result <= 0);
    case 'between': {
      const lower = compareValues(value, condition.value, dataType, options);
      const upper = compareValues(value, condition.value2 ?? '', dataType, options);
      return !isNull && lower !== null && upper !== null && lower >= 0 && upper <= 0;
    }
    default: return true;
  }
}

function matchesColumnFilter(value: unknown, filter: ResultColumnFilterValue, dataType?: string): boolean {
  if (!filter) return true;
  if (Array.isArray(filter)) {
    if (filter.length === 0) return true;
    return filter.includes(formatSearchValue(value));
  }
  if (!('conditions' in filter)) return true;
  const results = filter.conditions.map(condition => evaluateResultCondition(value, condition, dataType));
  return filter.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** Returns stable source-row indexes; this avoids copying large datasets. */
export function filterResultRowIndexes(
  rows: readonly unknown[][],
  columns: readonly ResultColumn[],
  query: ResultFilterQuery,
): number[] {
  const global = query.globalFilter?.trim().toLowerCase() ?? '';
  const filters = query.columnFilters ?? [];
  return rows.reduce<number[]>((indexes, row, rowIndex) => {
    if (global && !row.some(value => formatSearchValue(value).toLowerCase().includes(global))) return indexes;
    const matches = filters.every(filter => matchesColumnFilter(row[filter.columnIndex], filter.value, columns[filter.columnIndex]?.type));
    if (matches) indexes.push(rowIndex);
    return indexes;
  }, []);
}

export function filterResultRows(
  rows: readonly unknown[][],
  columns: readonly ResultColumn[],
  query: ResultFilterQuery,
): unknown[][] {
  return filterResultRowIndexes(rows, columns, query).map(index => rows[index]!.slice());
}

function numericValues(rows: readonly unknown[][], columnIndex: number): DecimalValue[] {
  return rows.flatMap(row => {
    const value = parseDecimal(row[columnIndex]);
    return value ? [value] : [];
  });
}

function aggregateNumeric(values: DecimalValue[], fn: AggregationFunction, precision: number): number | string | null {
  if (values.length === 0) return null;
  if (fn === 'stdev') return aggregateStandardDeviation(values, precision);
  if (fn === 'min' || fn === 'max') {
    return decimalToString(values.reduce((current, value) => {
      const comparison = compareDecimal(value, current);
      return fn === 'min' ? (comparison < 0 ? value : current) : (comparison > 0 ? value : current);
    }));
  }
  const sum = values.reduce(addDecimal);
  if (fn === 'sum') return decimalToString(sum);
  if (fn === 'avg') return divideDecimal(sum, BigInt(values.length), precision);
  const sorted = [...values].sort(compareDecimal);
  if (fn === 'median') {
    if (sorted.length % 2 === 1) return decimalToString(sorted[Math.floor(sorted.length / 2)]!);
    return divideDecimal(addDecimal(sorted[sorted.length / 2 - 1]!, sorted[sorted.length / 2]!), 2n, precision);
  }
  return null;
}

/** Uses bounded Welford arithmetic so variance cost stays linear in row count. */
function aggregateStandardDeviation(values: DecimalValue[], precision: number): string | null {
  let count = 0;
  let mean = 0;
  let sumSquaredDifferences = 0;

  for (const value of values) {
    const numericValue = Number(decimalToString(value));
    if (!Number.isFinite(numericValue)) return null;
    count += 1;
    const delta = numericValue - mean;
    mean += delta / count;
    const deltaAfterMean = numericValue - mean;
    sumSquaredDifferences += delta * deltaAfterMean;
    if (!Number.isFinite(mean) || !Number.isFinite(sumSquaredDifferences)) return null;
  }

  if (count === 0) return null;
  const variance = Math.max(0, sumSquaredDifferences / count);
  const standardDeviation = Math.sqrt(variance);
  if (!Number.isFinite(standardDeviation)) return null;
  const parsed = parseDecimal(standardDeviation);
  if (!parsed) return null;
  return decimalToString(roundDecimal(parsed, boundedPrecision(precision, DEFAULT_DECIMAL_PRECISION)));
}

function isNumericType(dataType: string | undefined): boolean {
  const baseType = (dataType ?? '').trim().toLowerCase().split(/[\s(]/u, 1)[0] ?? '';
  return /^(?:u?(?:tiny|small|medium|big|huge)?int(?:eger)?\d*|u?integer|(?:decimal|numeric|number|real|double|float|money)|serial\d*|bit\d*)$/u.test(baseType);
}

function canonicalDistinctValue(value: unknown, request: AggregationRequest, inferredNumeric: boolean): string {
  const numeric = request.numeric === true || inferredNumeric || isNumericType(request.dataType);
  if (!numeric) return `text:${formatSearchValue(value)}`;
  const parsed = parseDecimal(value);
  if (!parsed) return `text:${formatSearchValue(value)}`;
  const declaredScale = request.scale;
  const scale = declaredScale !== undefined
    && Number.isSafeInteger(declaredScale)
    && declaredScale >= 0
    && declaredScale <= MAX_DECIMAL_SCALE
    ? declaredScale
    : undefined;
  const canonical = scale === undefined ? parsed : roundDecimal(parsed, scale);
  return `numeric:${decimalToString(canonical)}`;
}

/** Calculates visible-row aggregates with exact decimal arithmetic and bounded variance math. */
export function aggregateResultRows(
  rows: readonly unknown[][],
  requests: readonly AggregationRequest[],
): AggregationValue[] {
  return requests.map(request => {
    const values = rows.map(row => row[request.columnIndex]);
    const nonNull = values.filter(value => value !== null && value !== undefined);
    if (request.function === 'count') return { columnIndex: request.columnIndex, function: request.function, count: nonNull.length, value: nonNull.length };
    if (request.function === 'countDistinct') {
      const inferredNumeric = request.numeric === undefined
        && request.dataType === undefined
        && nonNull.length > 0
        && nonNull.every(value => parseDecimal(value) !== null);
      const distinct = new Set(nonNull.map(value => canonicalDistinctValue(value, request, inferredNumeric)));
      return { columnIndex: request.columnIndex, function: request.function, count: nonNull.length, value: distinct.size };
    }
    const precision = boundedPrecision(request.precision ?? DEFAULT_DECIMAL_PRECISION, DEFAULT_DECIMAL_PRECISION);
    return {
      columnIndex: request.columnIndex,
      function: request.function,
      count: nonNull.length,
      value: aggregateNumeric(numericValues(rows, request.columnIndex), request.function, precision),
    };
  });
}

export { decimalToString, parseDecimal };
