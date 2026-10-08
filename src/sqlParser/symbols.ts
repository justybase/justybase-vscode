import type { DatabaseKind } from '../contracts/database'
import { parseSqlStatements, type SqlStatementsParseResult } from './parsingRuntime'
import {
    resolveSqlRenameSymbol as resolveCoreSymbol,
    collectSqlSymbolUsagesFromCst,
} from '@justybase/sql-core/validation/symbols'
export { collectSqlSymbolUsagesFromCst } from '@justybase/sql-core/validation/symbols'
export type {
    SqlRenameOccurrence, SqlRenameResolution, SqlRenameSymbolKind, SqlSymbolUsage,
} from '@justybase/sql-core/validation/symbols'

/** Dialect parsing stays at the desktop boundary; identity uses one collector. */
export function resolveSqlRenameSymbol(sql: string, offset: number, databaseKind?: DatabaseKind, parseResult?: SqlStatementsParseResult) {
    return resolveCoreSymbol(sql, offset, parseResult ?? parseSqlStatements({ sql, databaseKind }))
}

export function collectSqlSymbolUsages(sql: string, databaseKind?: DatabaseKind) {
    const parsed = parseSqlStatements({ sql, databaseKind })
    if (!parsed.cst || parsed.lexResult.errors.length || parsed.actionableParserErrors.length) return []
    return collectSqlSymbolUsagesFromCst(parsed.cst)
}
