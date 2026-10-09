import type { CstNode, IToken } from 'chevrotain'
import { isCstNode, isToken } from './referenceTokenCollector'
import { parseNetezzaSqlForAuthoringRecovery, type NetezzaSqlParseResult } from '../parser/runtime'

/**
 * Column semantic identity for editor navigation.
 *
 * Every column reference gets one identity, and column Definition and
 * References are both answered from it instead of text matching:
 * - a qualified reference binds its qualifier to a visible relation (current
 *   query first, then correlated parents) and must exist when the relation's
 *   columns are known;
 * - an unqualified reference resolves only when exactly one visible source
 *   provides the column; two or more is ambiguous and unknown metadata leaves
 *   it unresolved instead of guessing;
 * - ORDER BY binds an unqualified name to an explicit output alias first;
 * - CTE, derived-table and script-local CTAS projections and `*` expansions
 *   get local document definitions and keep the physical origin of plain
 *   column references.
 *
 * Temporarily incomplete SQL is resolved from the authoring recovery CST of
 * the same parser; its zero-width placeholders never become occurrences.
 */
export type SqlColumnResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved'
export type SqlColumnRelationKind = 'table' | 'cte' | 'derived_table' | 'script_local_table' | 'output_alias'

export interface SqlCatalogColumn {
    database: string | null
    schema: string | null
    relation: string
    column: string
    /** Metadata data type; absent when metadata does not know it. */
    type?: string
}

/** Half-open UTF-16 offsets. */
export interface SqlColumnOccurrence {
    startOffset: number
    endOffset: number
    isDefinition: boolean
}

export interface SqlColumnIdentity {
    name: string
    status: SqlColumnResolutionStatus
    relationKind?: SqlColumnRelationKind
    relation?: string
    /** Local document definition; absent for physical, ambiguous or unresolved columns. */
    definition?: SqlColumnOccurrence
    /** Physical catalog target. */
    catalog?: SqlCatalogColumn
    /** Physical column a local projection reduces to through plain column references. */
    origin?: SqlCatalogColumn
    candidates: string[]
    occurrences: SqlColumnOccurrence[]
}

export interface SqlColumnCatalogTable {
    database?: string | null
    schema?: string | null
    name: string
    /** Column names; an empty list means the columns are unknown. */
    columns: string[]
    /** Metadata data types aligned with `columns`; entries may be absent. */
    columnTypes?: ReadonlyArray<string | undefined>
}

/** Synchronous metadata lookup supplied by the host; return undefined when unknown. */
export type SqlColumnCatalogLookup = (
    database: string | undefined,
    schema: string | undefined,
    table: string,
) => SqlColumnCatalogTable | undefined

export interface SqlPhysicalTableReference {
    database?: string
    schema?: string
    name: string
}

interface Info {
    name: string
    status: SqlColumnResolutionStatus
    relationKind?: SqlColumnRelationKind
    relation?: string
    definition?: [number, number]
    catalog?: SqlCatalogColumn
    origin?: SqlCatalogColumn
    candidates: string[]
}

interface Occurrence {
    start: number
    end: number
    key: string
    isDefinition: boolean
}

interface Projected {
    name: string
    norm: string
    key: string
    start: number
    end: number
    origin?: SqlCatalogColumn
}

interface Relation {
    name: string
    exposed: string
    kind: SqlColumnRelationKind
    local?: Array<Projected | undefined>
    physical?: { database: string | null; schema: string | null; table: string }
    physicalColumns?: string[]
    physicalTypes?: ReadonlyArray<string | undefined>
}

class Frame {
    readonly ctes = new Map<string, Relation>()
    readonly sources: Relation[] = []
    readonly outputAliases = new Map<string, Projected>()
    constructor(readonly parent: Frame | undefined) {}
}

const QUERY_NODES = new Set(['selectStatement', 'withAnyStatement', 'withStatement'])

class ColumnIdentityCollector {
    readonly occurrences: Occurrence[] = []
    readonly identities = new Map<string, Info>()
    readonly physicalTables: SqlPhysicalTableReference[] = []
    private readonly scriptTables = new Map<string, Relation>()

    constructor(private readonly lookup: SqlColumnCatalogLookup | undefined) {}

