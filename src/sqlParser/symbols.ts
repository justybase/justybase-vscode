import { CstNode, type IToken } from 'chevrotain'
import type { DatabaseKind } from '../contracts/database'
import { getOrderedReferenceTokens, isCstNode, isToken } from '../providers/parsers/scope'
import { parseSqlStatements, type SqlStatementsParseResult } from './parsingRuntime'

export type SqlRenameSymbolKind = 'cte' | 'table_alias' | 'table' | 'local_variable'
type SqlRenameSymbolRole = 'definition' | 'reference'

export interface SqlRenameOccurrence {
    kind: SqlRenameSymbolKind
    role: SqlRenameSymbolRole
    startOffset: number
    endOffset: number
    text: string
}

export interface SqlRenameResolution {
    kind: SqlRenameSymbolKind
    name: string
    target: SqlRenameOccurrence
    occurrences: SqlRenameOccurrence[]
}

export interface SqlSymbolUsage {
    kind: SqlRenameSymbolKind
    name: string
    occurrences: SqlRenameOccurrence[]
}

interface SqlSymbolDefinition {
    id: string
    kind: SqlRenameSymbolKind
    normalizedName: string
    displayName: string
}

interface SqlRenameOccurrenceInternal extends SqlRenameOccurrence {
    symbolId: string
}

class SqlSymbolCollector {
    private readonly cteScopes: Array<Map<string, SqlSymbolDefinition>> = [new Map()]
    private readonly aliasScopes: Array<Map<string, SqlSymbolDefinition>> = []
    private readonly localVariableScopes: Array<Map<string, SqlSymbolDefinition>> = []
    private readonly createdTables = new Map<string, SqlSymbolDefinition>()
    private readonly unresolvedAliasQualifiers: IToken[][] = []
    private readonly definitions = new Map<string, SqlSymbolDefinition>()
    private readonly occurrences: SqlRenameOccurrenceInternal[] = []
    private nextSymbolId = 1

    collect(root: CstNode): void {
        this.visitNode(root)
    }

    getOccurrences(): SqlRenameOccurrenceInternal[] {
        return [...this.occurrences].sort((a, b) => a.startOffset - b.startOffset)
    }

    getSymbolDisplayName(symbolId: string): string | undefined {
        return this.definitions.get(symbolId)?.displayName
    }

    getDefinitions(): SqlSymbolDefinition[] {
        return Array.from(this.definitions.values())
    }

    private visitNode(node: CstNode): void {
        switch (node.name) {
            case 'withStatement':
                this.visitWithStatement(node)
                return
            case 'withAnyStatement':
                this.visitWithAnyStatement(node)
                return
            case 'insertWithClause':
                this.visitInsertWithClause(node)
                return
            case 'cteDefinition':
                this.visitCteDefinition(node)
                return
            case 'insertCteDefinition':
                this.visitInsertCteDefinition(node)
                return
            case 'selectStatement':
                this.visitSelectStatement(node)
                return
            case 'createProcedureStatement':
                if (this.getChildNodes(node, 'oracleAnonymousBlock').length > 0) {
                    this.visitOracleRoutine(node)
                    return
                }
                this.visitChildren(node)
                return
            case 'oraclePackageUnit':
                this.visitChildren(node)
                return
            case 'oraclePackageRoutine':
                this.visitOracleRoutine(node)
                return
            case 'oracleAnonymousBlock':
                this.visitOracleAnonymousBlock(node)
                return
            case 'oracleVariableDeclaration':
                this.visitOracleVariableDeclaration(node)
                return
            case 'oracleProcedureArgumentWithMode':
            case 'oracleProcedureArgumentWithoutMode':
                this.visitOracleProcedureArgument(node)
                return
            case 'oracleForStatement':
                this.visitOracleForStatement(node)
                return
            case 'createTableStatement':
                this.visitCreateTableStatement(node)
                return
            case 'updateStatement':
                this.visitUpdateStatement(node)
                return
            case 'deleteStatement':
                this.visitDeleteStatement(node)
                return
            case 'mergeStatement':
                this.visitMergeStatement(node)
                return
            case 'dropStatement':
                this.visitDropStatement(node)
                return
            case 'truncateStatement':
                this.visitTruncateStatement(node)
                return
            case 'tableSource':
                this.visitTableSource(node)
                return
            case 'columnReference':
                this.visitColumnReference(node)
                return
            case 'starExpression':
                this.visitStarExpression(node)
                return
            default:
                this.visitChildren(node)
        }
    }

