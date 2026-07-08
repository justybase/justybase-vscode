export type SqlTypeFamily = "numeric" | "string" | "datetime" | "boolean" | "unknown";

export type LiteralKind = "string" | "number" | "null" | "unknown";

export function classifyNetezzaDataType(typeName?: string): SqlTypeFamily {
  if (!typeName) {
    return "unknown";
  }
  const upper = typeName.toUpperCase();
  if (
    /\b(BYTEINT|INT1|INT2|INT4|INT8|INTEGER|BIGINT|SMALLINT|NUMERIC|DECIMAL|FLOAT|REAL|DOUBLE|MONEY)\b/.test(
      upper,
    )
  ) {
    return "numeric";
  }
  if (
    /\b(CHAR|VARCHAR|NCHAR|NVARCHAR|TEXT|CHARACTER|BINARY|VARBYTE|BYTEA)\b/.test(
      upper,
    )
  ) {
    return "string";
  }
  if (/\b(DATE|TIME|TIMESTAMP|INTERVAL|ABSTIME|TIMETZ|TIMESTAMPTZ)\b/.test(upper)) {
    return "datetime";
  }
  if (/\b(BOOLEAN|BOOL)\b/.test(upper)) {
    return "boolean";
  }
  return "unknown";
}

export function classifyLiteralToken(tokenTypeName?: string): LiteralKind {
  if (tokenTypeName === "StringLiteral") {
    return "string";
  }
  if (tokenTypeName === "NumberLiteral") {
    return "number";
  }
  if (tokenTypeName === "Null") {
    return "null";
  }
  return "unknown";
}

export function getTypeMismatchWarning(
  columnFamily: SqlTypeFamily,
  literalKind: LiteralKind,
  operator: string,
): { code: string; message: string } | undefined {
  if (
    columnFamily === "unknown" ||
    literalKind === "unknown" ||
    literalKind === "null"
  ) {
    return undefined;
  }

  const orderedOperators = new Set([
    "Equals",
    "NotEquals",
    "LessThan",
    "GreaterThan",
    "LessThanEquals",
    "GreaterThanEquals",
  ]);
  if (!orderedOperators.has(operator)) {
    return undefined;
  }

  if (columnFamily === "numeric" && literalKind === "string") {
    return {
      code: "SQL025",
      message:
        "Numeric column compared to string literal; implicit conversion may produce unexpected results",
    };
  }

  if (columnFamily === "string" && literalKind === "number") {
    if (operator !== "Equals" && operator !== "NotEquals") {
      return {
        code: "SQL026",
        message:
          "Text column compared to numeric literal with ordered operator; use CAST for intentional comparison",
      };
    }
    return {
      code: "SQL025",
      message:
        "Text column compared to numeric literal may cause implicit conversion",
    };
  }

  return undefined;
}

export function getColumnTypeMismatchWarning(
  leftFamily: SqlTypeFamily,
  rightFamily: SqlTypeFamily,
  operator: string,
): { code: string; message: string } | undefined {
  if (leftFamily === "unknown" || rightFamily === "unknown") {
    return undefined;
  }

  const orderedOperators = new Set([
    "Equals",
    "NotEquals",
    "LessThan",
    "GreaterThan",
    "LessThanEquals",
    "GreaterThanEquals",
  ]);
  if (!orderedOperators.has(operator)) {
    return undefined;
  }

  if (leftFamily === "numeric" && rightFamily === "string") {
    return {
      code: "SQL025",
      message:
        "Numeric column compared to text column; implicit conversion may produce unexpected results",
    };
  }

  if (leftFamily === "string" && rightFamily === "numeric") {
    if (operator !== "Equals" && operator !== "NotEquals") {
      return {
        code: "SQL026",
        message:
          "Text column compared to numeric column with ordered operator; use CAST for intentional comparison",
      };
    }
    return {
      code: "SQL025",
      message:
        "Text column compared to numeric column may cause implicit conversion",
    };
  }

  return undefined;
}

export function getArithmeticMixedTypeWarning(
  leftFamily: SqlTypeFamily,
  rightFamily: SqlTypeFamily,
): { code: string; message: string } | undefined {
  if (leftFamily === "unknown" || rightFamily === "unknown") {
    return undefined;
  }
  if (leftFamily === rightFamily) {
    return undefined;
  }

  if (leftFamily === "numeric" && rightFamily === "string") {
    return {
      code: "SQL025",
      message:
        "Numeric and text types mixed in arithmetic expression; implicit conversion may produce unexpected results",
    };
  }

  if (leftFamily === "string" && rightFamily === "numeric") {
    return {
      code: "SQL025",
      message:
        "Text and numeric types mixed in arithmetic expression; implicit conversion may produce unexpected results",
    };
  }

  return undefined;
}