    collect(root: CstNode): void {
        const global = new Frame(undefined)
        for (const statement of childNodes(root, 'statement')) {
            for (const node of allChildNodes(statement)) this.processStatement(node, global)
        }
    }

    private processStatement(node: CstNode, global: Frame): void {
        if (QUERY_NODES.has(node.name)) {
            this.processQuery(node, global)
            return
        }
        if (node.name === 'createTableStatement') {
            const query = allChildNodes(node).find(child => QUERY_NODES.has(child.name))
            const target = identifierTokens(childNodes(node, 'qualifiedName')[0])
            const nameToken = target[target.length - 1]
            if (!query || !nameToken) return
            const columns = this.processQuery(query, global)
            const relation: Relation = {
                name: unquote(nameToken.image),
                exposed: normalizeToken(nameToken),
                kind: 'script_local_table',
                local: columns,
            }
            this.registerLocal(relation)
            this.scriptTables.set(relation.exposed, relation)
            return
        }
        if (node.name === 'dropStatement') {
            for (const list of childNodes(node, 'dropTargetList'))
                for (const target of childNodes(list, 'dropTarget')) {
                    const parts = identifierTokens(childNodes(target, 'qualifiedName')[0])
                    const last = parts[parts.length - 1]
                    if (last) this.scriptTables.delete(normalizeToken(last))
                }
            return
        }
        // INSERT ... SELECT and other statements: resolve nested queries.
        for (const child of allChildNodes(node)) this.walk(child, global, false)
    }

    /** Resolves a query (with optional WITH clause) and returns its projection. */
    private processQuery(node: CstNode, parent: Frame): Array<Projected | undefined> {
        if (node.name === 'selectStatement') return this.processSelect(node, parent)
        const frame = new Frame(parent)
        for (const cte of childNodes(node, 'cteDefinition')) {
            const nameToken = tokensOf(cte).find(token => token.tokenType.name === 'Identifier' || token.tokenType.name === 'QuotedIdentifier')
            const query = allChildNodes(cte).find(child => QUERY_NODES.has(child.name))
            if (!nameToken || !query) continue
            let columns = this.processQuery(query, frame)
            const columnList = childNodes(cte, 'cteColumnList')[0]
            if (columnList) columns = this.renameFromColumnList(columnList, columns)
            const relation: Relation = { name: unquote(nameToken.image), exposed: normalizeToken(nameToken), kind: 'cte', local: columns }
            this.registerLocal(relation)
            frame.ctes.set(relation.exposed, relation)
        }
        const main = allChildNodes(node).find(child => QUERY_NODES.has(child.name))
        return main ? this.processQuery(main, frame) : []
    }

    private renameFromColumnList(list: CstNode, columns: Array<Projected | undefined>): Array<Projected | undefined> {
        return childNodes(list, 'identifier')
            .map(identifier => tokensOf(identifier)[0])
            .filter((token): token is IToken => token !== undefined)
            .map((token, position): Projected | undefined => {
                if (token.image === '') return undefined
                const norm = normalizeToken(token)
                return {
                    name: unquote(token.image),
                    norm,
                    key: localKey(token.startOffset, norm),
                    start: token.startOffset,
                    end: token.endOffset! + 1,
                    origin: columns[position]?.origin,
                }
            })
    }

    private processSelect(node: CstNode, parent: Frame): Array<Projected | undefined> {
        const frame = new Frame(parent)
        const fromClause = childNodes(node, 'fromClause')[0]
        const joinConditions: CstNode[] = []
        if (fromClause) {
            for (const reference of childNodes(fromClause, 'tableReference')) {
                for (const source of childNodes(reference, 'tableSource')) this.addSource(source, frame)
                for (const join of childNodes(reference, 'joinClause')) {
                    for (const source of childNodes(join, 'tableSource')) this.addSource(source, frame)
                    joinConditions.push(...childNodes(join, 'expression'))
                }
            }
        }
        for (const condition of joinConditions) this.walk(condition, frame, false)

        const projection: Array<Projected | undefined> = []
        const selectClause = childNodes(node, 'selectClause')[0]
        const selectList = selectClause ? childNodes(selectClause, 'selectList')[0] : undefined
        if (selectList) {
            for (const item of orderedChildNodes(selectList)) {
                // The grammar nests `*` and `T.*` inside a select item.
                const star = item.name === 'starExpression' ? item : childNodes(item, 'starExpression')[0]
                if (star) {
                    projection.push(...this.expandStar(star, frame))
                } else if (item.name === 'selectItem') {
                    projection.push(this.projectItem(item, frame))
                } else {
                    this.walk(item, frame, false)
                }
            }
        }

        for (const child of orderedChildNodes(node)) {
            if (child.name === 'selectClause') {
                // INTO and other clause parts outside the select list.
                for (const part of allChildNodes(child)) if (part.name !== 'selectList') this.walk(part, frame, false)
                continue
            }
            if (child.name === 'fromClause') continue
            if (QUERY_NODES.has(child.name)) {
                // A UNION/INTERSECT/EXCEPT branch is a sibling query.
                this.processQuery(child, parent)
                continue
            }
            this.walk(child, frame, child.name === 'orderByClause')
        }
        return projection
    }

