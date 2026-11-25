import type { DatabaseExplainOptions } from '../../contracts/database';
import { getDatabaseExplainProvider } from '../connectionFactory';

/** What one EXPLAIN invocation needs on the server. */
export interface ExplainRequest {
    /** Statement that produces or records the plan. */
    explainSql: string;
    /** Statement that reads a persisted plan back (Db2, Oracle). */
    retrieveQuery?: string;
}

export interface BuildExplainRequestOptions {
    verbose?: boolean;
    analyze?: boolean;
}

/**
 * Removes a leading `EXPLAIN` the user typed themselves, including the dialect
 * prefixes the extension itself generates (`EXPLAIN VERBOSE`, `EXPLAIN QUERY
 * PLAN`, Db2/Oracle `EXPLAIN PLAN FOR`).
 */
export function stripExplainPrefix(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed.toUpperCase().startsWith('EXPLAIN')) {
        return trimmed;
    }
    return trimmed
        .replace(/^EXPLAIN\s+(?:(?:QUERY\s+PLAN)|(?:PLAN(?:\s+FOR)?)|VERBOSE)?\s*/i, '')
        .trim();
}

/**
 * Builds the dialect-specific EXPLAIN statement. Dialects without a provider
 * fall back to the Netezza-style `EXPLAIN [VERBOSE]`, which is also what the
 * repository did before providers existed.
 */
export function buildExplainRequest(
    sql: string,
    databaseKind: string | undefined,
    options: BuildExplainRequestOptions = {},
): ExplainRequest {
    const strippedSql = stripExplainPrefix(sql);
    const provider = getDatabaseExplainProvider(databaseKind);
    if (provider) {
        const explainOptions: DatabaseExplainOptions = {
            verbose: options.verbose,
            analyze: options.analyze,
        };
        return {
            explainSql: provider.buildQuery(strippedSql, explainOptions),
            retrieveQuery: provider.buildRetrieveQuery?.(),
        };
    }

    return {
        explainSql: options.verbose ? `EXPLAIN VERBOSE ${strippedSql}` : `EXPLAIN ${strippedSql}`,
    };
}

/** Applies the dialect's plan-text normalization, when it has one. */
export function normalizeExplainOutputForDisplay(
    explainOutput: string,
    databaseKind: string | undefined,
): string {
    const provider = getDatabaseExplainProvider(databaseKind);
    return provider?.normalizeOutput?.(explainOutput) ?? explainOutput;
}

/** Lets a dialect turn a driver error into an actionable message. */
export function formatExplainErrorForDialect(
    message: string,
    databaseKind: string | undefined,
): string {
    const provider = getDatabaseExplainProvider(databaseKind);
    return provider?.formatError?.(message) ?? message;
}
