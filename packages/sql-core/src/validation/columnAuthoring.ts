import type { NetezzaSqlParseResult } from '../parser/runtime'
import {
    SqlColumnIdentityAnalysis,
    type SqlCatalogColumn,
    type SqlColumnCatalogLookup,
    type SqlColumnIdentity,
    type SqlColumnRelationKind,
    type SqlColumnResolutionStatus,
} from './columnIdentity'

/**
 * Column Hover, physical navigation and Rename, all answered from the column
 * identity that drives Definition and References.
 */

/** What column Hover shows; origin and type are absent when they cannot be proven. */
export interface SqlColumnHoverInfo {
    name: string
    status: SqlColumnResolutionStatus
    relationKind?: SqlColumnRelationKind
    relation?: string
    /** The physical column itself, or the physical origin of a local projection. */
    origin?: SqlCatalogColumn
    /** Metadata data type of {@link origin}. */
    type?: string
    candidates: string[]
}

export function describeSqlColumnForHover(identity: SqlColumnIdentity): SqlColumnHoverInfo {
    const physical = identity.status === 'resolved' ? identity.catalog ?? identity.origin : undefined
    const origin = physical ? { database: physical.database, schema: physical.schema, relation: physical.relation, column: physical.column } : undefined
    return {
        name: identity.name,
        status: identity.status,
        relationKind: identity.relationKind,
        relation: identity.relation,
        origin,
        type: physical?.type,
        candidates: identity.candidates,
    }
}

/**
 * A catalog column a host can reveal in its schema browser: the column itself
 * when it is physical (`catalog`), otherwise the proven physical origin of a
 * local projection (`origin`). It never has a document range.
 */
export interface SqlColumnCatalogTarget {
    database: string | null
    schema: string | null
    relation: string
    column: string
    via: 'catalog' | 'origin'
}

export function resolveSqlColumnCatalogTarget(identity: SqlColumnIdentity | undefined): SqlColumnCatalogTarget | undefined {
    if (!identity || identity.status !== 'resolved') return undefined
    const via = identity.catalog ? 'catalog' : identity.origin ? 'origin' : undefined
    const column = identity.catalog ?? identity.origin
    if (!via || !column) return undefined
    return { database: column.database, schema: column.schema, relation: column.relation, column: column.column, via }
}

/** A renamable local column: its identity and the declaration range to rename. */
export interface SqlColumnRenameTarget {
    identity: SqlColumnIdentity
    startOffset: number
    endOffset: number
}

export interface SqlColumnRenameEdit {
    startOffset: number
    endOffset: number
    newText: string
}

/**
 * The local column at `offset` when it is safe to rename at all: a resolved
 * identity whose definition is spelled by an alias or explicit CTE column
 * list. Physical, ambiguous and unresolved columns, pass-through projections
 * (the definition is itself a column reference), `*` expansions and columns
 * that feed another projection are not renamable.
 */
export function prepareSqlColumnRename(analysis: SqlColumnIdentityAnalysis, sql: string, offset: number): SqlColumnRenameTarget | undefined {
    const key = analysis.keyAt(offset)
    const identity = key === undefined ? undefined : analysis.identity(key)
    if (!key || !identity || identity.status !== 'resolved' || !identity.definition) return undefined
    const { startOffset, endOffset } = identity.definition
    if (sql.slice(startOffset, endOffset) === '*') return undefined
    if (identity.occurrences.some(occurrence => analysis.hasOtherOccurrenceAt(key, occurrence.startOffset, occurrence.endOffset))) return undefined
    const target = identity.occurrences.find(occurrence => occurrence.startOffset <= offset && offset <= occurrence.endOffset) ?? identity.definition
    return { identity, startOffset: target.startOffset, endOffset: target.endOffset }
}

/**
 * Edits that rename the local column at `offset` everywhere its identity
 * occurs, or undefined when the rename is unsafe. `replacementFor` formats the
 * new spelling for one original occurrence. The edited text is analyzed again
 * and must resolve every column occurrence exactly as before, so a rename
 * that would be captured by, or capture, another column (shadowing, nested
 * scopes, ambiguity, sibling collisions) is rejected.
 */
export function buildSqlColumnRenameEdits(
    sql: string,
    offset: number,
    replacementFor: (originalText: string) => string | undefined,
    lookup?: SqlColumnCatalogLookup,
    parseResult?: Pick<NetezzaSqlParseResult, 'cst'>,
): SqlColumnRenameEdit[] | undefined {
    const before = SqlColumnIdentityAnalysis.analyze(sql, lookup, parseResult)
    if (!before) return undefined
    const target = prepareSqlColumnRename(before, sql, offset)
    if (!target) return undefined
    const edits: SqlColumnRenameEdit[] = []
    for (const occurrence of target.identity.occurrences) {
        const newText = replacementFor(sql.slice(occurrence.startOffset, occurrence.endOffset))
        if (!newText) return undefined
        edits.push({ startOffset: occurrence.startOffset, endOffset: occurrence.endOffset, newText })
    }
    edits.sort((left, right) => left.startOffset - right.startOffset)
    let renamed = sql
    for (const edit of [...edits].reverse()) renamed = renamed.slice(0, edit.startOffset) + edit.newText + renamed.slice(edit.endOffset)
    const after = SqlColumnIdentityAnalysis.analyze(renamed, lookup)
    if (!after) return undefined
    const mapOffset = (position: number) => {
        let delta = 0
        for (const edit of edits) {
            if (edit.endOffset > position) break
            delta += edit.newText.length - (edit.endOffset - edit.startOffset)
        }
        return position + delta
    }
    const mapRange = (start: number, end: number): [number, number] => {
        const edit = edits.find(candidate => candidate.startOffset === start && candidate.endOffset === end)
        const mappedStart = mapOffset(start)
        return edit ? [mappedStart, mappedStart + edit.newText.length] : [mappedStart, mapOffset(end)]
    }
    const expected = before.partition(mapRange)
    const actual = after.partition()
    if (expected.length !== actual.length || expected.some((signature, index) => signature !== actual[index])) return undefined
    return edits
}
