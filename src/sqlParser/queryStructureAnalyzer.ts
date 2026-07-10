import { type CstNode, type IToken } from 'chevrotain';
import { SqlParser as StatementParser } from '../sql/sqlParser';
import type { DatabaseKind } from '../contracts/database';
import { parseSqlStatements, resolveSqlParsingRuntime } from './parsingRuntime';

export type SqlStatementKind =
    | 'select'
    | 'insert'
    | 'update'
    | 'delete'
    | 'with_select'
    | 'with_insert'
    | 'with_update'
    | 'with_delete'
    | 'create_temp_table'
    | 'create_table'
    | 'other';

export type QueryFlowNodeKind = 'query' | 'cte' | 'subquery' | 'table' | 'temp_table' | 'view';

export interface SqlTextRange {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
}

export interface ExtractSubqueryCandidate {
    statementIndex: number;
    statementKind: SqlStatementKind;
    statementRange: SqlTextRange;
    subqueryRange: SqlTextRange;
    subqueryBodyRange: SqlTextRange;
    cteInsertionOffset: number;
    cteIndentAnchorOffset: number;
    hasWithClause: boolean;
    existingCteNames: string[];
    suggestedName: string;
}

export interface CteMaterializationCandidate {
    statementIndex: number;
    statementKind: SqlStatementKind;
    cteName: string;
    cteNameRange: SqlTextRange;
    cteDefinitionRange: SqlTextRange;
    cteBodyRange: SqlTextRange;
    withRemovalRange: SqlTextRange;
    tempTableInsertOffset: number;
}

export interface CteBulkMaterializationCandidate {
    statementIndex: number;
    statementKind: SqlStatementKind;
    withClauseRange: SqlTextRange;
    statementRange: SqlTextRange;
    withRootNode: CstNode;
    hasRecursive: boolean;
}

export interface TempTableInlineCandidate {
    statementIndex: number;
    statementKind: SqlStatementKind;
    tempTableName: string;
    tempTableNameRange: SqlTextRange;
    tempTableStatementRange: SqlTextRange;
    tempTableDeletionRange: SqlTextRange;
    queryBodyRange: SqlTextRange;
    nextStatementIndex: number;
    nextStatementKind: SqlStatementKind;
    nextStatementRange: SqlTextRange;
    cteInsertionOffset: number;
    cteIndentAnchorOffset: number;
    nextStatementHasWithClause: boolean;
    nextStatementExistingCteNames: string[];
}

export interface QueryFlowNode extends SqlTextRange {
    id: string;
    kind: QueryFlowNodeKind;
    label: string;
    statementIndex: number;
}

export interface QueryFlowEdge {
    id: string;
    from: string;
    to: string;
    label: string;
}

export interface QueryFlowGraph {
    statementIndex: number;
    statementKind: SqlStatementKind;
    statementRange: SqlTextRange;
    rootNodeId: string;
    nodes: QueryFlowNode[];
    edges: QueryFlowEdge[];
}

export interface SqlQueryStructureAnalysis {
    extractSubqueryCandidates: ExtractSubqueryCandidate[];
    cteMaterializationCandidates: CteMaterializationCandidate[];
    cteBulkMaterializationCandidates: CteBulkMaterializationCandidate[];
    tempTableInlineCandidates: TempTableInlineCandidate[];
    statementFlows: QueryFlowGraph[];
}

interface StatementRecord {
    index: number;
    kind: SqlStatementKind;
    statementNode: CstNode;
    rootNode: CstNode;
    contentRange: SqlTextRange;
    deletionRange: SqlTextRange;
}

interface NamedDefinitionRecord {
    name: string;
    definitionRange: SqlTextRange;
    bodyRange?: SqlTextRange;
    statementIndex: number;
}

interface WithLikeRecord {
    node: CstNode;
    cteDefinitions: CstNode[];
    commaTokens: IToken[];
    mainStatement: CstNode;
    prefixRange: SqlTextRange;
    cteNames: string[];
    cteIndentAnchorOffset: number;
}

interface QualifiedName {
    raw: string;
    shortName: string;
}

interface FlowScopeEntry {
    nodeId: string;
}

class LineIndex {
    private readonly _lineStarts: number[] = [0];

    constructor(private readonly _text: string) {
        for (let i = 0; i < _text.length; i++) {
            if (_text[i] === '\n') {
                this._lineStarts.push(i + 1);
            }
        }
    }

    public offsetToLine(offset: number): number {
        const normalized = Math.min(Math.max(offset, 0), this._text.length);
        let low = 0;
        let high = this._lineStarts.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const midValue = this._lineStarts[mid];
            const nextValue = mid + 1 < this._lineStarts.length ? this._lineStarts[mid + 1] : this._text.length + 1;

            if (normalized >= midValue && normalized < nextValue) {
                return mid;
            }
            if (normalized < midValue) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        return 0;
    }
}

class QueryFlowCollector {
    private readonly _nodes: QueryFlowNode[] = [];
    private readonly _edges: QueryFlowEdge[] = [];
    private readonly _cteScopes: Array<Map<string, FlowScopeEntry>> = [new Map()];
    private readonly _namedRelationNodes = new Map<string, string>();
    private _nextNodeId = 1;