    private addSource(source: CstNode, frame: Frame): void {
        const alias = aliasToken(childNodes(source, 'aliasOptional')[0])
        const subquery = childNodes(source, 'subquery')[0]
        if (subquery) {
            const query = allChildNodes(subquery).find(child => QUERY_NODES.has(child.name))
            // A derived table sees CTEs and correlation parents, not sibling FROM items.
            const columns = query ? this.processQuery(query, frame.parent ?? new Frame(undefined)) : []
            const relation: Relation = {
                name: alias ? unquote(alias.image) : '',
                exposed: alias ? normalizeToken(alias) : '',
                kind: 'derived_table',
                local: columns,
            }
            this.registerLocal(relation)
            frame.sources.push(relation)
            return
        }
        const tableName = childNodes(source, 'tableName')[0]
        const parts = identifierTokens(tableName ? childNodes(tableName, 'qualifiedName')[0] ?? tableName : undefined)
        const nameToken = parts[parts.length - 1]
        if (!nameToken || nameToken.image === '') {
            frame.sources.push({ name: alias ? unquote(alias.image) : '', exposed: alias ? normalizeToken(alias) : '', kind: 'table', physical: { database: null, schema: null, table: '' } })
            return
        }
        const exposed = alias ? normalizeToken(alias) : normalizeToken(nameToken)
        const norm = normalizeToken(nameToken)
        if (parts.length === 1) {
            const cte = findCte(frame, norm)
            if (cte) {
                frame.sources.push({ ...cte, exposed })
                return
            }
            const local = this.scriptTables.get(norm)
            if (local) {
                frame.sources.push({ ...local, exposed })
                return
            }
        }
        const database = parts.length >= 3 ? unquote(parts[parts.length - 3].image) : undefined
        const schema = parts.length >= 2 ? unquote(parts[parts.length - 2].image) : undefined
        const table = unquote(nameToken.image)
        this.physicalTables.push({ database, schema, name: table })
        const entry = this.lookup?.(database, schema, table)
        frame.sources.push({
            name: entry?.name ?? table,
            exposed,
            kind: 'table',
            physical: {
                database: entry?.database ?? database ?? null,
                schema: entry?.schema ?? schema ?? null,
                table: entry?.name ?? table,
            },
            physicalColumns: entry && entry.columns.length > 0 ? entry.columns : undefined,
            physicalTypes: entry && entry.columns.length > 0 ? entry.columnTypes : undefined,
        })
    }

    /** Walks a CST subtree; returns the identity key when it is one column reference. */
    private walk(node: CstNode, frame: Frame, orderBy: boolean): string | undefined {
        if (node.name === 'columnReference') return this.resolveReference(node, frame, orderBy)
        if (QUERY_NODES.has(node.name)) {
            // A nested query in an expression is correlated with the current query.
            this.processQuery(node, frame)
            return undefined
        }
        let single: string | undefined
        let count = 0
        for (const child of allChildNodes(node)) {
            const key = this.walk(child, frame, orderBy)
            count++
            if (count === 1) single = key
        }
        return count === 1 && !hasOwnTokens(node) ? single : undefined
    }