    private visitChildren(node: CstNode): void {
        const children = node.children ?? {}
        for (const value of Object.values(children)) {
            if (!Array.isArray(value)) continue
            value.forEach(child => {
                if (isCstNode(child)) {
                    this.visitNode(child)
                }
            })
        }
    }

    private visitWithStatement(node: CstNode): void {
        this.pushCteScope()
        try {
            this.getChildNodes(node, 'cteDefinition').forEach(definition => this.visitNode(definition))
            const selectStatement = this.getChildNodes(node, 'selectStatement')[0]
            if (selectStatement) {
                this.visitNode(selectStatement)
            }
        } finally {
            this.popCteScope()
        }
    }

    private visitWithAnyStatement(node: CstNode): void {
        this.pushCteScope()
        try {
            this.getChildNodes(node, 'cteDefinition').forEach(definition => this.visitNode(definition))

            const mainStatement =
                this.getChildNodes(node, 'selectStatement')[0]
                ?? this.getChildNodes(node, 'insertStatement')[0]
                ?? this.getChildNodes(node, 'updateStatement')[0]
                ?? this.getChildNodes(node, 'deleteStatement')[0]

            if (mainStatement) {
                this.visitNode(mainStatement)
            }
        } finally {
            this.popCteScope()
        }
    }

    private visitInsertWithClause(node: CstNode): void {
        this.pushCteScope()
        try {
            this.getChildNodes(node, 'insertCteDefinition').forEach(definition => this.visitNode(definition))
            const selectStatement = this.getChildNodes(node, 'selectStatement')[0]
            if (selectStatement) {
                this.visitNode(selectStatement)
            }
        } finally {
            this.popCteScope()
        }
    }

    private visitCteDefinition(node: CstNode): void {
        const cteToken = this.getTokens(node, 'Identifier')[0]
        if (cteToken) {
            const cteSymbol = this.createDefinition('cte', cteToken)
            this.getCurrentCteScope().set(cteSymbol.normalizedName, cteSymbol)
        }

        const nestedQuery = this.getChildNodes(node, 'withStatement')[0] ?? this.getChildNodes(node, 'selectStatement')[0]
        if (nestedQuery) {
            this.visitNode(nestedQuery)
        }
    }

    private visitInsertCteDefinition(node: CstNode): void {
        const cteToken = this.getTokens(node, 'Identifier')[0]
        if (cteToken) {
            const cteSymbol = this.createDefinition('cte', cteToken)
            this.getCurrentCteScope().set(cteSymbol.normalizedName, cteSymbol)
        }

        const nestedQuery = this.getChildNodes(node, 'withStatement')[0] ?? this.getChildNodes(node, 'selectStatement')[0]
        if (nestedQuery) {
            this.visitNode(nestedQuery)
        }
    }

    private visitSelectStatement(node: CstNode): void {
        this.pushAliasScope()
        try {
            this.visitChildren(node)
        } finally {
            this.popAliasScope()
        }
    }

    private visitOracleRoutine(node: CstNode): void {
        this.pushLocalVariableScope()
        try {
            this.visitChildren(node)
        } finally {
            this.popLocalVariableScope()
        }
    }

    private visitOracleAnonymousBlock(node: CstNode): void {
        const ownsScope = this.localVariableScopes.length === 0
        if (ownsScope) {
            this.pushLocalVariableScope()
        }
        try {
            this.visitChildren(node)
        } finally {
            if (ownsScope) {
                this.popLocalVariableScope()
            }
        }
    }

    private visitOracleVariableDeclaration(node: CstNode): void {
        const identifier = this.getChildNodes(node, 'identifier')[0]
        const token = this.getFirstTokenFromCst(identifier)
        if (token) {
            const symbol = this.createDefinition('local_variable', token)
            this.getCurrentLocalVariableScope()?.set(symbol.normalizedName, symbol)
        }
        this.visitChildren(node)
    }

