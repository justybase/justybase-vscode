import * as vscode from 'vscode';
import type { DatabaseKind } from '../contracts/database';
import {
    analyzeSqlQueryStructures,
    rangeContainsOffsets,
    type CteMaterializationCandidate,
    type ExtractSubqueryCandidate,
    type SqlTextRange,
    type TempTableInlineCandidate
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

        const extractCandidate = analysis.extractSubqueryCandidates.find(candidate =>
            rangeContainsOffsets(candidate.subqueryBodyRange, startOffset, endOffset)
        );
        if (extractCandidate) {
            actions.push(this.createExtractSubqueryAction(document, sql, extractCandidate));
        }

        const cteCandidate = analysis.cteMaterializationCandidates.find(candidate =>
            rangeContainsOffsets(candidate.cteDefinitionRange, startOffset, endOffset)
        );
        if (cteCandidate) {
            actions.push(this.createMaterializeCteAction(document, sql, cteCandidate));
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
        candidate: ExtractSubqueryCandidate
    ): vscode.CodeAction {
        const cteBody = this.readTextRange(sql, candidate.subqueryBodyRange);
        const cteIndent = this.getLineIndentation(sql, candidate.cteIndentAnchorOffset);
        const cteDefinition = this.buildCteDefinition(candidate.suggestedName, cteBody, cteIndent);
        const insertionText = candidate.hasWithClause
            ? `,\n${cteDefinition}\n`
            : `WITH ${cteDefinition}\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(candidate.cteInsertionOffset), insertionText);
        edit.replace(document.uri, this.toRange(document, candidate.subqueryRange), candidate.suggestedName);

        const action = new vscode.CodeAction('⚡ Refactor: Extract Subquery as CTE', REFACTOR_EXTRACT_KIND);
        action.edit = edit;
        action.isPreferred = true;
        return action;
    }

    private createMaterializeCteAction(
        document: vscode.TextDocument,
        sql: string,
        candidate: CteMaterializationCandidate
    ): vscode.CodeAction {
        const cteBody = this.readTextRange(sql, candidate.cteBodyRange);
        const tempTableStatement = this.buildTempTableStatement(candidate.cteName, cteBody);
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

    private createInlineTempTableAction(
        document: vscode.TextDocument,
        sql: string,
        candidate: TempTableInlineCandidate
    ): vscode.CodeAction {
        const cteBody = this.readTextRange(sql, candidate.queryBodyRange);
        const cteIndent = this.getLineIndentation(sql, candidate.cteIndentAnchorOffset);
        const cteDefinition = this.buildCteDefinition(candidate.tempTableName, cteBody, cteIndent);
        const insertionText = candidate.nextStatementHasWithClause
            ? `,\n${cteDefinition}\n`
            : `WITH ${cteDefinition}\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, this.toRange(document, candidate.tempTableDeletionRange));
        edit.insert(document.uri, document.positionAt(candidate.cteInsertionOffset), insertionText);

        const action = new vscode.CodeAction('⚡ Refactor: Inline Temp Table as CTE', REFACTOR_REWRITE_KIND);
        action.edit = edit;
        return action;
    }

    private buildCteDefinition(name: string, body: string, indent: string): string {
        const normalizedBody = this.normalizeBlockIndentation(body);
        const bodyIndent = `${indent}    `;
        const indentedBody = normalizedBody
            .split(/\r?\n/u)
            .map(line => (line.trim().length > 0 ? `${bodyIndent}${line}` : line))
            .join('\n');

        return `${indent}${name} AS (\n${indentedBody}\n${indent})`;
    }

    private buildTempTableStatement(name: string, body: string): string {
        const normalizedBody = this.normalizeBlockIndentation(body);
        return `CREATE TEMP TABLE ${name} AS\n${normalizedBody}\nDISTRIBUTE ON RANDOM;\n\n`;
    }

    private normalizeBlockIndentation(text: string): string {
        const lines = text
            .replace(/\r\n/g, '\n')
            .split('\n');

        while (lines.length > 0 && lines[0].trim().length === 0) {
            lines.shift();
        }
        while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
            lines.pop();
        }

        const indentationWidths = lines
            .filter(line => line.trim().length > 0)
            .map(line => line.match(/^\s*/u)?.[0].length ?? 0);
        const minimumIndentation = indentationWidths.length > 0 ? Math.min(...indentationWidths) : 0;

        return lines
            .map(line => (line.trim().length > 0 ? line.slice(minimumIndentation) : ''))
            .join('\n');
    }

    private getLineIndentation(text: string, offset: number): string {
        let lineStart = Math.max(0, offset);
        while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
            lineStart--;
        }

        const lineText = text.slice(lineStart, offset);
        return lineText.match(/^\s*/u)?.[0] ?? '';
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
