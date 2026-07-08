import type { DatabaseConnectionConfig } from '../contracts/database';

export const CURRENT_CATALOG_QUERY = /^SELECT\s+CURRENT_CATALOG(?:\s+FROM\s+DUAL)?\s*;?$/i;
export const CURRENT_SCHEMA_QUERY = /^SELECT\s+CURRENT_SCHEMA(?:\s+FROM\s+DUAL)?\s*;?$/i;
export const CURRENT_CATALOG_AND_SCHEMA_QUERY = /^SELECT\s+CURRENT_CATALOG\s*,\s*CURRENT_SCHEMA(?:\s+FROM\s+DUAL)?\s*;?$/i;
export const CURRENT_SID_QUERY = /^SELECT\s+CURRENT_SID(?:\s+FROM\s+DUAL)?\s*;?$/i;
export const SET_CATALOG_QUERY = /^SET\s+CATALOG\s+(.+?)\s*;?$/i;

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function getErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
        return undefined;
    }
    return error.code;
}

export function getOptionString(config: DatabaseConnectionConfig, key: string): string | undefined {
    const value = config.options?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function getOptionNumber(config: DatabaseConnectionConfig, key: string): number | undefined {
    const value = config.options?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}

export function normalizeCompatibilityIdentifier(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
    }

    return trimmed.toUpperCase();
}

export function normalizeCatalogIdentifier(value: string): string {
    return normalizeCompatibilityIdentifier(value, '').trim();
}

export function stripTrailingSemicolons(sql: string): string {
    return sql.trim().replace(/;+\s*$/, '');
}