    private visitOracleProcedureArgument(node: CstNode): void {
        const identifier = this.getChildNodes(node, 'identifier')[0]
        const token = this.getFirstTokenFromCst(identifier)
        if (token) {
            const symbol = this.createDefinition('local_variable', token)
            this.getCurrentLocalVariableScope()?.set(symbol.normalizedName, symbol)
        }
        this.visitChildren(node)
    }

    private visitOracleForStatement(node: CstNode): void {
        const identifier = this.getChildNodes(node, 'identifier')[0]
        const token = this.getFirstTokenFromCst(identifier)
        if (token) {
            const symbol = this.createDefinition('local_variable', token)
            this.getCurrentLocalVariableScope()?.set(symbol.normalizedName, symbol)
        }
        this.visitChildren(node)
    }

    private visitCreateTableStatement(node: CstNode): void {
        const tableQName = this.getChildNodes(node, 'qualifiedName')[0]
        this.registerCreatedTableDefinition(tableQName)
        this.visitChildren(node)
    }

    private visitUpdateStatement(node: CstNode): void {
        this.pushAliasScope()
        try {
            this.registerTableNameReference(this.getChildNodes(node, 'tableName')[0])
            const aliasOptional = this.getChildNodes(node, 'aliasOptional')[0]
            this.registerAliasDefinition(aliasOptional)
            this.visitChildren(node)
        } finally {
            this.popAliasScope()
        }
    }

    private visitDeleteStatement(node: CstNode): void {
        this.pushAliasScope()
        try {
            this.registerTableNameReference(this.getChildNodes(node, 'tableName')[0])
            const aliasOptional = this.getChildNodes(node, 'aliasOptional')[0]
            this.registerAliasDefinition(aliasOptional)
            this.visitChildren(node)
        } finally {
            this.popAliasScope()
        }
    }

    private visitMergeStatement(node: CstNode): void {
        this.pushAliasScope()
        try {
            const tokens = this.getOrderedTokens(node)
            if (tokens.length === 0) {
                return
            }

            let scanIndex = tokens.findIndex(token => token.tokenType.name === 'Merge')
            if (scanIndex < 0) {
                return
            }

            scanIndex += 1
            if (tokens[scanIndex]?.tokenType.name === 'Into') {
                scanIndex += 1
            }

            const targetRef = this.parseQualifiedReferenceTokens(tokens, scanIndex)
            if (!targetRef) {
                return
            }

            this.registerMergeTableReference(targetRef.relationToken, targetRef.identifierCount)
            const targetAliasResult = this.parseAliasTokenAfterTableRef(tokens, targetRef.nextIndex)
            this.registerAliasDefinitionToken(targetAliasResult.aliasToken)

            const usingIndex = tokens.findIndex(
                (token, index) => index >= targetAliasResult.nextIndex && token.tokenType.name === 'Using'
            )
            if (usingIndex >= 0) {
                const sourceRef = this.parseQualifiedReferenceTokens(tokens, usingIndex + 1)
                if (sourceRef) {
                    this.registerMergeTableReference(sourceRef.relationToken, sourceRef.identifierCount)
                    const sourceAliasResult = this.parseAliasTokenAfterTableRef(tokens, sourceRef.nextIndex)
                    this.registerAliasDefinitionToken(sourceAliasResult.aliasToken)
                }
            }

            this.registerMergeQualifierReferences(tokens)
        } finally {
            this.popAliasScope()
        }
    }

    private visitDropStatement(node: CstNode): void {
        this.getChildNodes(node, 'dropTargetList').forEach(dropTargetListNode => {
            this.getChildNodes(dropTargetListNode, 'dropTarget').forEach(dropTargetNode => {
                const qualifiedNameNode = this.getChildNodes(dropTargetNode, 'qualifiedName')[0]
                this.registerCreatedTableReferenceByQualifiedName(qualifiedNameNode)
            })
        })
        this.visitChildren(node)
    }

    private visitTruncateStatement(node: CstNode): void {
        const qualifiedNameNode = this.getChildNodes(node, 'qualifiedName')[0]
        this.registerCreatedTableReferenceByQualifiedName(qualifiedNameNode)
        this.visitChildren(node)
    }