    constructor(
        private readonly _analyzer: SqlQueryStructureAnalyzer,
        private readonly _statement: StatementRecord,
        private readonly _tempTables: ReadonlyMap<string, NamedDefinitionRecord>,
        private readonly _views: ReadonlyMap<string, NamedDefinitionRecord>
    ) {}

    public build(): QueryFlowGraph | undefined {
        if (!this._analyzer.isFlowStatementKind(this._statement.kind)) {
            return undefined;
        }

        const rootNode = this.createNode('query', this._analyzer.getStatementLabel(this._statement), this._statement.contentRange);
        this.visitStatementLikeNode(this._statement.rootNode, rootNode.id);

        return {
            statementIndex: this._statement.index,
            statementKind: this._statement.kind,
            statementRange: this._statement.contentRange,
            rootNodeId: rootNode.id,
            nodes: this._nodes,
            edges: this._edges
        };
    }

    private visitStatementLikeNode(node: CstNode, parentNodeId: string): void {
        switch (node.name) {
            case 'withAnyStatement':
            case 'withStatement':
                this.visitWithLikeNode(node, parentNodeId, 'cteDefinition');
                return;
            case 'selectStatement':
                this.visitSelectStatement(node, parentNodeId);
                return;
            case 'insertStatement':
                this.visitInsertStatement(node, parentNodeId);
                return;
            case 'insertWithClause':
                this.visitWithLikeNode(node, parentNodeId, 'insertCteDefinition');
                return;
            case 'updateStatement':
                this.visitUpdateStatement(node, parentNodeId);
                return;
            case 'deleteStatement':
                this.visitDeleteStatement(node, parentNodeId);
                return;
            default:
                return;
        }
    }

    private visitWithLikeNode(node: CstNode, parentNodeId: string, definitionKey: 'cteDefinition' | 'insertCteDefinition'): void {
        const cteDefinitions = this._analyzer.getChildNodes(node, definitionKey);
        const mainStatement =
            this._analyzer.getChildNodes(node, 'selectStatement')[0]
            ?? this._analyzer.getChildNodes(node, 'insertStatement')[0]
            ?? this._analyzer.getChildNodes(node, 'updateStatement')[0]
            ?? this._analyzer.getChildNodes(node, 'deleteStatement')[0];
        if (!mainStatement) {
            return;
        }

        this.pushCteScope();
        try {
            for (const definition of cteDefinitions) {
                const nameToken = this._analyzer.getDefinitionNameToken(definition);
                const definitionRange = this._analyzer.getNodeRange(definition);
                if (!nameToken || !definitionRange) {
                    continue;
                }

                const cteName = this._analyzer.normalizeIdentifier(nameToken);
                const cteNode = this.createNode('cte', cteName, definitionRange);
                this.registerCte(cteName, cteNode.id);

                const nestedQuery =
                    this._analyzer.getChildNodes(definition, 'withStatement')[0]
                    ?? this._analyzer.getChildNodes(definition, 'selectStatement')[0];
                if (nestedQuery) {
                    this.visitStatementLikeNode(nestedQuery, cteNode.id);
                }
            }

            this.visitStatementLikeNode(mainStatement, parentNodeId);
        } finally {
            this.popCteScope();
        }
    }

    private visitSelectStatement(node: CstNode, parentNodeId: string): void {
        const fromClause = this._analyzer.getChildNodes(node, 'fromClause')[0];
        if (!fromClause) {
            return;
        }

        for (const tableReference of this._analyzer.getChildNodes(fromClause, 'tableReference')) {
            const primarySource = this._analyzer.getChildNodes(tableReference, 'tableSource')[0];
            if (primarySource) {
                this.connectTableSource(primarySource, parentNodeId, 'FROM');
            }

            for (const joinClause of this._analyzer.getChildNodes(tableReference, 'joinClause')) {
                const joinSource = this._analyzer.getChildNodes(joinClause, 'tableSource')[0];
                if (joinSource) {
                    this.connectTableSource(joinSource, parentNodeId, 'JOIN');
                }
            }
        }
    }

    private visitInsertStatement(node: CstNode, parentNodeId: string): void {
        const insertWithClause = this._analyzer.getChildNodes(node, 'insertWithClause')[0];
        if (insertWithClause) {
            this.visitStatementLikeNode(insertWithClause, parentNodeId);
            return;
        }

        const selectStatement = this._analyzer.getChildNodes(node, 'selectStatement')[0];
        if (selectStatement) {
            this.visitSelectStatement(selectStatement, parentNodeId);
        }
    }

    private visitUpdateStatement(node: CstNode, parentNodeId: string): void {
        const targetTable = this._analyzer.getChildNodes(node, 'tableName')[0];
        if (!targetTable) {
            return;
        }

        const relationNodeId = this.connectQualifiedTable(targetTable, parentNodeId, 'TARGET');
        const whereClause = this._analyzer.getChildNodes(node, 'whereClause')[0];
        if (whereClause && relationNodeId) {
            this.connectExpressionSubqueries(whereClause, parentNodeId, 'FILTER');
        }
    }

    private visitDeleteStatement(node: CstNode, parentNodeId: string): void {
        const targetTable = this._analyzer.getChildNodes(node, 'tableName')[0];
        if (!targetTable) {
            return;
        }

        const relationNodeId = this.connectQualifiedTable(targetTable, parentNodeId, 'TARGET');
        const whereClause = this._analyzer.getChildNodes(node, 'whereClause')[0];
        if (whereClause && relationNodeId) {
            this.connectExpressionSubqueries(whereClause, parentNodeId, 'FILTER');
        }
    }