    private resolveReference(node: CstNode, frame: Frame, orderBy: boolean): string | undefined {
        const parts = childNodes(node, 'netezzaRelaxedName')
            .map(part => tokensOf(part)[0])
            .filter((token): token is IToken => token !== undefined)
            .sort((left, right) => left.startOffset - right.startOffset)
        const nameToken = parts[parts.length - 1]
        if (!nameToken || nameToken.image === '') return undefined
        const name = unquote(nameToken.image)
        const norm = normalizeToken(nameToken)
        const start = nameToken.startOffset
        const end = nameToken.endOffset! + 1
        let key: string
        if (parts.length >= 2) {
            const relation = findRelation(frame, normalizeToken(parts[parts.length - 2]))
            key = (relation && this.resolveIn(relation, norm, name)) ?? this.unresolved(name, start)
        } else if (orderBy && frame.outputAliases.has(norm)) {
            key = outputAliasKey(frame.outputAliases.get(norm)!)
        } else {
            key = this.resolveUnqualified(frame, norm, name, start)
        }
        this.occurrences.push({ start, end, key, isDefinition: false })
        return key
    }

    private resolveUnqualified(frame: Frame, norm: string, name: string, start: number): string {
        for (let current: Frame | undefined = frame; current; current = current.parent) {
            if (current.sources.length === 0) continue
            const matches = current.sources.filter(relation => provides(relation, norm))
            const unknown = current.sources.filter(relation => !hasKnownColumns(relation)).length
            if (matches.length > 1) {
                const key = `A|${start}`
                const candidates: string[] = []
                for (const relation of matches)
                    if (!candidates.some(known => known.toUpperCase() === relation.name.toUpperCase())) candidates.push(relation.name)
                this.identities.set(key, { name, status: 'ambiguous', candidates })
                return key
            }
            if (matches.length === 1)
                return unknown === 0 ? this.resolveIn(matches[0], norm, name) ?? this.unresolved(name, start) : this.unresolved(name, start)
            if (unknown > 0)
                return unknown === 1 && current.sources.length === 1
                    ? this.resolveIn(current.sources[0], norm, name) ?? this.unresolved(name, start)
                    : this.unresolved(name, start)
        }
        return this.unresolved(name, start)
    }

    private resolveIn(relation: Relation, norm: string, name: string): string | undefined {
        if (relation.physical) {
            // A source whose name is unknown (an unfinished `FROM db.schema.`)
            // has no catalog column to point at.
            if (!relation.physical.table) return undefined
            let columnName = name
            let type: string | undefined
            if (relation.physicalColumns) {
                const index = relation.physicalColumns.findIndex(column => column.toUpperCase() === norm)
                if (index < 0) return undefined
                columnName = relation.physicalColumns[index]
                type = relation.physicalTypes?.[index]
            }
            const catalog: SqlCatalogColumn = { ...relation.physical, relation: relation.physical.table, column: columnName }
            delete (catalog as { table?: string }).table
            if (type) catalog.type = type
            const key = physicalKey(catalog)
            if (!this.identities.has(key))
                this.identities.set(key, { name: columnName, status: 'resolved', relationKind: 'table', relation: relation.physical.table, catalog, candidates: [] })
            return key
        }
        return relation.local?.find(column => column?.norm === norm)?.key
    }

    private projectItem(item: CstNode, frame: Frame): Projected | undefined {
        const expression = allChildNodes(item).find(child => child.name !== 'aliasOptional')
        const key = expression ? this.walk(expression, frame, false) : undefined
        const info = key ? this.identities.get(key) : undefined
        const origin = info ? info.catalog ?? info.origin : undefined
        const alias = aliasToken(childNodes(item, 'aliasOptional')[0])
        if (alias?.image === '') return undefined
        if (alias) {
            const norm = normalizeToken(alias)
            const projected: Projected = {
                name: unquote(alias.image), norm, key: localKey(alias.startOffset, norm),
                start: alias.startOffset, end: alias.endOffset! + 1, origin,
            }
            const aliasKey = outputAliasKey(projected)
            if (!this.identities.has(aliasKey)) {
                this.identities.set(aliasKey, {
                    name: projected.name, status: 'resolved', relationKind: 'output_alias',
                    definition: [projected.start, projected.end], origin, candidates: [],
                })
                this.occurrences.push({ start: projected.start, end: projected.end, key: aliasKey, isDefinition: true })
            }
            frame.outputAliases.set(norm, projected)
            return projected
        }
        const reference = expression && singleColumnReference(expression)
        if (!reference) return undefined
        const parts = childNodes(reference, 'netezzaRelaxedName').map(part => tokensOf(part)[0]).filter((token): token is IToken => token !== undefined)
            .sort((left, right) => left.startOffset - right.startOffset)
        const nameToken = parts[parts.length - 1]
        if (!nameToken || nameToken.image === '') return undefined
        const norm = normalizeToken(nameToken)
        return {
            name: unquote(nameToken.image), norm, key: localKey(nameToken.startOffset, norm),
            start: nameToken.startOffset, end: nameToken.endOffset! + 1, origin,
        }
    }