    private visitTableSource(node: CstNode): void {
        const tableNameNode = this.getChildNodes(node, 'tableName')[0]
        this.registerTableNameReference(tableNameNode)
        this.registerTableNameAsCteReference(tableNameNode)

        const aliasOptional = this.getChildNodes(node, 'aliasOptional')[0]
        this.registerAliasDefinition(aliasOptional)

        this.visitChildren(node)
    }

    private visitColumnReference(node: CstNode): void {
        const tokens = getOrderedReferenceTokens(node)

        if (tokens.length === 2) {
            this.registerQualifierReference(tokens[0])
            return
        }
        if (tokens.length === 1) {
            const localVariable = this.resolveLocalVariable(this.normalizeIdentifier(tokens[0]))
            if (localVariable) {
                this.addReference(localVariable, tokens[0])
            }
        }
    }

    private visitStarExpression(node: CstNode): void {
        const qualifier = this.getTokens(node, 'Identifier')[0]
        if (qualifier) {
            this.registerQualifierReference(qualifier)
        }
    }

    private normalizeIdentifier(token: IToken): string {
        const text = token.image
        if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
            return text.slice(1, -1)
        }
        return text
    }

    private getTokenEndOffset(token: IToken): number {
        const tokenStart = token.startOffset ?? 0
        if (token.endOffset !== undefined) {
            return token.endOffset + 1
        }
        return tokenStart + token.image.length
    }

    private createDefinition(kind: SqlRenameSymbolKind, token: IToken): SqlSymbolDefinition {
        const displayName = this.normalizeIdentifier(token)
        const symbol: SqlSymbolDefinition = {
            id: `${kind}:${this.nextSymbolId++}`,
            kind,
            normalizedName: displayName.toUpperCase(),
            displayName
        }

        this.definitions.set(symbol.id, symbol)
        this.occurrences.push({
            symbolId: symbol.id,
            kind,
            role: 'definition',
            startOffset: token.startOffset ?? 0,
            endOffset: this.getTokenEndOffset(token),
            text: token.image
        })

        return symbol
    }

    private addReference(symbol: SqlSymbolDefinition, token: IToken): void {
        this.occurrences.push({
            symbolId: symbol.id,
            kind: symbol.kind,
            role: 'reference',
            startOffset: token.startOffset ?? 0,
            endOffset: this.getTokenEndOffset(token),
            text: token.image
        })
    }

    private pushAliasScope(): void {
        this.aliasScopes.push(new Map())
        this.unresolvedAliasQualifiers.push([])
    }

    private pushLocalVariableScope(): void {
        this.localVariableScopes.push(new Map())
    }

    private popLocalVariableScope(): void {
        if (this.localVariableScopes.length > 0) {
            this.localVariableScopes.pop()
        }
    }

    private popAliasScope(): void {
        const aliasScope = this.aliasScopes[this.aliasScopes.length - 1]
        const unresolved = this.unresolvedAliasQualifiers[this.unresolvedAliasQualifiers.length - 1]
        if (aliasScope && unresolved) {
            unresolved.forEach(token => {
                const match = aliasScope.get(this.normalizeIdentifier(token).toUpperCase())
                if (match) {
                    this.addReference(match, token)
                }
            })
        }
        if (this.aliasScopes.length > 0) this.aliasScopes.pop()
        if (this.unresolvedAliasQualifiers.length > 0) this.unresolvedAliasQualifiers.pop()
    }

    private pushCteScope(): void {
        this.cteScopes.push(new Map())
    }

    private popCteScope(): void {
        if (this.cteScopes.length > 1) {
            this.cteScopes.pop()
        }
    }

    private getCurrentAliasScope(): Map<string, SqlSymbolDefinition> | undefined {
        return this.aliasScopes[this.aliasScopes.length - 1]
    }

    private getCurrentCteScope(): Map<string, SqlSymbolDefinition> {
        return this.cteScopes[this.cteScopes.length - 1]
    }

    private getCurrentLocalVariableScope(): Map<string, SqlSymbolDefinition> | undefined {
        return this.localVariableScopes[this.localVariableScopes.length - 1]
    }

    private resolveLocalVariable(name: string): SqlSymbolDefinition | undefined {
        const upperName = name.toUpperCase()
        for (let index = this.localVariableScopes.length - 1; index >= 0; index--) {
            const match = this.localVariableScopes[index].get(upperName)
            if (match) {
                return match
            }
        }
        return undefined
    }

    private resolveAlias(name: string): SqlSymbolDefinition | undefined {
        const upperName = name.toUpperCase()
        for (let i = this.aliasScopes.length - 1; i >= 0; i--) {
            const match = this.aliasScopes[i].get(upperName)
            if (match) {
                return match
            }
        }
        return undefined
    }

    private resolveCte(name: string): SqlSymbolDefinition | undefined {
        const upperName = name.toUpperCase()
        for (let i = this.cteScopes.length - 1; i >= 0; i--) {
            const match = this.cteScopes[i].get(upperName)
            if (match) {
                return match
            }
        }
        return undefined
    }

    private resolveCreatedTable(name: string): SqlSymbolDefinition | undefined {
        return this.createdTables.get(name.toUpperCase())
    }

    private getChildNodes(node: CstNode, key: string): CstNode[] {
        const value = node.children?.[key]
        if (!Array.isArray(value)) {
            return []
        }
        return value.filter((child): child is CstNode => isCstNode(child))
    }

    private getTokens(node: CstNode, key: string): IToken[] {
        const value = node.children?.[key]
        if (!Array.isArray(value)) {
            return []
        }
        return value.filter((child): child is IToken => isToken(child))
    }

    private getOrderedTokens(node: CstNode): IToken[] {
        const tokens: IToken[] = []

        const visit = (current: CstNode): void => {
            const children = current.children ?? {}
            for (const value of Object.values(children)) {
                if (!Array.isArray(value)) {
                    continue
                }

                value.forEach(child => {
                    if (isToken(child)) {
                        tokens.push(child)
                        return
                    }
                    if (isCstNode(child)) {
                        visit(child)
                    }
                })
            }
        }

        visit(node)
        return tokens.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))
    }

    private getFirstTokenFromCst(node: CstNode | undefined): IToken | undefined {
        if (!node) {
            return undefined
        }

        const children = node.children ?? {}
        for (const value of Object.values(children)) {
            if (!Array.isArray(value)) continue
            for (const child of value) {
                if (isToken(child)) {
                    return child
                }
                if (isCstNode(child)) {
                    const nested = this.getFirstTokenFromCst(child)
                    if (nested) {
                        return nested
                    }
                }
            }
        }

        return undefined
    }

    private getQualifiedNameIdentifierTokensFromQualifiedNameNode(qualifiedNameNode: CstNode | undefined): IToken[] {
        if (!qualifiedNameNode) {
            return []
        }

        const identifierNodes = this.getChildNodes(qualifiedNameNode, 'identifier')
        return identifierNodes
            .map(node => this.getFirstTokenFromCst(node))
            .filter((token): token is IToken => !!token)
    }

    private getQualifiedNameIdentifierTokens(tableNameNode: CstNode): IToken[] {
        const qualifiedNameNode = this.getChildNodes(tableNameNode, 'qualifiedName')[0]
        return this.getQualifiedNameIdentifierTokensFromQualifiedNameNode(qualifiedNameNode)
    }

    private getAliasToken(aliasOptionalNode: CstNode | undefined): IToken | undefined {
        if (!aliasOptionalNode) {
            return undefined
        }
        const aliasNode = this.getChildNodes(aliasOptionalNode, 'alias')[0]
        if (!aliasNode) {
            return undefined
        }
        return this.getFirstTokenFromCst(aliasNode)
    }

    private registerAliasDefinition(aliasOptionalNode: CstNode | undefined): void {
        this.registerAliasDefinitionToken(this.getAliasToken(aliasOptionalNode))
    }

    private registerAliasDefinitionToken(aliasToken: IToken | undefined): void {
        if (!aliasToken) {
            return
        }

        const aliasScope = this.getCurrentAliasScope()
        if (!aliasScope) {
            return
        }

        const normalizedName = this.normalizeIdentifier(aliasToken).toUpperCase()
        if (aliasScope.has(normalizedName)) {
            return
        }

        const symbol = this.createDefinition('table_alias', aliasToken)
        aliasScope.set(symbol.normalizedName, symbol)
    }

    private registerCreatedTableDefinition(qualifiedNameNode: CstNode | undefined): void {
        const identifierTokens = this.getQualifiedNameIdentifierTokensFromQualifiedNameNode(qualifiedNameNode)
        if (identifierTokens.length === 0) {
            return
        }

        const relationToken = identifierTokens[identifierTokens.length - 1]
        const symbol = this.createDefinition('table', relationToken)
        this.createdTables.set(symbol.normalizedName, symbol)
    }

    private registerCreatedTableReferenceByQualifiedName(qualifiedNameNode: CstNode | undefined): void {
        const identifierTokens = this.getQualifiedNameIdentifierTokensFromQualifiedNameNode(qualifiedNameNode)
        if (identifierTokens.length === 0) {
            return
        }

        const relationToken = identifierTokens[identifierTokens.length - 1]
        const symbol = this.resolveCreatedTable(this.normalizeIdentifier(relationToken))
        if (symbol) {
            this.addReference(symbol, relationToken)
        }
    }

    private registerTableNameReference(tableNameNode: CstNode | undefined): void {
        if (!tableNameNode) {
            return
        }
        const qualifiedNameNode = this.getChildNodes(tableNameNode, 'qualifiedName')[0]
        this.registerCreatedTableReferenceByQualifiedName(qualifiedNameNode)
    }

    private registerTableNameAsCteReference(tableNameNode: CstNode | undefined): void {
        if (!tableNameNode) {
            return
        }

        const identifierTokens = this.getQualifiedNameIdentifierTokens(tableNameNode)
        if (identifierTokens.length !== 1) {
            return
        }

        const relationToken = identifierTokens[0]
        const cteSymbol = this.resolveCte(this.normalizeIdentifier(relationToken))
        if (cteSymbol) {
            this.addReference(cteSymbol, relationToken)
        }
    }

    private registerQualifierReference(qualifierToken: IToken): void {
        const qualifierName = this.normalizeIdentifier(qualifierToken)

        const aliasSymbol = this.resolveAlias(qualifierName)
        if (aliasSymbol) {
            this.addReference(aliasSymbol, qualifierToken)
            return
        }

        const cteSymbol = this.resolveCte(qualifierName)
        if (cteSymbol) {
            this.addReference(cteSymbol, qualifierToken)
            return
        }

        const unresolvedScope = this.unresolvedAliasQualifiers[this.unresolvedAliasQualifiers.length - 1]
        if (unresolvedScope) {
            unresolvedScope.push(qualifierToken)
        }
    }

    private registerMergeQualifierReferences(tokens: IToken[]): void {
        for (let index = 0; index < tokens.length - 1; index++) {
            const qualifierToken = tokens[index]
            const nextToken = tokens[index + 1]
            if (!this.isIdentifierTokenName(qualifierToken.tokenType.name) || nextToken.tokenType.name !== 'Dot') {
                continue
            }

            this.registerQualifierReference(qualifierToken)
        }
    }

    private registerMergeTableReference(relationToken: IToken, identifierCount: number): void {
        const relationName = this.normalizeIdentifier(relationToken)
        const createdTable = this.resolveCreatedTable(relationName)
        if (createdTable) {
            this.addReference(createdTable, relationToken)
            return
        }

        if (identifierCount !== 1) {
            return
        }

        const cteSymbol = this.resolveCte(relationName)
        if (cteSymbol) {
            this.addReference(cteSymbol, relationToken)
        }
    }

    private parseQualifiedReferenceTokens(
        tokens: IToken[],
        startIndex: number
    ): { relationToken: IToken; nextIndex: number; identifierCount: number } | undefined {
        const firstToken = tokens[startIndex]
        if (!this.isIdentifierTokenName(firstToken?.tokenType.name)) {
            return undefined
        }

        const identifierTokens: IToken[] = [firstToken]
        let index = startIndex + 1
        while (index < tokens.length && tokens[index].tokenType.name === 'Dot') {
            index += 1

            if (index < tokens.length && tokens[index].tokenType.name === 'Dot') {
                index += 1
            }

            if (!this.isIdentifierTokenName(tokens[index]?.tokenType.name)) {
                break
            }

            identifierTokens.push(tokens[index])
            index += 1
        }

        return {
            relationToken: identifierTokens[identifierTokens.length - 1],
            nextIndex: index,
            identifierCount: identifierTokens.length
        }
    }

    private parseAliasTokenAfterTableRef(
        tokens: IToken[],
        startIndex: number
    ): { aliasToken?: IToken; nextIndex: number } {
        let index = startIndex
        if (tokens[index]?.tokenType.name === 'As') {
            index += 1
        }

        const aliasToken = tokens[index]
        if (!this.isIdentifierTokenName(aliasToken?.tokenType.name) || this.isMergeAliasBoundaryToken(aliasToken)) {
            return { nextIndex: index }
        }

        return {
            aliasToken,
            nextIndex: index + 1
        }
    }

    private isMergeAliasBoundaryToken(token: IToken | undefined): boolean {
        if (!token) {
            return true
        }

        const boundaryTokenNames = new Set([
            'Using',
            'On',
            'When',
            'Where',
            'Set',
            'Values',
            'Join',
            'Inner',
            'Left',
            'Right',
            'Full',
            'Cross',
            'Natural',
            'Group',
            'Order',
            'Having',
            'Limit',
            'Union',
            'Intersect',
            'Except',
            'MinusSet',
            'Semicolon',
            'Comma',
            'RParen'
        ])

        return boundaryTokenNames.has(token.tokenType.name)
    }

    private isIdentifierTokenName(tokenName: string | undefined): boolean {
        return tokenName === 'Identifier' || tokenName === 'QuotedIdentifier'
    }
}