    private connectExpressionSubqueries(node: CstNode, parentNodeId: string, label: string): void {
        this._analyzer.visitNode(node, candidate => {
            if (candidate.name !== 'subquery') {
                return;
            }
            const range = this._analyzer.getNodeRange(candidate);
            if (!range) {
                return;
            }

            const nestedQuery =
                this._analyzer.getChildNodes(candidate, 'withStatement')[0]
                ?? this._analyzer.getChildNodes(candidate, 'selectStatement')[0];
            if (!nestedQuery) {
                return;
            }

            const subqueryNode = this.createNode('subquery', 'Subquery', range);
            this.addEdge(subqueryNode.id, parentNodeId, label);
            this.visitStatementLikeNode(nestedQuery, subqueryNode.id);
        });
    }

    private connectTableSource(tableSource: CstNode, parentNodeId: string, label: string): void {
        const subqueryNode = this._analyzer.getChildNodes(tableSource, 'subquery')[0];
        if (subqueryNode) {
            const nestedQuery =
                this._analyzer.getChildNodes(subqueryNode, 'withStatement')[0]
                ?? this._analyzer.getChildNodes(subqueryNode, 'selectStatement')[0];
            const range = this._analyzer.getNodeRange(subqueryNode);
            if (!nestedQuery || !range) {
                return;
            }

            const aliasToken = this._analyzer.getAliasToken(this._analyzer.getChildNodes(tableSource, 'aliasOptional')[0]);
            const labelText = aliasToken ? `Subquery ${this._analyzer.normalizeIdentifier(aliasToken)}` : 'Subquery';
            const sourceNode = this.createNode('subquery', labelText, range);
            this.addEdge(sourceNode.id, parentNodeId, label);
            this.visitStatementLikeNode(nestedQuery, sourceNode.id);
            return;
        }

        const tableName = this._analyzer.getChildNodes(tableSource, 'tableName')[0];
        if (tableName) {
            this.connectQualifiedTable(tableName, parentNodeId, label);
            return;
        }

        const qualifiedName = this._analyzer.getChildNodes(tableSource, 'qualifiedName')[0];
        if (qualifiedName) {
            this.connectQualifiedName(qualifiedName, parentNodeId, label);
        }
    }

    private connectQualifiedTable(tableNameNode: CstNode, parentNodeId: string, label: string): string | undefined {
        const qualifiedName = this._analyzer.getChildNodes(tableNameNode, 'qualifiedName')[0];
        if (!qualifiedName) {
            return undefined;
        }
        return this.connectQualifiedName(qualifiedName, parentNodeId, label);
    }

    private connectQualifiedName(qualifiedNameNode: CstNode, parentNodeId: string, label: string): string | undefined {
        const qualifiedName = this._analyzer.parseQualifiedName(qualifiedNameNode);
        const range = this._analyzer.getNodeRange(qualifiedNameNode);
        if (!qualifiedName || !range) {
            return undefined;
        }

        const cteNode = this.lookupCte(qualifiedName.shortName);
        if (cteNode) {
            this.addEdge(cteNode.nodeId, parentNodeId, label);
            return cteNode.nodeId;
        }

        const viewDefinition = this._views.get(qualifiedName.shortName.toUpperCase());
        if (viewDefinition) {
            const nodeId = this.getOrCreateNamedRelationNode(
                `view:${qualifiedName.shortName.toUpperCase()}`,
                'view',
                qualifiedName.raw,
                viewDefinition.definitionRange
            );
            this.addEdge(nodeId, parentNodeId, label);
            return nodeId;
        }

        const tempDefinition = this._tempTables.get(qualifiedName.shortName.toUpperCase());
        if (tempDefinition) {
            const tempRange = tempDefinition.bodyRange ?? tempDefinition.definitionRange;
            const nodeId = this.getOrCreateNamedRelationNode(
                `temp:${qualifiedName.shortName.toUpperCase()}`,
                'temp_table',
                qualifiedName.raw,
                tempRange
            );
            this.addEdge(nodeId, parentNodeId, label);
            return nodeId;
        }

        const nodeId = this.createNode('table', qualifiedName.raw, range).id;
        this.addEdge(nodeId, parentNodeId, label);
        return nodeId;
    }

    private getOrCreateNamedRelationNode(key: string, kind: QueryFlowNodeKind, label: string, range: SqlTextRange): string {
        const existingId = this._namedRelationNodes.get(key);
        if (existingId) {
            return existingId;
        }

        const nodeId = this.createNode(kind, label, range).id;
        this._namedRelationNodes.set(key, nodeId);
        return nodeId;
    }

    private createNode(kind: QueryFlowNodeKind, label: string, range: SqlTextRange): QueryFlowNode {
        const node: QueryFlowNode = {
            id: `node-${this._nextNodeId++}`,
            kind,
            label,
            statementIndex: this._statement.index,
            startOffset: range.startOffset,
            endOffset: range.endOffset,
            startLine: range.startLine,
            endLine: range.endLine
        };
        this._nodes.push(node);
        return node;
    }