    private expandStar(star: CstNode, frame: Frame): Array<Projected | undefined> {
        const tokens = tokensOf(star).sort((left, right) => left.startOffset - right.startOffset)
        const multiply = tokens.find(token => token.image === '*')
        if (!multiply) return []
        const qualifierToken = tokens.find(token => token.tokenType.name === 'Identifier' || token.tokenType.name === 'QuotedIdentifier')
            ?? tokensOf(childNodes(star, 'identifier')[0])[0]
        const qualifier = qualifierToken ? normalizeToken(qualifierToken) : undefined
        const start = multiply.startOffset
        const end = multiply.endOffset! + 1
        const projection: Array<Projected | undefined> = []
        for (const relation of frame.sources) {
            if (qualifier && relation.exposed !== qualifier) continue
            if (relation.physical) {
                const types = relation.physicalTypes
                for (const [index, column] of (relation.physicalColumns ?? []).entries()) {
                    const norm = column.toUpperCase()
                    const origin: SqlCatalogColumn = { database: relation.physical.database, schema: relation.physical.schema, relation: relation.physical.table, column }
                    if (types?.[index]) origin.type = types[index]
                    projection.push({ name: column, norm, key: `L|${start}|${relation.exposed}|${norm}`, start, end, origin })
                }
                continue
            }
            for (const column of relation.local ?? []) {
                if (!column) continue
                projection.push({ ...column, key: `L|${start}|${relation.exposed}|${column.norm}`, start, end })
            }
        }
        return projection
    }

    private registerLocal(relation: Relation): void {
        for (const column of relation.local ?? []) {
            if (!column || this.identities.has(column.key)) continue
            this.identities.set(column.key, {
                name: column.name, status: 'resolved', relationKind: relation.kind, relation: relation.name,
                definition: [column.start, column.end], origin: column.origin, candidates: [],
            })
            this.occurrences.push({ start: column.start, end: column.end, key: column.key, isDefinition: true })
        }
    }

    private unresolved(name: string, start: number): string {
        const key = `U|${start}`
        this.identities.set(key, { name, status: 'unresolved', candidates: [] })
        return key
    }
}

function provides(relation: Relation, norm: string): boolean {
    if (relation.physical) return relation.physicalColumns?.some(column => column.toUpperCase() === norm) === true
    return relation.local?.some(column => column?.norm === norm) === true
}

function hasKnownColumns(relation: Relation): boolean {
    return !relation.physical || relation.physicalColumns !== undefined
}

function findRelation(frame: Frame, exposed: string): Relation | undefined {
    for (let current: Frame | undefined = frame; current; current = current.parent) {
        for (let index = current.sources.length - 1; index >= 0; index--)
            if (current.sources[index].exposed === exposed) return current.sources[index]
    }
    return undefined
}

function findCte(frame: Frame, norm: string): Relation | undefined {
    for (let current: Frame | undefined = frame; current; current = current.parent) {
        const cte = current.ctes.get(norm)
        if (cte) return cte
    }
    return undefined
}

function singleColumnReference(node: CstNode): CstNode | undefined {
    if (node.name === 'columnReference') return node
    if (hasOwnTokens(node)) return undefined
    const children = allChildNodes(node)
    return children.length === 1 ? singleColumnReference(children[0]) : undefined
}

function aliasToken(aliasOptional: CstNode | undefined): IToken | undefined {
    const alias = aliasOptional ? childNodes(aliasOptional, 'alias')[0] : undefined
    if (!alias) return undefined
    return tokensOf(alias)[0] ?? tokensOf(childNodes(alias, 'netezzaRelaxedName')[0])[0]
}

function identifierTokens(qualifiedName: CstNode | undefined): IToken[] {
    if (!qualifiedName) return []
    const identifiers = childNodes(qualifiedName, 'identifier')
    const tokens = identifiers.length > 0
        ? identifiers.map(identifier => tokensOf(identifier)[0]).filter((token): token is IToken => token !== undefined)
        : tokensOf(qualifiedName).filter(token => token.image !== '.')
    return tokens.sort((left, right) => left.startOffset - right.startOffset)
}

