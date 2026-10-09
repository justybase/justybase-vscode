import { resolveSqlParsingRuntime } from './parsingRuntime'
import type { SqlRenameResolution } from './symbols'
import {
    buildSqlColumnRenameEdits as buildColumnRenameEdits,
    type SqlColumnRenameEdit,
} from '@justybase/sql-core/validation/columnAuthoring'
import type { SqlColumnCatalogLookup } from '@justybase/sql-core/validation/columnIdentity'
import { allTokens as netezzaTokens } from '@justybase/sql-core/netezza/lexer'

let combinedKeywordLeadWords: ReadonlySet<string> | undefined

/**
 * Reserved words the lexer only recognizes as the first word of a combined
 * keyword token (`ORDER BY`, `GROUP BY`, `PARTITION BY`): alone they lex as
 * identifiers but are still reserved, so a replacement must be quoted.
 */
function isCombinedKeywordLeadWord(name: string): boolean {
    combinedKeywordLeadWords ??= new Set(netezzaTokens.flatMap(tokenType => {
        const pattern = tokenType.PATTERN
        const match = pattern instanceof RegExp ? /^([A-Za-z]+)\\s\+/.exec(pattern.source) : null
        return match ? [match[1].toUpperCase()] : []
    }))
    return combinedKeywordLeadWords.has(name.toUpperCase())
}

/** The logical identifier a rename requests, or undefined when the name is malformed. */
export function requestedSqlRenameName(newName: string): string | undefined {
    const trimmed = newName.trim()
    if (!trimmed || Array.from(trimmed).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined
    let logical = trimmed
    if (trimmed.startsWith('"')) {
        if (!trimmed.endsWith('"') || trimmed.length < 2) return undefined
        const body = trimmed.slice(1, -1)
        if (body.replace(/""/g, '').includes('"')) return undefined
        logical = body.replace(/""/g, '"')
    }
    return logical || undefined
}

export function buildSqlRenameEdits(sql: string, symbol: SqlRenameResolution, newName: string) {
    if (symbol.occurrences.some(occurrence => sql.slice(occurrence.startOffset, occurrence.endOffset) !== occurrence.text)) return undefined
    const logical = requestedSqlRenameName(newName)
    if (!logical || symbol.otherDefinitionNames?.some(name => name.toUpperCase() === logical.toUpperCase())) return undefined
    // Renaming to the exposed name of an unaliased physical relation would
    // capture that relation's qualified references.
    if (symbol.exposedRelationNames?.some(name => name.toUpperCase() === logical.toUpperCase())) return undefined
    return symbol.occurrences.map(occurrence => ({
        startOffset: occurrence.startOffset, endOffset: occurrence.endOffset,
        newText: formatSqlRenameReplacement(sql.slice(occurrence.startOffset, occurrence.endOffset), newName.trim()),
    })).sort((left, right) => left.startOffset - right.startOffset)
}

/**
 * Renames the local column (output alias, CTE, derived-table or script-local
 * projection) at `offset` with the same name policy and quoting as relation
 * rename. Undefined when the name is malformed or the rename is unsafe;
 * physical catalog columns are never renamed.
 */
export function buildSqlColumnRenameEdits(
    sql: string,
    offset: number,
    newName: string,
    lookup?: SqlColumnCatalogLookup,
): SqlColumnRenameEdit[] | undefined {
    if (requestedSqlRenameName(newName) === undefined) return undefined
    return buildColumnRenameEdits(sql, offset, original => formatSqlRenameReplacement(original, newName.trim()), lookup)
}

export function formatSqlRenameReplacement(
    originalText: string,
    newName: string
): string {
    const trimmedName = newName.trim()
    const unquotedNewName =
        trimmedName.length >= 2 && trimmedName.startsWith('"') && trimmedName.endsWith('"')
            ? trimmedName.slice(1, -1).replace(/""/g, '"')
            : trimmedName

    if (originalText.length >= 2 && originalText.startsWith('"') && originalText.endsWith('"')) {
        return `"${unquotedNewName.replace(/"/g, '""')}"`
    }

    const lexed = resolveSqlParsingRuntime({ databaseKind: 'netezza' }).SqlLexer.tokenize(unquotedNewName)
    const plain = lexed.errors.length === 0 && lexed.tokens.length === 1
        && lexed.tokens[0].tokenType.name === 'Identifier' && lexed.tokens[0].image === unquotedNewName
        && !isCombinedKeywordLeadWord(unquotedNewName)
    return trimmedName.startsWith('"') || !plain
        ? `"${unquotedNewName.replace(/"/g, '""')}"` : unquotedNewName
}