    private addEdge(from: string, to: string, label: string): void {
        const edgeId = `${from}->${to}:${label}`;
        if (this._edges.some(edge => edge.id === edgeId)) {
            return;
        }

        this._edges.push({
            id: edgeId,
            from,
            to,
            label
        });
    }

    private pushCteScope(): void {
        this._cteScopes.push(new Map(this._cteScopes[this._cteScopes.length - 1]));
    }

    private popCteScope(): void {
        if (this._cteScopes.length > 1) {
            this._cteScopes.pop();
        }
    }

    private registerCte(name: string, nodeId: string): void {
        this._cteScopes[this._cteScopes.length - 1].set(name.toUpperCase(), { nodeId });
    }

    private lookupCte(name: string): FlowScopeEntry | undefined {
        for (let index = this._cteScopes.length - 1; index >= 0; index--) {
            const match = this._cteScopes[index].get(name.toUpperCase());
            if (match) {
                return match;
            }
        }
        return undefined;
    }
}

class SqlQueryStructureAnalyzer {
    private readonly _lineIndex: LineIndex;
    private readonly _parsingRuntime;

    constructor(
        private readonly _sql: string,
        databaseKind?: DatabaseKind
    ) {
        this._lineIndex = new LineIndex(_sql);
        this._parsingRuntime = resolveSqlParsingRuntime({ databaseKind });
    }

    public analyze(): SqlQueryStructureAnalysis {
        const statements = this.buildStatementRecords();
        if (statements.length === 0) {
            return {
                extractSubqueryCandidates: [],
                cteMaterializationCandidates: [],
                cteBulkMaterializationCandidates: [],
                tempTableInlineCandidates: [],
                statementFlows: []
            };
        }

        const extractSubqueryCandidates: ExtractSubqueryCandidate[] = [];
        const cteMaterializationCandidates: CteMaterializationCandidate[] = [];
        const cteBulkMaterializationCandidates: CteBulkMaterializationCandidate[] = [];
        const tempTableInlineCandidates: TempTableInlineCandidate[] = [];
        const statementFlows: QueryFlowGraph[] = [];

        const tempTablesInScope = new Map<string, NamedDefinitionRecord>();
        const viewsInScope = new Map<string, NamedDefinitionRecord>();

        for (const statement of statements) {
            extractSubqueryCandidates.push(...this.collectExtractSubqueryCandidates(statement));
            cteMaterializationCandidates.push(...this.collectCteMaterializationCandidates(statement));
            cteBulkMaterializationCandidates.push(...this.collectCteBulkMaterializationCandidates(statement));

            if (statement.kind === 'create_temp_table') {
                const tempTable = this.getTempTableDefinition(statement);
                if (tempTable) {
                    tempTablesInScope.set(tempTable.name.toUpperCase(), tempTable);
                }
            }

            const createdView = this.getCreatedViewDefinition(statement);
            if (createdView) {
                viewsInScope.set(createdView.name.toUpperCase(), createdView);
            }

            const flow = new QueryFlowCollector(this, statement, tempTablesInScope, viewsInScope).build();
            if (flow) {
                statementFlows.push(flow);
            }
        }

        for (let index = 0; index < statements.length; index++) {
            const statement = statements[index];
            if (statement.kind !== 'create_temp_table') {
                continue;
            }

            const tempTable = this.getTempTableDefinition(statement);
            if (!tempTable) {
                continue;
            }

            const nextStatement = statements[index + 1];
            if (
                !nextStatement
                || (
                    nextStatement.kind !== 'select'
                    && nextStatement.kind !== 'with_select'
                    && nextStatement.kind !== 'insert'
                    && nextStatement.kind !== 'with_insert'
                )
            ) {
                continue;
            }

            const nextWith = this.getWithLikeRecord(nextStatement.rootNode);
            if (nextWith && nextWith.cteNames.some(name => name.toUpperCase() === tempTable.name.toUpperCase())) {
                continue;
            }

            if (!this.statementUsesNamedRelationAsSource(nextStatement.rootNode, tempTable.name)) {
                continue;
            }

            const tempTableNameRange = this.getQualifiedNameRange(statement.rootNode);
            if (!tempTable.bodyRange || !tempTableNameRange) {
                continue;
            }

            tempTableInlineCandidates.push({
                statementIndex: statement.index,
                statementKind: statement.kind,
                tempTableName: tempTable.name,
                tempTableNameRange,
                tempTableStatementRange: statement.contentRange,
                tempTableDeletionRange: statement.deletionRange,
                queryBodyRange: tempTable.bodyRange,
                nextStatementIndex: nextStatement.index,
                nextStatementKind: nextStatement.kind,
                nextStatementRange: nextStatement.contentRange,
                cteInsertionOffset: nextWith ? this.getNodeRange(nextWith.mainStatement)?.startOffset ?? nextStatement.contentRange.startOffset : nextStatement.contentRange.startOffset,
                cteIndentAnchorOffset: nextWith ? nextWith.cteIndentAnchorOffset : nextStatement.contentRange.startOffset,
                nextStatementHasWithClause: !!nextWith,
                nextStatementExistingCteNames: nextWith?.cteNames ?? []
            });
        }

        return {
            extractSubqueryCandidates,
            cteMaterializationCandidates,
            cteBulkMaterializationCandidates,
            tempTableInlineCandidates,
            statementFlows
        };
    }

