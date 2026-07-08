import { ColumnDefinition } from "../types";
import {
  ColumnFormattingOverride,
  DEFAULT_RESULT_FORMATTING_SETTINGS,
  ResultFormattingPayload,
  ResultFormattingSettings,
} from "./resultFormattingTypes";

const INTEGER_TYPE_ALIASES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "byteint",
  "serial",
  "smallserial",
  "bigserial",
  "serial2",
  "serial4",
  "serial8",
  "int1",
  "int2",
  "int4",
  "int8",
  "int16",
  "int32",
  "int64",
  "utinyint",
  "usmallint",
  "uinteger",
  "ubigint",
  "hugeint",
  "uhugeint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
]);

const SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES = new Set([
  "numeric",
  "decimal",
  "dec",
  "number",
  "fixed",
]);

const DEFAULT_SCALE_DECIMAL_TYPE_ALIASES = new Set([
  "float",
  "float4",
  "float8",
  "real",
  "double",
  "double precision",
  "binary_float",
  "binary_double",
  "single",
  "single precision",
  "decfloat",
]);

const ALWAYS_DECIMAL_TYPE_ALIASES = new Set(["money", "smallmoney"]);

const DECIMAL_TYPE_ALIASES = new Set([
  ...SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES,
  ...DEFAULT_SCALE_DECIMAL_TYPE_ALIASES,
  ...ALWAYS_DECIMAL_TYPE_ALIASES,
]);

function mergeSettings(
  base: ResultFormattingSettings,
  override?: Partial<ResultFormattingSettings>,
): ResultFormattingSettings {
  if (!override) {
    return {
      integer: { ...base.integer },
      decimal: { ...base.decimal },
      useFormattedValuesForExport: base.useFormattedValuesForExport,
    };
  }

  return {
    integer: { ...base.integer, ...(override.integer || {}) },
    decimal: { ...base.decimal, ...(override.decimal || {}) },
    useFormattedValuesForExport:
      override.useFormattedValuesForExport ?? base.useFormattedValuesForExport,
  };
}

