import * as vscode from 'vscode';
import type { DatabaseKind } from '../contracts/database';
import {
    analyzeSqlQueryStructures,
    buildCreateTempTableStatement,
    buildCteToTempTableTransform,
    rangeContainsOffsets,
    rangesIntersect,
    type CteBulkMaterializationCandidate,
    type CteMaterializationCandidate,
    type ExtractSubqueryCandidate,
    type SqlTextRange,
    type TempTableInlineCandidate,
    type TempTableMaterializationKind,
    parseSqlStatements,
} from '../sqlParser';

const REFACTOR_KIND: vscode.CodeActionKind =
    ((vscode.CodeActionKind as unknown as { Refactor?: vscode.CodeActionKind }).Refactor
        ?? vscode.CodeActionKind.QuickFix);
const REFACTOR_EXTRACT_KIND: vscode.CodeActionKind =
    ((vscode.CodeActionKind as unknown as { RefactorExtract?: vscode.CodeActionKind }).RefactorExtract
        ?? REFACTOR_KIND);
const REFACTOR_REWRITE_KIND: vscode.CodeActionKind =
    ((vscode.CodeActionKind as unknown as { RefactorRewrite?: vscode.CodeActionKind }).RefactorRewrite
        ?? REFACTOR_KIND);

export const EXTRACT_SUBQUERY_PREVIEW_COMMAND = 'justybase.sqlRefactor.previewExtractSubqueryAsCte';

function getLineIndentation(text: string, offset: number): string {
    let lineStart = Math.max(0, offset);
    while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
        lineStart--;
    }
    return text.slice(lineStart, offset).match(/^\s*/u)?.[0] ?? '';
}

function normalizeBlockIndentation(text: string, lineEnding: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
    const widths = lines.filter(line => line.trim().length > 0)
        .map(line => line.match(/^\s*/u)?.[0].length ?? 0);
    const minimumIndentation = widths.length > 0 ? Math.min(...widths) : 0;
    return lines
        .map(line => line.trim().length > 0 ? line.slice(minimumIndentation) : '')
        .join(lineEnding);
}

function buildCteDefinition(name: string, body: string, indent: string, lineEnding: string): string {
    const bodyIndent = `${indent}    `;
    const indentedBody = normalizeBlockIndentation(body, lineEnding)
        .split(lineEnding)
        .map(line => line.trim().length > 0 ? `${bodyIndent}${line}` : line)
        .join(lineEnding);
    return `${indent}${name} AS (${lineEnding}${indentedBody}${lineEnding}${indent})`;
}

/** Construct and parser-check the full SQL proposal before exposing a preview action. */
export function buildExtractSubquerySql(
    sql: string,
    candidate: ExtractSubqueryCandidate,
    databaseKind?: DatabaseKind,
): string | undefined {
    if (candidate.isCorrelated) return undefined;
    const { subqueryRange, subqueryBodyRange, cteInsertionOffset } = candidate;
    if (
        subqueryRange.startOffset < 0
        || subqueryRange.endOffset > sql.length
        || subqueryRange.startOffset >= subqueryRange.endOffset
        || subqueryBodyRange.startOffset < subqueryRange.startOffset
        || subqueryBodyRange.startOffset >= subqueryBodyRange.endOffset
        || subqueryBodyRange.endOffset > subqueryRange.endOffset
        || candidate.cteIndentAnchorOffset < 0
        || candidate.cteIndentAnchorOffset > sql.length
        || cteInsertionOffset < 0
        || cteInsertionOffset > subqueryRange.startOffset
    ) {
        return undefined;
    }

    const lineEnding = sql.includes('\r\n') ? '\r\n' : '\n';
    const cteIndent = getLineIndentation(sql, candidate.cteIndentAnchorOffset);
    const cteBody = sql.slice(subqueryBodyRange.startOffset, subqueryBodyRange.endOffset);
    const definition = buildCteDefinition(candidate.suggestedName, cteBody, cteIndent, lineEnding);
    const insertionText = candidate.hasWithClause
        ? `,${lineEnding}${definition}${lineEnding}`
        : `WITH ${definition}${lineEnding}`;
    const edits = [
        { start: subqueryRange.startOffset, end: subqueryRange.endOffset, text: candidate.suggestedName },
        { start: cteInsertionOffset, end: cteInsertionOffset, text: insertionText },
    ].sort((left, right) => right.start - left.start);

    let proposedSql = sql;
    for (const edit of edits) {
        proposedSql = proposedSql.slice(0, edit.start) + edit.text + proposedSql.slice(edit.end);
    }

    const parsed = parseSqlStatements({ sql: proposedSql, databaseKind });
    if (parsed.lexResult.errors.length > 0 || parsed.actionableParserErrors.length > 0 || !parsed.cst) {
        return undefined;
    }
    return proposedSql;
}

