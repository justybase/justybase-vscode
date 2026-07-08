import { CstNode, type IToken } from "chevrotain";
import type { ValidationError } from "../types";
import {
  EXTERNAL_BOOLEAN_VALUES,
  EXTERNAL_OPTION_SPECS,
  type ExternalOptionValueInfo,
  type ExternalOptionValueKind,
} from "./externalTableConstants";

export interface ExternalTableVisitorHost {
  addError(
    message: string,
    token: IToken,
    severity: ValidationError["severity"],
    code: string,
  ): void;
  visit(node: CstNode): void;
  visitAs<T>(node: CstNode): T;
  getTokenText(token: IToken | IToken[] | undefined): string;
  getFirstTokenFromCst(node: CstNode): IToken | undefined;
  isToken(value: unknown): value is IToken;
  isCstNode(value: unknown): value is CstNode;
}

function normalizeExternalOptionName(raw: string): string {
  return raw.replace(/"/g, "").trim().toUpperCase();
}

function unquoteSqlLiteral(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text;
}

function normalizeExternalOptionValue(raw: string): string {
  return unquoteSqlLiteral(raw).trim().toUpperCase();
}

function estimateExternalLiteralLength(raw: string): number {
  const unescaped = raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n\\r/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\0/g, "\0")
    .replace(/\\\\/g, "\\");
  return unescaped.length;
}

function extractStringValue(
  value: ExternalOptionValueInfo,
): string | undefined {
  if (value.kind === "string" || value.kind === "identifier") {
    return unquoteSqlLiteral(value.raw);
  }

  if (value.kind === "parenthesized" && value.nested) {
    for (const nested of value.nested) {
      const extracted = extractStringValue(nested);
      if (extracted && extracted.length > 0) {
        return extracted;
      }
    }
  }

  return undefined;
}

