import { resolveSqlParsingRuntime } from './parsingRuntime'
import type { SqlRenameResolution } from './symbols'

export function buildSqlRenameEdits(sql: string, symbol: SqlRenameResolution, newName: string) {
    if (symbol.occurrences.some(occurrence => sql.slice(occurrence.startOffset, occurrence.endOffset) !== occurrence.text)) return undefined
    const trimmed = newName.trim()
    if (!trimmed || Array.from(trimmed).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined
    let logical = trimmed
    if (trimmed.startsWith('"')) {
        if (!trimmed.endsWith('"') || trimmed.length < 2) return undefined
        const body = trimmed.slice(1, -1)
        if (body.replace(/""/g, '').includes('"')) return undefined
        logical = body.replace(/""/g, '"')
    }
    if (!logical || symbol.otherDefinitionNames?.some(name => name.toUpperCase() === logical.toUpperCase())) return undefined
    return symbol.occurrences.map(occurrence => ({
        startOffset: occurrence.startOffset, endOffset: occurrence.endOffset,
        newText: formatSqlRenameReplacement(sql.slice(occurrence.startOffset, occurrence.endOffset), trimmed),
    })).sort((left, right) => left.startOffset - right.startOffset)
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
    return trimmedName.startsWith('"') || !plain
        ? `"${unquotedNewName.replace(/"/g, '""')}"` : unquotedNewName
}