function toExternalOccurrence(occurrence: SqlRenameOccurrenceInternal): SqlRenameOccurrence {
    const { kind, role, startOffset, endOffset, text } = occurrence
    return { kind, role, startOffset, endOffset, text }
}

function collectUsagesFromCollector(collector: SqlSymbolCollector): SqlSymbolUsage[] {
    const occurrences = collector.getOccurrences()
    const definitions = collector.getDefinitions()

    return definitions.map(definition => {
        const symbolOccurrences = occurrences
            .filter(occurrence => occurrence.symbolId === definition.id)
            .map(toExternalOccurrence)
        return {
            kind: definition.kind,
            name: definition.displayName,
            occurrences: symbolOccurrences
        }
    })
}

export function collectSqlSymbolUsagesFromCst(cst: CstNode): SqlSymbolUsage[] {
    const collector = new SqlSymbolCollector()
    collector.collect(cst)
    return collectUsagesFromCollector(collector)
}

export function collectSqlSymbolUsages(sql: string, databaseKind?: DatabaseKind): SqlSymbolUsage[] {
    const parseResult = parseSqlStatements({ sql, databaseKind })
    if (
        parseResult.lexResult.errors.length > 0
        || !parseResult.cst
        || parseResult.actionableParserErrors.length > 0
    ) {
        return []
    }

    return collectSqlSymbolUsagesFromCst(parseResult.cst)
}

