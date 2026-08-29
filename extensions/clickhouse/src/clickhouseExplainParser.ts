export interface ClickHouseExplainOptions {
    verbose?: boolean;
}

/** Build the stable EXPLAIN form supported by ClickHouse 24.8 and newer. */
export function buildClickHouseExplainQuery(sql: string, _options: ClickHouseExplainOptions = {}): string {
    return `EXPLAIN ${sql.trim().replace(/;+\s*$/, '')}`;
}

/** ClickHouse returns a textual plan; preserve it for the shared plan viewer. */
export function normalizeClickHouseExplainOutput(text: string): string {
    return text.replace(/\r\n/g, '\n').trim();
}

export function isClickHouseExplainOutput(text: string): boolean {
    return /(?:EXPLAIN|PLAN|ReadFrom|Expression|Aggregating|Sorting)/i.test(text);
}