function normalizeTypeName(type?: string): string {
  return String(type || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractBaseTypeName(type?: string): string {
  const normalizedType = normalizeTypeName(type)
    .replace(/\[\]$/, "")
    .replace(/\s+(?:unsigned|signed|zerofill)\b/g, "")
    .trim();
  const parenIndex = normalizedType.indexOf("(");
  return (
    parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType
  ).trim();
}

function normalizeDeclaredScale(scale?: number): number | undefined {
  if (typeof scale !== "number" || !Number.isFinite(scale)) {
    return undefined;
  }

  return Math.max(0, Math.floor(scale));
}

function usesDefaultDecimalScale(type?: string): boolean {
  return DEFAULT_SCALE_DECIMAL_TYPE_ALIASES.has(extractBaseTypeName(type));
}

function getNumericScaleFromType(type?: string): number | undefined {
  const normalizedType = normalizeTypeName(type);
  if (!normalizedType) {
    return undefined;
  }

  const baseType = extractBaseTypeName(normalizedType);
  if (!SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) {
    return undefined;
  }

  const scaleMatch = normalizedType.match(
    /\(\s*(?:\*|\d+)\s*(?:,\s*(-?\d+)\s*)?\)/,
  );
  if (!scaleMatch) {
    return undefined;
  }

  if (typeof scaleMatch[1] === "undefined") {
    return 0;
  }

  return normalizeDeclaredScale(Number(scaleMatch[1]));
}

function resolveDeclaredNumericKind(
  type?: string,
  scale?: number,
): "integer" | "decimal" | "none" {
  const baseType = extractBaseTypeName(type);
  if (INTEGER_TYPE_ALIASES.has(baseType)) {
    return "integer";
  }

  if (SCALE_SENSITIVE_DECIMAL_TYPE_ALIASES.has(baseType)) {
    const resolvedScale =
      normalizeDeclaredScale(scale) ?? getNumericScaleFromType(type);
    return resolvedScale === 0 ? "integer" : "decimal";
  }

  if (DECIMAL_TYPE_ALIASES.has(baseType)) {
    return "decimal";
  }

  return "none";
}

function parseNumericString(
  value: unknown,
): { sign: string; integerPart: string; fractionalPart: string } | null {
  if (typeof value === "bigint") {
    return {
      sign: value < 0 ? "-" : "",
      integerPart: value.toString().replace(/^-/, ""),
      fractionalPart: "",
    };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
  }

  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }

  return {
    sign: match[1] === "-" ? "-" : "",
    integerPart: match[2].replace(/^0+(?=\d)/, "") || "0",
    fractionalPart: match[3] || "",
  };
}

function addGroupSeparators(integerPart: string, separator: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function hasNonZeroDigits(value: string): boolean {
  return /[1-9]/.test(value);
}

function incrementDigitString(value: string): string {
  let carry = 1;
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = Number(digits[index]) + carry;
    if (next >= 10) {
      digits[index] = "0";
      carry = 1;
    } else {
      digits[index] = String(next);
      carry = 0;
      break;
    }
  }

  if (carry > 0) {
    digits.unshift("1");
  }

  return digits.join("");
}

function shouldRoundHalfEven(
  nextDigit: string,
  remainder: string,
  lastKeptDigit: string,
): boolean {
  if (nextDigit > "5") {
    return true;
  }

  if (nextDigit < "5") {
    return false;
  }

  if (hasNonZeroDigits(remainder)) {
    return true;
  }

  return Number(lastKeptDigit || "0") % 2 === 1;
}

function roundParts(
  parsed: { sign: string; integerPart: string; fractionalPart: string },
  scale: number,
  roundingMode: ResultFormattingSettings["decimal"]["roundingMode"],
): { integerPart: string; fractionalPart: string } {
  const discarded = parsed.fractionalPart.slice(scale);
  let integerPart = parsed.integerPart;
  let fractionalPart = parsed.fractionalPart.slice(0, scale);

  if (!discarded) {
    return { integerPart, fractionalPart };
  }

  const nextDigit = discarded[0];
  const remainder = discarded.slice(1);
  const discardedHasValue = hasNonZeroDigits(discarded);
  let roundUp;

  switch (roundingMode) {
    case "ceil":
      roundUp = parsed.sign !== "-" && discardedHasValue;
      break;
    case "floor":
      roundUp = parsed.sign === "-" && discardedHasValue;
      break;
    case "truncate":
      roundUp = false;
      break;
    case "half-even":
      roundUp = shouldRoundHalfEven(
        nextDigit,
        remainder,
        (fractionalPart || integerPart).slice(-1),
      );
      break;
    case "half-up":
    default:
      roundUp = nextDigit >= "5";
      break;
  }

  if (roundUp) {
    const combined = incrementDigitString(
      `${integerPart}${fractionalPart}` || "0",
    );
    const splitIndex = Math.max(0, combined.length - scale);
    integerPart = (scale > 0 ? combined.slice(0, splitIndex) : combined) || "0";
    fractionalPart =
      scale > 0 ? combined.slice(splitIndex).padStart(scale, "0") : "";
  }

  return { integerPart, fractionalPart };
}

function getNumericKind(
  type?: string,
  value?: unknown,
  scale?: number,
): "integer" | "decimal" | "none" {
  const declaredKind = resolveDeclaredNumericKind(type, scale);
  if (declaredKind !== "none") {
    return declaredKind;
  }

  const parsed = parseNumericString(value);
  if (!parsed) {
    return "none";
  }

  return parsed.fractionalPart.length > 0 ? "decimal" : "integer";
}

function resolveDisplayDecimalScale(
  type: string | undefined,
  scale: number | undefined,
  defaultScale: number,
): number {
  if (usesDefaultDecimalScale(type)) {
    return defaultScale;
  }

  return (
    normalizeDeclaredScale(scale) ??
    getNumericScaleFromType(type) ??
    defaultScale
  );
}

function applyColumnOverride(
  settings: ResultFormattingSettings,
  override?: ColumnFormattingOverride,
): ResultFormattingSettings {
  const merged = mergeSettings(settings);
  if (!override) {
    return merged;
  }
  if (override.integer) {
    merged.integer = { ...merged.integer, ...override.integer };
  }
  if (override.decimal) {
    merged.decimal = { ...merged.decimal, ...override.decimal };
  }
  return merged;
}

export function formatResultValueForDisplay(
  value: unknown,
  column: ColumnDefinition,
  options?: {
    columnId?: string;
    payload?: ResultFormattingPayload;
    resultOverride?: Partial<ResultFormattingSettings>;
  },
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    const lowerType = (column.type || "").toLowerCase();
    if (lowerType === "date") {
      return `${y}-${m}-${d}`;
    }
    const hh = String(value.getUTCHours()).padStart(2, "0");
    const mm = String(value.getUTCMinutes()).padStart(2, "0");
    const ss = String(value.getUTCSeconds()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  const parsed = parseNumericString(value);
  if (!parsed) {
    return String(value);
  }

  const payload = options?.payload;
  let settings = mergeSettings(
    DEFAULT_RESULT_FORMATTING_SETTINGS,
    payload?.global,
  );
  settings = mergeSettings(settings, payload?.connection);
  settings = mergeSettings(settings, options?.resultOverride);
  settings = applyColumnOverride(
    settings,
    options?.columnId
      ? payload?.columnOverrides?.[options.columnId]
      : undefined,
  );

  let numericKind = getNumericKind(column.type, value, column.scale);
  const columnOverride = options?.columnId
    ? payload?.columnOverrides?.[options.columnId]
    : undefined;
  if (
    columnOverride?.kind === "integer" ||
    columnOverride?.kind === "decimal"
  ) {
    numericKind = columnOverride.kind;
  }

  if (numericKind === "integer") {
    const integerPart = settings.integer.useGrouping
      ? addGroupSeparators(parsed.integerPart, settings.integer.groupSeparator)
      : parsed.integerPart;
    return `${parsed.sign}${integerPart}`;
  }

  if (numericKind === "decimal") {
    const scale = resolveDisplayDecimalScale(
      column.type,
      column.scale,
      settings.decimal.scale,
    );
    const rounded = roundParts(parsed, scale, settings.decimal.roundingMode);
    const integerPart = settings.decimal.useGrouping
      ? addGroupSeparators(rounded.integerPart, settings.decimal.groupSeparator)
      : rounded.integerPart;
    let fractionalPart = rounded.fractionalPart;
    if (settings.decimal.preserveTrailingZeros) {
      fractionalPart = fractionalPart.padEnd(scale, "0");
    } else {
      fractionalPart = fractionalPart.replace(/0+$/, "");
    }
    const suffix = fractionalPart
      ? `${settings.decimal.decimalSeparator}${fractionalPart}`
      : "";
    return `${parsed.sign}${integerPart}${suffix}`;
  }

  return String(value);
}