    public isFlowStatementKind(kind: SqlStatementKind): boolean {
        return kind === 'select'
            || kind === 'insert'
            || kind === 'update'
            || kind === 'delete'
            || kind === 'with_select'
            || kind === 'with_insert'
            || kind === 'with_update'
            || kind === 'with_delete';
    }

    public getStatementLabel(statement: StatementRecord): string {
        switch (statement.kind) {
            case 'select':
            case 'with_select':
                return 'Final SELECT';
            case 'insert':
            case 'with_insert':
                return 'Final INSERT';
            case 'update':
            case 'with_update':
                return 'Final UPDATE';
            case 'delete':
            case 'with_delete':
                return 'Final DELETE';
            default:
                return 'Final Query';
        }
    }

    public getChildNodes(node: CstNode, key: string): CstNode[] {
        const value = node.children?.[key];
        if (!Array.isArray(value)) {
            return [];
        }
        return value.filter((child): child is CstNode => this.isCstNode(child));
    }

    public getTokens(node: CstNode, key: string): IToken[] {
        const value = node.children?.[key];
        if (!Array.isArray(value)) {
            return [];
        }
        return value.filter((child): child is IToken => this.isToken(child));
    }

    public getDefinitionNameToken(node: CstNode): IToken | undefined {
        const identifierTokens = [...this.getTokens(node, 'Identifier'), ...this.getTokens(node, 'QuotedIdentifier')]
            .sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
        return identifierTokens[0];
    }

    public getAliasToken(aliasOptionalNode: CstNode | undefined): IToken | undefined {
        if (!aliasOptionalNode) {
            return undefined;
        }

        const aliasNode = this.getChildNodes(aliasOptionalNode, 'alias')[0];
        if (!aliasNode) {
            return undefined;
        }

        return this.getFirstTokenFromCst(aliasNode);
    }