export function resolveSqlRenameSymbol(
    sql: string,
    offset: number,
    databaseKind?: DatabaseKind,
    parseResult?: SqlStatementsParseResult
): SqlRenameResolution | undefined {
    if (offset < 0 || offset > sql.length) {
        return undefined
    }

    const resolvedParseResult = parseResult ?? parseSqlStatements({ sql, databaseKind })
    if (
        resolvedParseResult.lexResult.errors.length > 0
        || !resolvedParseResult.cst
        || resolvedParseResult.actionableParserErrors.length > 0
    ) {
        return undefined
    }

    const collector = new SqlSymbolCollector()
    collector.collect(resolvedParseResult.cst)

    const occurrences = collector.getOccurrences()
    const target =
        occurrences.find(occurrence => offset >= occurrence.startOffset && offset < occurrence.endOffset)
        ?? (offset > 0
            ? occurrences.find(occurrence => offset - 1 >= occurrence.startOffset && offset - 1 < occurrence.endOffset)
            : undefined)
    if (!target) {
        return undefined
    }

    const symbolOccurrences = occurrences.filter(occurrence => occurrence.symbolId === target.symbolId)
    if (symbolOccurrences.length === 0) {
        return undefined
    }

    return {
        kind: target.kind,
        name: collector.getSymbolDisplayName(target.symbolId) ?? target.text,
        target: toExternalOccurrence(target),
        occurrences: symbolOccurrences.map(toExternalOccurrence)
    }
}