function parseIntegerValue(
  value: ExternalOptionValueInfo,
): number | undefined {
  const candidate = unquoteSqlLiteral(value.raw).trim();
  if (!/^[+-]?\d+$/.test(candidate)) {
    return undefined;
  }

  const parsed = Number(candidate);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseBigIntValue(value: ExternalOptionValueInfo): bigint | undefined {
  const candidate = unquoteSqlLiteral(value.raw).trim();
  if (!/^[+-]?\d+$/.test(candidate)) {
    return undefined;
  }

  try {
    return BigInt(candidate);
  } catch {
    return undefined;
  }
}

function parseMultipartSizeMb(
  value: ExternalOptionValueInfo,
): number | undefined {
  const candidate = normalizeExternalOptionValue(value.raw);
  const match = /^([+-]?\d+)(MB|GB)?$/.exec(candidate);
  if (!match) {
    return undefined;
  }

  const base = Number.parseInt(match[1], 10);
  if (!Number.isInteger(base)) {
    return undefined;
  }

  const unit = match[2] || "MB";
  return unit === "GB" ? base * 1024 : base;
}

export function validateExternalTableOption(
  host: ExternalTableVisitorHost,
  optionName: string,
  optionToken: IToken,
  valueInfo: ExternalOptionValueInfo | undefined,
): void {
  const spec = EXTERNAL_OPTION_SPECS.get(optionName);
  if (!spec) {
    host.addError(
      `External table option '${optionName}' is not supported`,
      optionToken,
      "error",
      "SQL016",
    );
    return;
  }

  if (!valueInfo) {
    if (spec.allowNoValue) {
      return;
    }
    host.addError(
      `External table option '${optionName}' requires a value`,
      optionToken,
      "error",
      "SQL017",
    );
    return;
  }

  const normalized = valueInfo.normalized;

  switch (spec.type) {
    case "none":
      return;
    case "boolean":
      if (!EXTERNAL_BOOLEAN_VALUES.has(normalized)) {
        host.addError(
          `Invalid boolean value '${valueInfo.raw}' for option '${optionName}'`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    case "compress":
      if (
        !EXTERNAL_BOOLEAN_VALUES.has(normalized) &&
        normalized !== "ZLIB" &&
        !normalized.startsWith("ZSTD")
      ) {
        host.addError(
          `Invalid value '${valueInfo.raw}' for option '${optionName}'`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    case "enum":
      if (!spec.enumValues?.has(normalized)) {
        host.addError(
          `Invalid value '${valueInfo.raw}' for option '${optionName}'`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    case "integer": {
      const parsed = parseIntegerValue(valueInfo);
      if (parsed === undefined) {
        host.addError(
          `Option '${optionName}' requires an integer value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
        return;
      }
      if (
        (spec.min !== undefined && parsed < spec.min) ||
        (spec.max !== undefined && parsed > spec.max)
      ) {
        host.addError(
          `Option '${optionName}' value '${valueInfo.raw}' is out of range`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
    case "bigint": {
      const parsed = parseBigIntValue(valueInfo);
      if (parsed === undefined) {
        host.addError(
          `Option '${optionName}' requires a numeric value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
        return;
      }
      const min = spec.min !== undefined ? BigInt(spec.min) : undefined;
      const max = spec.max !== undefined ? BigInt(spec.max) : undefined;
      if (
        (min !== undefined && parsed < min) ||
        (max !== undefined && parsed > max)
      ) {
        host.addError(
          `Option '${optionName}' value '${valueInfo.raw}' is out of range`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
    case "multipart_size_mb": {
      const parsed = parseMultipartSizeMb(valueInfo);
      if (parsed === undefined || parsed < 8 || parsed > 5120) {
        host.addError(
          `Option '${optionName}' must be between 8MB and 5GB`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
    case "single_byte_string":
    case "max_4_byte_string":
    case "max_8_byte_string": {
      const extracted = extractStringValue(valueInfo);
      if (extracted === undefined) {
        host.addError(
          `Option '${optionName}' requires a string value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
        return;
      }

      const length = estimateExternalLiteralLength(extracted);
      if (spec.type === "single_byte_string" && length !== 1) {
        host.addError(
          `Option '${optionName}' requires a single-byte string value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
        return;
      }
      if (spec.type === "max_4_byte_string" && length > 4) {
        host.addError(
          `Option '${optionName}' supports up to 4 bytes`,
          valueInfo.token,
          "error",
          "SQL017",
        );
        return;
      }
      if (spec.type === "max_8_byte_string" && length > 8) {
        host.addError(
          `Option '${optionName}' supports up to 8 bytes`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
    case "dataobject": {
      const extracted = extractStringValue(valueInfo);
      if (!extracted) {
        host.addError(
          `Option '${optionName}' requires a file path value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
    case "string": {
      const extracted = extractStringValue(valueInfo);
      if (!extracted) {
        host.addError(
          `Option '${optionName}' requires a string value`,
          valueInfo.token,
          "error",
          "SQL017",
        );
      }
      return;
    }
  }
}

export function externalTableUsingClause(visitor: ExternalTableVisitorHost, ctx: Record<string, CstNode[]>): void {
  if (ctx.externalTableOptionList) {
    visitor.visit(ctx.externalTableOptionList[0]);
  }
}

export function externalTableOptionList(visitor: ExternalTableVisitorHost, ctx: Record<string, CstNode[]>): void {
  if (ctx.externalTableOption) {
    ctx.externalTableOption.forEach((optionNode: CstNode) =>
      visitor.visit(optionNode),
    );
  }
}

export function externalTableOption(visitor: ExternalTableVisitorHost, ctx: Record<string, CstNode[]>): void {
  if (!ctx.identifier || !ctx.identifier[0]) {
    return;
  }

  const optionNameRaw = visitor.visitAs<string>(ctx.identifier[0]);
  const optionName = normalizeExternalOptionName(optionNameRaw);
  const optionToken = visitor.getFirstTokenFromCst(ctx.identifier[0]);
  if (!optionToken) {
    return;
  }

  const valueInfo = ctx.externalTableOptionValue
    ? visitor.visitAs<ExternalOptionValueInfo>(ctx.externalTableOptionValue[0])
    : undefined;
  validateExternalTableOption(visitor, optionName, optionToken, valueInfo);
}

export function externalTableOptionValue(visitor: ExternalTableVisitorHost, 
  ctx: Record<string, CstNode[] | IToken[]>,
): ExternalOptionValueInfo {
  if (ctx.externalTableParenthesizedValue?.[0]) {
    return visitor.visitAs<ExternalOptionValueInfo>(
      ctx.externalTableParenthesizedValue[0] as CstNode,
    );
  }

  if (ctx.externalTableNumericValue?.[0]) {
    return visitor.visitAs<ExternalOptionValueInfo>(
      ctx.externalTableNumericValue[0] as CstNode,
    );
  }

  const stringToken = ctx.StringLiteral?.[0] as IToken | undefined;
  if (stringToken) {
    return {
      kind: "string",
      raw: visitor.getTokenText(stringToken),
      normalized: normalizeExternalOptionValue(visitor.getTokenText(stringToken)),
      token: stringToken,
    };
  }

  if (ctx.identifier?.[0]) {
    const identifierNode = ctx.identifier[0] as CstNode;
    const token = visitor.getFirstTokenFromCst(identifierNode);
    const raw = visitor.visitAs<string>(identifierNode);
    return {
      kind: "identifier",
      raw,
      normalized: normalizeExternalOptionValue(raw),
      token: token as IToken,
    };
  }

  const nullToken = ctx.Null?.[0] as IToken | undefined;
  if (nullToken) {
    return {
      kind: "identifier",
      raw: visitor.getTokenText(nullToken),
      normalized: normalizeExternalOptionValue(visitor.getTokenText(nullToken)),
      token: nullToken,
    };
  }

  const fallbackToken = Object.values(ctx).find(
    (value) => Array.isArray(value) && value[0] && visitor.isToken(value[0]),
  )?.[0] as IToken;
  return {
    kind: "identifier",
    raw: visitor.getTokenText(fallbackToken),
    normalized: normalizeExternalOptionValue(visitor.getTokenText(fallbackToken)),
    token: fallbackToken,
  };
}

export function externalTableNumericValue(visitor: ExternalTableVisitorHost, 
  ctx: Record<string, IToken[]>,
): ExternalOptionValueInfo {
  const sign = ctx.Minus?.[0] ? "-" : ctx.Plus?.[0] ? "+" : "";
  const numberToken = ctx.NumberLiteral?.[0];
  const raw = `${sign}${visitor.getTokenText(numberToken)}`;
  return {
    kind: "number",
    raw,
    normalized: normalizeExternalOptionValue(raw),
    token: (ctx.Minus?.[0] || ctx.Plus?.[0] || numberToken) as IToken,
  };
}

export function externalTableParenthesizedValue(visitor: ExternalTableVisitorHost, 
  ctx: Record<string, CstNode[] | IToken[]>,
): ExternalOptionValueInfo {
  const nested = (ctx.externalTableParenthesizedElement ?? []).map((node) =>
    visitor.visitAs<ExternalOptionValueInfo>(node as CstNode),
  );
  const raw = nested
    .map((value) => value.raw)
    .join(" ")
    .trim();
  const token = (ctx.LParen?.[0] as IToken | undefined) || nested[0]?.token;
  return {
    kind: "parenthesized",
    raw,
    normalized: normalizeExternalOptionValue(raw),
    token: token as IToken,
    nested,
  };
}

export function externalTableParenthesizedElement(visitor: ExternalTableVisitorHost, 
  ctx: Record<string, CstNode[] | IToken[]>,
): ExternalOptionValueInfo {
  if (ctx.externalTableParenthesizedValue?.[0]) {
    return visitor.visitAs<ExternalOptionValueInfo>(
      ctx.externalTableParenthesizedValue[0] as CstNode,
    );
  }

  if (ctx.identifier?.[0]) {
    const identifierNode = ctx.identifier[0] as CstNode;
    const token = visitor.getFirstTokenFromCst(identifierNode);
    const raw = visitor.visitAs<string>(identifierNode);
    return {
      kind: "identifier",
      raw,
      normalized: normalizeExternalOptionValue(raw),
      token: token as IToken,
    };
  }

  const token = Object.values(ctx).find(
    (value) => Array.isArray(value) && value[0] && visitor.isToken(value[0]),
  )?.[0] as IToken;
  const raw = visitor.getTokenText(token);
  const tokenType = (token.tokenType as { name?: string } | undefined)?.name;
  const kind: ExternalOptionValueKind =
    tokenType === "NumberLiteral"
      ? "number"
      : tokenType === "StringLiteral"
        ? "string"
        : "identifier";
  return {
    kind,
    raw,
    normalized: normalizeExternalOptionValue(raw),
    token,
  };
}