    public normalizeIdentifier(token: IToken): string {
        const text = token.image;
        if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
            return text.slice(1, -1);
        }
        return text;
    }

    public getNodeRange(node: CstNode | undefined): SqlTextRange | undefined {
        if (!node) {
            return undefined;
        }

        const tokens: IToken[] = [];
        this.collectTokens(node, tokens);
        if (tokens.length === 0) {
            return undefined;
        }

        tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
        const startOffset = tokens[0].startOffset ?? 0;
        const endOffset = this.getTokenEndOffset(tokens[tokens.length - 1]);
        return this.createRangeFromOffsets(startOffset, endOffset);
    }

    public parseQualifiedName(qualifiedNameNode: CstNode | undefined): QualifiedName | undefined {
        if (!qualifiedNameNode) {
            return undefined;
        }

        const identifierTokens = this.getChildNodes(qualifiedNameNode, 'identifier')
            .map(node => this.getFirstTokenFromCst(node))
            .filter((token): token is IToken => !!token);

        if (identifierTokens.length === 0) {
            return undefined;
        }

        const raw = this._sql.slice(
            identifierTokens[0].startOffset ?? 0,
            this.getTokenEndOffset(identifierTokens[identifierTokens.length - 1])
        );

        return {
            raw,
            shortName: this.normalizeIdentifier(identifierTokens[identifierTokens.length - 1])
        };
    }

    public visitNode(node: CstNode, visitor: (node: CstNode) => void): void {
        visitor(node);
        const children = node.children ?? {};
        for (const value of Object.values(children)) {
            if (!Array.isArray(value)) {
                continue;
            }
            for (const child of value) {
                if (this.isCstNode(child)) {
                    this.visitNode(child, visitor);
                }
            }
        }
    }

    public createRangeFromOffsets(startOffset: number, endOffset: number): SqlTextRange {
        const normalizedStart = Math.max(0, startOffset);
        const normalizedEnd = Math.max(normalizedStart, endOffset);
        const endLineOffset = normalizedEnd > normalizedStart ? normalizedEnd - 1 : normalizedStart;

        return {
            startOffset: normalizedStart,
            endOffset: normalizedEnd,
            startLine: this._lineIndex.offsetToLine(normalizedStart),
            endLine: this._lineIndex.offsetToLine(endLineOffset)
        };
    }

    public getQualifiedNameRange(node: CstNode): SqlTextRange | undefined {
        const qualifiedName =
            this.getChildNodes(node, 'qualifiedName')[0]
            ?? this.getChildNodes(this.getChildNodes(node, 'tableName')[0] ?? node, 'qualifiedName')[0];

        return this.getNodeRange(qualifiedName);
    }

    private buildStatementRecords(): StatementRecord[] {
        const parseResult = parseSqlStatements({
            sql: this._sql,
            runtime: this._parsingRuntime
        });

        if (
            parseResult.lexResult.errors.length > 0
            || parseResult.lexResult.tokens.length === 0
            || parseResult.actionableParserErrors.length > 0
            || !parseResult.cst
        ) {
            return [];
        }

        const statementNodes = this.getChildNodes(parseResult.cst, 'statement');
        const splitStatements = StatementParser.splitStatementsWithPositions(this._sql);
        const records: StatementRecord[] = [];

        for (let index = 0; index < statementNodes.length; index++) {
            const statementNode = statementNodes[index];
            const rootNode = this.getRootStatementNode(statementNode);
            const rootRange = this.getNodeRange(rootNode);
            if (!rootNode || !rootRange) {
                continue;
            }

            const splitRange = splitStatements[index];
            const contentRange = splitRange
                ? this.createRangeFromOffsets(splitRange.startOffset, splitRange.endOffset)
                : rootRange;
            const nextStatementStart = splitStatements[index + 1]?.startOffset;
            const deletionEnd = this.computeDeletionEnd(contentRange.endOffset, nextStatementStart);

            records.push({
                index,
                kind: this.classifyStatementKind(rootNode),
                statementNode,
                rootNode,
                contentRange,
                deletionRange: this.createRangeFromOffsets(contentRange.startOffset, deletionEnd)
            });
        }

        return records;
    }

    private collectExtractSubqueryCandidates(statement: StatementRecord): ExtractSubqueryCandidate[] {
        if (!this.isRefactorableStatementKind(statement.kind)) {
            return [];
        }

        const withLike = this.getWithLikeRecord(statement.rootNode);
        const existingNames = new Set((withLike?.cteNames ?? []).map(name => name.toUpperCase()));
        const candidates: ExtractSubqueryCandidate[] = [];

        this.visitNode(statement.rootNode, node => {
            if (node.name !== 'tableSource') {
                return;
            }

            const subquery = this.getChildNodes(node, 'subquery')[0];
            if (!subquery) {
                return;
            }

            const subqueryRange = this.getNodeRange(subquery);
            const nestedQuery =
                this.getChildNodes(subquery, 'withStatement')[0]
                ?? this.getChildNodes(subquery, 'selectStatement')[0];
            const bodyRange = this.getNodeRange(nestedQuery);

            if (!subqueryRange || !bodyRange) {
                return;
            }

            const suggestedName = this.createUniqueName('new_cte_name', existingNames);
            existingNames.add(suggestedName.toUpperCase());

            candidates.push({
                statementIndex: statement.index,
                statementKind: statement.kind,
                statementRange: statement.contentRange,
                subqueryRange,
                subqueryBodyRange: bodyRange,
                cteInsertionOffset: withLike
                    ? this.getNodeRange(withLike.mainStatement)?.startOffset ?? statement.contentRange.startOffset
                    : statement.contentRange.startOffset,
                cteIndentAnchorOffset: withLike ? withLike.cteIndentAnchorOffset : statement.contentRange.startOffset,
                hasWithClause: !!withLike,
                existingCteNames: withLike?.cteNames ?? [],
                suggestedName
            });
        });

        return candidates;
    }

    private collectCteMaterializationCandidates(statement: StatementRecord): CteMaterializationCandidate[] {
        const withLike = this.getWithLikeRecord(statement.rootNode);
        if (!withLike) {
            return [];
        }

        const candidates: CteMaterializationCandidate[] = [];
        for (let index = 0; index < withLike.cteDefinitions.length; index++) {
            const cteDefinition = withLike.cteDefinitions[index];
            const nameToken = this.getDefinitionNameToken(cteDefinition);
            const definitionRange = this.getNodeRange(cteDefinition);
            const nestedQuery =
                this.getChildNodes(cteDefinition, 'withStatement')[0]
                ?? this.getChildNodes(cteDefinition, 'selectStatement')[0];
            const bodyRange = this.getNodeRange(nestedQuery);

            if (!nameToken || !definitionRange || !bodyRange) {
                continue;
            }

            const nameRange = this.createRangeFromOffsets(nameToken.startOffset ?? definitionRange.startOffset, this.getTokenEndOffset(nameToken));
            const withRemovalRange = this.getCteRemovalRange(withLike, index);
            if (!withRemovalRange) {
                continue;
            }

            candidates.push({
                statementIndex: statement.index,
                statementKind: statement.kind,
                cteName: this.normalizeIdentifier(nameToken),
                cteNameRange: nameRange,
                cteDefinitionRange: definitionRange,
                cteBodyRange: bodyRange,
                withRemovalRange,
                tempTableInsertOffset: statement.contentRange.startOffset
            });
        }

        return candidates;
    }

    private collectCteBulkMaterializationCandidates(statement: StatementRecord): CteBulkMaterializationCandidate[] {
        if (statement.kind !== 'with_select') {
            return [];
        }

        const withRootNode = statement.rootNode.name === 'withStatement' || statement.rootNode.name === 'withAnyStatement'
            ? statement.rootNode
            : undefined;
        if (!withRootNode) {
            return [];
        }

        const withClauseRange = this.getNodeRange(withRootNode);
        if (!withClauseRange) {
            return [];
        }

        const hasRecursive = this.getTokens(withRootNode, 'Recursive').length > 0;

        return [{
            statementIndex: statement.index,
            statementKind: statement.kind,
            withClauseRange,
            statementRange: statement.contentRange,
            withRootNode,
            hasRecursive,
        }];
    }

    private getTempTableDefinition(statement: StatementRecord): NamedDefinitionRecord | undefined {
        if (statement.kind !== 'create_temp_table') {
            return undefined;
        }

        const nameRange = this.getQualifiedNameRange(statement.rootNode);
        const qualifiedName = this.parseQualifiedName(this.getChildNodes(statement.rootNode, 'qualifiedName')[0]);
        const bodyRange = this.getNodeRange(
            this.getChildNodes(statement.rootNode, 'withStatement')[0]
            ?? this.getChildNodes(statement.rootNode, 'selectStatement')[0]
        );

        if (!qualifiedName || !nameRange) {
            return undefined;
        }

        return {
            name: qualifiedName.shortName,
            definitionRange: nameRange,
            bodyRange,
            statementIndex: statement.index
        };
    }

    private getCreatedViewDefinition(statement: StatementRecord): NamedDefinitionRecord | undefined {
        if (statement.rootNode.name !== 'createViewStatement') {
            return undefined;
        }

        const qualifiedName = this.parseQualifiedName(this.getChildNodes(statement.rootNode, 'qualifiedName')[0]);
        const definitionRange = this.getQualifiedNameRange(statement.rootNode);
        if (!qualifiedName || !definitionRange) {
            return undefined;
        }

        return {
            name: qualifiedName.shortName,
            definitionRange,
            statementIndex: statement.index
        };
    }

    private getWithLikeRecord(rootNode: CstNode): WithLikeRecord | undefined {
        if (rootNode.name === 'withAnyStatement' || rootNode.name === 'withStatement') {
            const cteDefinitions = this.getChildNodes(rootNode, 'cteDefinition');
            const mainStatement =
                this.getChildNodes(rootNode, 'selectStatement')[0]
                ?? this.getChildNodes(rootNode, 'insertStatement')[0]
                ?? this.getChildNodes(rootNode, 'updateStatement')[0]
                ?? this.getChildNodes(rootNode, 'deleteStatement')[0];
            const withToken = this.getTokens(rootNode, 'With')[0];
            const mainRange = this.getNodeRange(mainStatement);
            if (!withToken || !mainStatement || !mainRange) {
                return undefined;
            }

            return {
                node: rootNode,
                cteDefinitions,
                commaTokens: this.getTokens(rootNode, 'Comma'),
                mainStatement,
                prefixRange: this.createRangeFromOffsets(withToken.startOffset ?? mainRange.startOffset, mainRange.startOffset),
                cteNames: cteDefinitions
                    .map(definition => this.getDefinitionNameToken(definition))
                    .filter((token): token is IToken => !!token)
                    .map(token => this.normalizeIdentifier(token)),
                cteIndentAnchorOffset: this.getNodeRange(cteDefinitions[0])?.startOffset ?? mainRange.startOffset
            };
        }

        if (rootNode.name === 'insertStatement') {
            const insertWithClause = this.getChildNodes(rootNode, 'insertWithClause')[0];
            if (!insertWithClause) {
                return undefined;
            }

            const cteDefinitions = this.getChildNodes(insertWithClause, 'insertCteDefinition');
            const mainStatement = this.getChildNodes(insertWithClause, 'selectStatement')[0];
            const withToken = this.getTokens(insertWithClause, 'With')[0];
            const mainRange = this.getNodeRange(mainStatement);
            if (!withToken || !mainStatement || !mainRange) {
                return undefined;
            }

            return {
                node: insertWithClause,
                cteDefinitions,
                commaTokens: this.getTokens(insertWithClause, 'Comma'),
                mainStatement,
                prefixRange: this.createRangeFromOffsets(withToken.startOffset ?? mainRange.startOffset, mainRange.startOffset),
                cteNames: cteDefinitions
                    .map(definition => this.getDefinitionNameToken(definition))
                    .filter((token): token is IToken => !!token)
                    .map(token => this.normalizeIdentifier(token)),
                cteIndentAnchorOffset: this.getNodeRange(cteDefinitions[0])?.startOffset ?? mainRange.startOffset
            };
        }

        return undefined;
    }

    private getCteRemovalRange(withLike: WithLikeRecord, index: number): SqlTextRange | undefined {
        if (withLike.cteDefinitions.length === 1) {
            return withLike.prefixRange;
        }

        const currentRange = this.getNodeRange(withLike.cteDefinitions[index]);
        if (!currentRange) {
            return undefined;
        }

        if (index < withLike.cteDefinitions.length - 1) {
            const nextRange = this.getNodeRange(withLike.cteDefinitions[index + 1]);
            if (!nextRange) {
                return undefined;
            }
            return this.createRangeFromOffsets(currentRange.startOffset, nextRange.startOffset);
        }

        const commaToken = withLike.commaTokens[index - 1];
        if (!commaToken) {
            return undefined;
        }

        return this.createRangeFromOffsets(commaToken.startOffset ?? currentRange.startOffset, currentRange.endOffset);
    }

    private getRootStatementNode(statementNode: CstNode): CstNode | undefined {
        const directChildren = this.getDirectChildNodes(statementNode)
            .map(child => ({ child, range: this.getNodeRange(child) }))
            .filter((entry): entry is { child: CstNode; range: SqlTextRange } => !!entry.range)
            .sort((left, right) => left.range.startOffset - right.range.startOffset);

        return directChildren[0]?.child;
    }

    private getDirectChildNodes(node: CstNode): CstNode[] {
        const result: CstNode[] = [];
        const children = node.children ?? {};
        for (const value of Object.values(children)) {
            if (!Array.isArray(value)) {
                continue;
            }
            for (const child of value) {
                if (this.isCstNode(child)) {
                    result.push(child);
                }
            }
        }
        return result;
    }

    private classifyStatementKind(rootNode: CstNode): SqlStatementKind {
        switch (rootNode.name) {
            case 'withStatement':
                return 'with_select';
            case 'withAnyStatement': {
                const mainStatement =
                    this.getChildNodes(rootNode, 'selectStatement')[0]
                    ?? this.getChildNodes(rootNode, 'insertStatement')[0]
                    ?? this.getChildNodes(rootNode, 'updateStatement')[0]
                    ?? this.getChildNodes(rootNode, 'deleteStatement')[0];
                if (!mainStatement) {
                    return 'other';
                }
                switch (mainStatement.name) {
                    case 'selectStatement':
                        return 'with_select';
                    case 'insertStatement':
                        return 'with_insert';
                    case 'updateStatement':
                        return 'with_update';
                    case 'deleteStatement':
                        return 'with_delete';
                    default:
                        return 'other';
                }
            }
            case 'selectStatement':
                return 'select';
            case 'insertStatement':
                return 'insert';
            case 'updateStatement':
                return 'update';
            case 'deleteStatement':
                return 'delete';
            case 'createTableStatement':
                return this.getChildNodes(rootNode, 'tableTypeClause')[0]
                    && (this.getChildNodes(rootNode, 'withStatement')[0] || this.getChildNodes(rootNode, 'selectStatement')[0])
                    ? 'create_temp_table'
                    : 'create_table';
            default:
                return 'other';
        }
    }

    private isRefactorableStatementKind(kind: SqlStatementKind): boolean {
        return kind === 'select'
            || kind === 'insert'
            || kind === 'update'
            || kind === 'delete'
            || kind === 'with_select'
            || kind === 'with_insert'
            || kind === 'with_update'
            || kind === 'with_delete';
    }

    private statementUsesNamedRelationAsSource(rootNode: CstNode, relationName: string): boolean {
        const normalizedName = relationName.toUpperCase();
        let found = false;

        this.visitNode(rootNode, node => {
            if (found || node.name !== 'tableSource') {
                return;
            }

            const tableNameNode = this.getChildNodes(node, 'tableName')[0];
            if (!tableNameNode) {
                return;
            }

            const qualifiedNameNode = this.getChildNodes(tableNameNode, 'qualifiedName')[0];
            const qualifiedName = this.parseQualifiedName(qualifiedNameNode);
            if (qualifiedName?.shortName.toUpperCase() === normalizedName) {
                found = true;
            }
        });

        return found;
    }

    private createUniqueName(baseName: string, existingNames: Set<string>): string {
        if (!existingNames.has(baseName.toUpperCase())) {
            return baseName;
        }

        let suffix = 2;
        while (existingNames.has(`${baseName}_${suffix}`.toUpperCase())) {
            suffix++;
        }
        return `${baseName}_${suffix}`;
    }

    private computeDeletionEnd(contentEndOffset: number, nextStatementStartOffset: number | undefined): number {
        let deletionEnd = contentEndOffset;
        if (deletionEnd < this._sql.length && this._sql[deletionEnd] === ';') {
            deletionEnd++;
        }

        if (nextStatementStartOffset === undefined || nextStatementStartOffset <= deletionEnd) {
            return deletionEnd;
        }

        const gap = this._sql.slice(deletionEnd, nextStatementStartOffset);
        return gap.trim().length === 0 ? nextStatementStartOffset : deletionEnd;
    }

    private collectTokens(node: CstNode, sink: IToken[]): void {
        const children = node.children ?? {};
        for (const value of Object.values(children)) {
            if (!Array.isArray(value)) {
                continue;
            }

            for (const child of value) {
                if (this.isToken(child)) {
                    sink.push(child);
                } else if (this.isCstNode(child)) {
                    this.collectTokens(child, sink);
                }
            }
        }
    }

    private getFirstTokenFromCst(node: CstNode | undefined): IToken | undefined {
        if (!node) {
            return undefined;
        }

        const tokens: IToken[] = [];
        this.collectTokens(node, tokens);
        tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
        return tokens[0];
    }

    private getTokenEndOffset(token: IToken): number {
        if (token.endOffset !== undefined) {
            return token.endOffset + 1;
        }
        return (token.startOffset ?? 0) + token.image.length;
    }

    private isCstNode(value: unknown): value is CstNode {
        return typeof value === 'object' && value !== null && 'name' in value && 'children' in value;
    }

    private isToken(value: unknown): value is IToken {
        return typeof value === 'object' && value !== null && 'image' in value && 'tokenType' in value;
    }
}

export function analyzeSqlQueryStructures(sql: string, databaseKind?: DatabaseKind): SqlQueryStructureAnalysis {
    return new SqlQueryStructureAnalyzer(sql, databaseKind).analyze();
}

export function statementSupportsQueryFlow(statementSql: string, databaseKind?: DatabaseKind): boolean {
    const lexResult = resolveSqlParsingRuntime({ databaseKind }).SqlLexer.tokenize(statementSql);
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
        return false;
    }

    const firstTokenName = lexResult.tokens[0].tokenType.name;
    return firstTokenName === 'With'
        || firstTokenName === 'Select'
        || firstTokenName === 'Insert'
        || firstTokenName === 'Update'
        || firstTokenName === 'Delete';
}

export function rangeContainsOffsets(range: SqlTextRange, startOffset: number, endOffset: number): boolean {
    return startOffset >= range.startOffset && endOffset <= range.endOffset;
}

export function rangesIntersect(range: SqlTextRange, startOffset: number, endOffset: number): boolean {
    return startOffset < range.endOffset && endOffset > range.startOffset;
}
