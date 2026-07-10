export interface TrailingLimitClause {
    value: string;
    valueStart: number;
    valueEnd: number;
    keywordStart: number;
}

export function findTrailingLimitClause(sql: string): TrailingLimitClause | undefined {
    // Allow inline block comments between LIMIT keyword and the number, e.g. "LIMIT /* n */ 100"
    const match = /\blimit(?:\s+(?:\/\*[\s\S]*?\*\/\s*)*|\/\*[\s\S]*?\*\/\s*)(\d+)(\s*;?\s*)$/i.exec(sql);
    if (!match || match.index === undefined) {
        return undefined;
    }

    const value = match[1];
    const valueStart = match.index + match[0].indexOf(value);
    return {
        value,
        valueStart,
        valueEnd: valueStart + value.length,
        keywordStart: match.index,
    };
}

export function replaceTrailingLimitValue(sql: string, limitValue: string): string {
    const limit = findTrailingLimitClause(sql);
    if (!limit) {
        return sql;
    }

    return `${sql.slice(0, limit.valueStart)}${limitValue}${sql.slice(limit.valueEnd)}`;
}

export function removeTrailingLimitClause(sql: string): string {
    const limit = findTrailingLimitClause(sql);
    if (!limit) {
        return sql;
    }

    const suffix = sql.slice(limit.valueEnd);
    const semicolonMatch = /;\s*$/.exec(suffix);
    return `${sql.slice(0, limit.keywordStart).trimEnd()}${semicolonMatch ? ';' : ''}`;
}
