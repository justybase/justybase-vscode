import { CstNode, type IToken } from 'chevrotain'
import { getOrderedCstTokens, isCstNode } from './referenceTokenCollector'
import { parseNetezzaSqlStatements } from '../parser/runtime'

export type SqlSemanticIdentifierRole = 'column' | 'table' | 'schema' | 'database' | 'alias'

export interface SqlSemanticIdentifierOccurrence {
    role: SqlSemanticIdentifierRole
    startOffset: number
    endOffset: number
}

function identifierTokens(node: CstNode): { identifiers: IToken[]; dots: IToken[] } {
    const tokens = getOrderedCstTokens(node)
    return {
        identifiers: tokens.filter(token => token.tokenType.name === 'Identifier'),
        dots: tokens.filter(token => token.tokenType.name === 'Dot'),
    }
}

function addRole(roles: SqlSemanticIdentifierOccurrence[], token: IToken, role: SqlSemanticIdentifierRole): void {
    if (token.startOffset === undefined) return
    roles.push({ role, startOffset: token.startOffset, endOffset: token.endOffset ?? token.startOffset + token.image.length })
}

function addQualifiedTableRoles(node: CstNode, roles: SqlSemanticIdentifierOccurrence[]): void {
    const qualifiedName = node.children.qualifiedName?.find(isCstNode)
    if (!qualifiedName) return
    const { identifiers, dots } = identifierTokens(qualifiedName)
    if (identifiers.length === 0) return
    if (identifiers.length === 1) {
        addRole(roles, identifiers[0]!, 'table')
        return
    }
    // Netezza supports TABLE, SCHEMA.TABLE, DB.SCHEMA.TABLE and DB..TABLE.
    // Two identifiers plus two dots is the unqualified-schema form DB..TABLE.
    if (identifiers.length === 2 && dots.length === 2) {
        addRole(roles, identifiers[0]!, 'database')
        addRole(roles, identifiers[1]!, 'table')
        return
    }
    if (identifiers.length === 2) {
        addRole(roles, identifiers[0]!, 'schema')
        addRole(roles, identifiers[1]!, 'table')
        return
    }
    addRole(roles, identifiers[identifiers.length - 3]!, 'database')
    addRole(roles, identifiers[identifiers.length - 2]!, 'schema')
    addRole(roles, identifiers[identifiers.length - 1]!, 'table')
}

function addColumnReferenceRoles(node: CstNode, roles: SqlSemanticIdentifierOccurrence[]): void {
    const { identifiers } = identifierTokens(node)
    if (identifiers.length === 0) return
    if (identifiers.length === 1) {
        addRole(roles, identifiers[0]!, 'column')
        return
    }
    // A two-part column reference is normally alias.column. Longer forms are
    // handled for dialects that allow schema.table.column notation.
    if (identifiers.length === 2) {
        addRole(roles, identifiers[0]!, 'alias')
        addRole(roles, identifiers[1]!, 'column')
        return
    }
    const column = identifiers[identifiers.length - 1]!
    addRole(roles, column, 'column')
    const table = identifiers[identifiers.length - 2]!
    addRole(roles, table, 'table')
    if (identifiers.length >= 3) addRole(roles, identifiers[identifiers.length - 3]!, 'schema')
    if (identifiers.length >= 4) addRole(roles, identifiers[identifiers.length - 4]!, 'database')
}

function visit(node: CstNode, roles: SqlSemanticIdentifierOccurrence[]): void {
    if (node.name === 'tableName') addQualifiedTableRoles(node, roles)
    if (node.name === 'columnReference') addColumnReferenceRoles(node, roles)
    for (const value of Object.values(node.children)) {
        if (!Array.isArray(value)) continue
        for (const child of value) if (isCstNode(child)) visit(child, roles)
    }
}

/** Collects parser-backed identifier roles for web/standalone Monaco tokens. */
export function collectSqlSemanticIdentifierRoles(sql: string): SqlSemanticIdentifierOccurrence[] {
    const parsed = parseNetezzaSqlStatements({ sql })
    if (parsed.lexResult.errors.length > 0 || !parsed.cst || parsed.actionableParserErrors.length > 0) return []
    const roles: SqlSemanticIdentifierOccurrence[] = []
    visit(parsed.cst, roles)
    return roles.sort((left, right) => left.startOffset - right.startOffset)
}