function childNodes(node: CstNode | undefined, name: string): CstNode[] {
    const value = node?.children?.[name]
    return Array.isArray(value) ? value.filter(isCstNode) : []
}

function allChildNodes(node: CstNode): CstNode[] {
    const nodes: CstNode[] = []
    for (const value of Object.values(node.children ?? {}))
        if (Array.isArray(value)) for (const child of value) if (isCstNode(child)) nodes.push(child)
    return nodes
}

function orderedChildNodes(node: CstNode): CstNode[] {
    return allChildNodes(node).sort((left, right) => firstOffset(left) - firstOffset(right))
}

function firstOffset(node: CstNode): number {
    let best = Number.MAX_SAFE_INTEGER
    for (const value of Object.values(node.children ?? {})) {
        if (!Array.isArray(value)) continue
        for (const child of value) {
            const offset = isToken(child) ? child.startOffset : isCstNode(child) ? firstOffset(child) : Number.MAX_SAFE_INTEGER
            if (offset < best) best = offset
        }
    }
    return best
}

function tokensOf(node: CstNode | undefined): IToken[] {
    if (!node) return []
    const tokens: IToken[] = []
    for (const value of Object.values(node.children ?? {}))
        if (Array.isArray(value)) for (const child of value) if (isToken(child)) tokens.push(child)
    return tokens
}

function hasOwnTokens(node: CstNode): boolean {
    return tokensOf(node).length > 0
}

function unquote(image: string): string {
    return image.length >= 2 && image.startsWith('"') && image.endsWith('"') ? image.slice(1, -1).replace(/""/g, '"') : image
}

/** Unquoted identifiers fold to upper case; quoted identifiers keep their spelling. */
function normalizeToken(token: IToken): string {
    return token.image.startsWith('"') ? unquote(token.image) : token.image.toUpperCase()
}

function localKey(start: number, norm: string): string {
    return `L|${start}|${norm}`
}

function outputAliasKey(alias: Projected): string {
    return `O|${alias.start}|${alias.norm}`
}

function physicalKey(column: SqlCatalogColumn): string {
    return ['P', column.database ?? '', column.schema ?? '', column.relation, column.column].map(part => part.toUpperCase()).join('|')
}

function collect(sql: string, lookup: SqlColumnCatalogLookup | undefined, parseResult?: Pick<NetezzaSqlParseResult, 'cst'>): { collector: ColumnIdentityCollector; cst: CstNode } | undefined {
    const cst = parseResult?.cst ?? parseNetezzaSqlForAuthoringRecovery(sql)
    if (!cst) return undefined
    const collector = new ColumnIdentityCollector(lookup)
    collector.collect(cst)
    return { collector, cst }
}

/** Physical tables referenced by the document, so hosts can prefetch metadata. */
export function collectSqlPhysicalTableReferences(sql: string, parseResult?: Pick<NetezzaSqlParseResult, 'cst'>): SqlPhysicalTableReference[] {
    return SqlColumnIdentityAnalysis.analyze(sql, undefined, parseResult)?.physicalTables ?? []
}

/**
 * Column identities of one document text. Built once, it answers any number
 * of offsets for Definition, References, Hover, catalog targets and Rename
 * without parsing again; it is immutable and owned by the caller.
 */
export class SqlColumnIdentityAnalysis {
    private constructor(private readonly collector: ColumnIdentityCollector, private readonly cst: CstNode) {}

    /** Undefined when the text cannot be analyzed, even through authoring recovery. */
    static analyze(
        sql: string,
        lookup?: SqlColumnCatalogLookup,
        parseResult?: Pick<NetezzaSqlParseResult, 'cst'>,
    ): SqlColumnIdentityAnalysis | undefined {
        try {
            const collected = collect(sql, lookup, parseResult)
            return collected ? new SqlColumnIdentityAnalysis(collected.collector, collected.cst) : undefined
        } catch {
            // Authoring must stay available while SQL is incomplete.
            return undefined
        }
    }

    get physicalTables(): SqlPhysicalTableReference[] {
        return this.collector.physicalTables
    }