export class SqlRefactorCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        REFACTOR_KIND,
        REFACTOR_EXTRACT_KIND,
        REFACTOR_REWRITE_KIND
    ];

    public constructor(
        private readonly resolveDatabaseKind?: (documentUri: string) => DatabaseKind | undefined
    ) {}

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        if (
            context.only
            && !SqlRefactorCodeActionProvider.providedCodeActionKinds.some(kind =>
                kind.contains(context.only!) || context.only!.contains(kind)
            )
        ) {
            return [];
        }

        const sql = document.getText();
        if (!sql.trim()) {
            return [];
        }

        const startOffset = document.offsetAt(range.start);
        const endOffset = document.offsetAt(range.end);
        const databaseKind = this.resolveDatabaseKind?.(document.uri.toString());
        const analysis = analyzeSqlQueryStructures(sql, databaseKind);
        const actions: vscode.CodeAction[] = [];

        const extractCandidate = analysis.extractSubqueryCandidates
            .filter(candidate => !candidate.isCorrelated
                && rangeContainsOffsets(candidate.subqueryBodyRange, startOffset, endOffset))
            .sort((left, right) =>
                (left.subqueryRange.endOffset - left.subqueryRange.startOffset)
                - (right.subqueryRange.endOffset - right.subqueryRange.startOffset))[0];
        if (extractCandidate) {
            const proposedSql = buildExtractSubquerySql(sql, extractCandidate, databaseKind);
            if (proposedSql) {
                actions.push(this.createExtractSubqueryAction(document, sql, proposedSql));
            }
        }

        const cteCandidate = analysis.cteMaterializationCandidates.find(candidate =>
            rangeContainsOffsets(candidate.cteDefinitionRange, startOffset, endOffset)
        );
        if (cteCandidate) {
            actions.push(this.createMaterializeCteAction(document, sql, cteCandidate));
        }

        const selectionWithinSingleCteDefinition = analysis.cteMaterializationCandidates.some(candidate =>
            rangeContainsOffsets(candidate.cteDefinitionRange, startOffset, endOffset)
        );
        const bulkCteCandidate = !selectionWithinSingleCteDefinition
            ? analysis.cteBulkMaterializationCandidates.find(candidate =>
                !candidate.hasRecursive
                && rangesIntersect(candidate.withClauseRange, startOffset, endOffset)
            )
            : undefined;
        if (bulkCteCandidate) {
            const tempAction = this.createBulkMaterializeCteAction(document, sql, bulkCteCandidate, 'TEMP');
            if (tempAction) {
                actions.push(tempAction);
            }
            const globalAction = this.createBulkMaterializeCteAction(document, sql, bulkCteCandidate, 'GLOBAL_TEMP');
            if (globalAction) {
                actions.push(globalAction);
            }
        }

        const tempTableCandidate = analysis.tempTableInlineCandidates.find(candidate =>
            rangeContainsOffsets(candidate.tempTableStatementRange, startOffset, endOffset)
        );
        if (tempTableCandidate) {
            actions.push(this.createInlineTempTableAction(document, sql, tempTableCandidate));
        }

        return actions;
    }

    private createExtractSubqueryAction(
        document: vscode.TextDocument,
        sql: string,
        proposedSql: string,
    ): vscode.CodeAction {
        const title = '⚡ Refactor: Extract Subquery as CTE';
        const action = new vscode.CodeAction(title, REFACTOR_EXTRACT_KIND);
        action.command = {
            command: EXTRACT_SUBQUERY_PREVIEW_COMMAND,
            title,
            arguments: [{
                sourceUri: document.uri.toString(),
                expectedVersion: document.version,
                originalSql: sql,
                proposedSql,
                languageId: document.languageId,
            }],
        };
        action.isPreferred = true;
        return action;
    }

    private createMaterializeCteAction(
        document: vscode.TextDocument,
        sql: string,
        candidate: CteMaterializationCandidate
    ): vscode.CodeAction {
        const cteBody = this.readTextRange(sql, candidate.cteBodyRange);
        const tempTableStatement = buildCreateTempTableStatement(candidate.cteName, cteBody, 'TEMP');
        const edit = new vscode.WorkspaceEdit();

        if (candidate.tempTableInsertOffset === candidate.withRemovalRange.startOffset) {
            edit.replace(document.uri, this.toRange(document, candidate.withRemovalRange), tempTableStatement);
        } else {
            edit.insert(document.uri, document.positionAt(candidate.tempTableInsertOffset), tempTableStatement);
            edit.delete(document.uri, this.toRange(document, candidate.withRemovalRange));
        }

        const action = new vscode.CodeAction(
            '⚡ Refactor: Materialize CTE to Temporary Table',
            REFACTOR_REWRITE_KIND
        );
        action.edit = edit;
        return action;
    }

    private createBulkMaterializeCteAction(
        document: vscode.TextDocument,
        sql: string,
        candidate: CteBulkMaterializationCandidate,
        kind: TempTableMaterializationKind,
    ): vscode.CodeAction | undefined {
        const plan = buildCteToTempTableTransform(
            sql,
            candidate.withRootNode,
            candidate.statementRange,
            kind,
        );
        if (!plan) {
            return undefined;
        }

        const title = kind === 'GLOBAL_TEMP'
            ? '⚡ Refactor: Convert CTEs to Global Temp Tables'
            : '⚡ Refactor: Convert CTEs to Temp Tables';

        const action = new vscode.CodeAction(title, REFACTOR_REWRITE_KIND);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, this.toRange(document, plan.replacementRange), plan.outputSql);
        action.edit = edit;
        return action;
    }

    private createInlineTempTableAction(
        document: vscode.TextDocument,
        sql: string,
        candidate: TempTableInlineCandidate
    ): vscode.CodeAction {
        const cteBody = this.readTextRange(sql, candidate.queryBodyRange);
        const cteIndent = getLineIndentation(sql, candidate.cteIndentAnchorOffset);
        const cteDefinition = buildCteDefinition(
            candidate.tempTableName,
            cteBody,
            cteIndent,
            sql.includes('\r\n') ? '\r\n' : '\n',
        );
        const lineEnding = sql.includes('\r\n') ? '\r\n' : '\n';
        const insertionText = candidate.nextStatementHasWithClause
            ? `,${lineEnding}${cteDefinition}${lineEnding}`
            : `WITH ${cteDefinition}${lineEnding}`;

        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, this.toRange(document, candidate.tempTableDeletionRange));
        edit.insert(document.uri, document.positionAt(candidate.cteInsertionOffset), insertionText);

        const action = new vscode.CodeAction('⚡ Refactor: Inline Temp Table as CTE', REFACTOR_REWRITE_KIND);
        action.edit = edit;
        return action;
    }

    private readTextRange(text: string, range: SqlTextRange): string {
        return text.slice(range.startOffset, range.endOffset);
    }

    private toRange(document: vscode.TextDocument, range: SqlTextRange): vscode.Range {
        return new vscode.Range(
            document.positionAt(range.startOffset),
            document.positionAt(range.endOffset)
        );
    }
}