    /**
     * The (possibly recovered) parse this analysis read, so the same text can
     * be resolved again with metadata without parsing it again.
     */
    get parseResult(): Pick<NetezzaSqlParseResult, 'cst'> {
        return { cst: this.cst }
    }

    /** The identity at a UTF-16 `offset`; undefined when the offset is not on a column. */
    identityAt(offset: number): SqlColumnIdentity | undefined {
        const key = this.keyAt(offset)
        return key === undefined ? undefined : this.identity(key)
    }

    /** Identity key at an offset, for {@link identity} and rename planning. */
    keyAt(offset: number): string | undefined {
        // A projection like `SELECT ID FROM T` is both a reference and a
        // definition; the reference wins. Among definitions, a relation column
        // wins over the output-alias view of the same alias.
        const rank = (occurrence: Occurrence) => (occurrence.isDefinition ? 2 : 0) + (occurrence.key.startsWith('O|') ? 1 : 0)
        const occurrences = this.collector.occurrences
        const occurrence = occurrences
            .filter(candidate => candidate.start <= offset && offset < candidate.end)
            .sort((left, right) => rank(left) - rank(right))[0]
            ?? occurrences.filter(candidate => candidate.end === offset).sort((left, right) => rank(left) - rank(right))[0]
        return occurrence && this.collector.identities.has(occurrence.key) ? occurrence.key : undefined
    }

    identity(key: string): SqlColumnIdentity | undefined {
        const info = this.collector.identities.get(key)
        if (!info) return undefined
        return {
            name: info.name,
            status: info.status,
            relationKind: info.relationKind,
            relation: info.relation,
            definition: info.definition ? { startOffset: info.definition[0], endOffset: info.definition[1], isDefinition: true } : undefined,
            catalog: info.catalog,
            origin: info.origin,
            candidates: info.candidates,
            occurrences: this.occurrencesOf(key),
        }
    }

    /**
     * True when another identity also occurs at exactly [start, end): as a
     * reference, or as a definition other than the output-alias view of the
     * same alias token.
     */
    hasOtherOccurrenceAt(key: string, startOffset: number, endOffset: number): boolean {
        return this.collector.occurrences.some(occurrence => occurrence.key !== key
            && occurrence.start === startOffset && occurrence.end === endOffset
            && (!occurrence.isDefinition || !occurrence.key.startsWith('O|')))
    }

    /**
     * Identity partition of every column occurrence: one signature per
     * identity with its status and occurrence ranges mapped by `mapRange`.
     * Two texts resolve their columns the same way when their partitions match.
     */
    partition(mapRange: (startOffset: number, endOffset: number) => [number, number] = (start, end) => [start, end]): string[] {
        const groups = new Map<string, Set<string>>()
        for (const occurrence of this.collector.occurrences) {
            const [start, end] = mapRange(occurrence.start, occurrence.end)
            let group = groups.get(occurrence.key)
            if (!group) groups.set(occurrence.key, group = new Set())
            group.add(`${start}:${end}:${occurrence.isDefinition ? 'd' : 'r'}`)
        }
        return [...groups.entries()]
            .map(([key, ranges]) => `${this.collector.identities.get(key)?.status ?? '?'}|${[...ranges].sort().join(',')}`)
            .sort()
    }

    private occurrencesOf(key: string): SqlColumnOccurrence[] {
        const seen = new Set<string>()
        return this.collector.occurrences
            .filter(candidate => candidate.key === key)
            .sort((left, right) => left.start - right.start || Number(left.isDefinition) - Number(right.isDefinition))
            .filter(candidate => {
                const id = `${candidate.start}:${candidate.end}:${candidate.isDefinition}`
                if (seen.has(id)) return false
                seen.add(id)
                return true
            })
            .map(candidate => ({ startOffset: candidate.start, endOffset: candidate.end, isDefinition: candidate.isDefinition }))
    }
}

/** Resolves the column at a UTF-16 `offset`; undefined when the offset is not on a column. */
export function resolveSqlColumnIdentity(
    sql: string,
    offset: number,
    lookup?: SqlColumnCatalogLookup,
    parseResult?: Pick<NetezzaSqlParseResult, 'cst'>,
): SqlColumnIdentity | undefined {
    return SqlColumnIdentityAnalysis.analyze(sql, lookup, parseResult)?.identityAt(offset)
}
