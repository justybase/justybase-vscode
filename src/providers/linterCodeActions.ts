/**
 * Code Actions for Netezza SQL Linter
 * 
 * Provides Quick Fixes for lint issues found by SqlLinterProvider.
 */

import * as vscode from 'vscode';
import type { CstNode, IToken } from 'chevrotain';
import type { DatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { proposeTableQualification } from '../core/tableQualificationResolver';
import {
    collectQualificationActionProposals,
    resolveQualificationPreferredIndex,
    parseTableReferenceText,
} from '../core/tableQualificationActions';
import { SqlParser } from '../sql/sqlParser';
import { SqlLexer, type Scope, type TableInfo } from '../sqlParser';
import { parseSqlStatements } from '../sqlParser/parsingRuntime';
import { createSqlValidatorForDocument } from '../commands/validationCommands';
import { parseSemanticScopeWithParser } from './parsers/parserSqlContext';
import { buildNetezzaQuickFix } from '../server/netezzaQuickFixes';
import {
    ERROR_CODE_ACTIONS,
    LSP_SERVED_CODES,
    SAFE_FIX_ALL_CODES,
} from '../server/quickFixPolicy';

export { getNetezzaQuickFixSafety, isNetezzaFixAllEligible } from '../server/quickFixPolicy';

type DatabaseKindResolver = (documentUri: string) => DatabaseKind | undefined;


const SOURCE_FIX_ALL_KIND: vscode.CodeActionKind =
    ((vscode.CodeActionKind as unknown as { SourceFixAll?: vscode.CodeActionKind }).SourceFixAll
        ?? vscode.CodeActionKind.QuickFix);



interface SafeFixAllEdit {
    start: number;
    end: number;
    newText: string;
    /** Host range for replacements, or host position for insertions. */
    target: vscode.Range | vscode.Position;
}

/** Edits conflict when ranges overlap or two insertions target one offset. */
function safeFixAllEditsConflict(left: SafeFixAllEdit, right: SafeFixAllEdit): boolean {
    const leftInsert = left.start === left.end;
    const rightInsert = right.start === right.end;
    if (leftInsert && rightInsert) return left.start === right.start;
    if (leftInsert) return right.start < left.start && left.start < right.end;
    if (rightInsert) return left.start < right.start && right.start < left.end;
    return left.start < right.end && right.start < left.end;
}

function applySafeFixAllEdit(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, fixEdit: SafeFixAllEdit): void {
    if (fixEdit.start === fixEdit.end) {
        edit.insert(document.uri, fixEdit.target as vscode.Position, fixEdit.newText);
    } else {
        edit.replace(document.uri, fixEdit.target as vscode.Range, fixEdit.newText);
    }
}



export class NetezzaLinterCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        SOURCE_FIX_ALL_KIND
    ];

    constructor(
        private readonly resolveDatabaseKind?: DatabaseKindResolver,
        private readonly deps?: {
            connectionManager: ConnectionManager;
            metadataCache: MetadataCache;
        },
    ) {}

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const isTestMode = process.env.NODE_ENV === 'test';

        for (const diagnostic of context.diagnostics) {
            const code = typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code);

            // In production, LSP server handles SQL/PAR codes
            if (!isTestMode && LSP_SERVED_CODES.has(code)) {
                continue;
            }
            
            // Handle NZ011 - CTAS without DISTRIBUTE ON
            if (code === 'NZ011' || code === 'SQL045') {
                const action = this.createDistributeOnRandomFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }
            
            // Handle SQL007 - Invalid DB.TABLE format
            if (code === 'SQL007') {
                const qualificationActions = this.createTableQualificationFixes(document, diagnostic, true);
                actions.push(...qualificationActions);
                const action = this.createDbTableFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }
            
            // Handle SQL012 - VARCHAR without length
            if (code === 'SQL012') {
                const action = this.createVarcharLengthFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'PAR101') {
                const action = this.createMissingAsInCteFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ002' || code === 'NZ003' || code === 'SQL043' || code === 'SQL044') {
                const action = this.createWhereGuardFix(document, diagnostic, code);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ006') {
                const action = this.createFetchFirstFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ007') {
                continue;
            }

            if (code === 'NZ001') {
                const action = this.createSelectStarExpansionFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ004' || code === 'SQL051') {
                const action = this.createCrossJoinFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'SQL004') {
                const action = this.createSuggestedColumnFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'SQL008') {
                const qualificationActions = this.createAmbiguousColumnQualificationFixes(document, diagnostic);
                if (qualificationActions.length > 0) {
                    actions.push(...qualificationActions);
                }
            }

            if (code === 'SQL048') {
                actions.push(...this.createTableQualificationFixes(document, diagnostic, true));
            }

            if (code === 'NZ010' || code === 'SQL052') {
                const action = this.createMissingAliasFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ012' || code === 'SQL046') {
                const action = this.createUpdateAliasAsFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZL006') {
                const action = this.createEqualsNullFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ013') {
                const action = this.createUnionAllFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZP012') {
                const action = this.createProcedureElsifFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'NZ021') {
                const action = this.createDoubleCommaFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'PAR002') {
                const action = this.createDoubleCommaFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'PAR003') {
                const action = this.createDuplicateKeywordFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            if (code === 'PAR004') {
                const action = this.createKeywordTypoFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            // Handle SQL018 - Unused CTE
            if (code === 'SQL018') {
                const action = this.createRemoveUnusedCteFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            // Handle SQL019 - Unused table alias
            if (code === 'SQL019') {
                const action = this.createRemoveUnusedAliasFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            // Handle SQL020 - Subquery without alias
            if (code === 'SQL020') {
                const action = this.createSubqueryAliasFix(document, diagnostic);
                if (action) {
                    actions.push(action);
                }
            }

            const templateActions = this.createParameterizedTemplateActions(document, diagnostic);
            if (templateActions.length > 0) {
                actions.push(...templateActions);
            }
        }

        const keywordCaseFix = this.createKeywordCaseFixForDiagnostics(document, context.diagnostics);
        if (keywordCaseFix) {
            actions.push(keywordCaseFix);
        }

        const copilotFix = this.createCopilotFixAction(document, range, context.diagnostics, isTestMode);
        if (copilotFix) {
            actions.push(copilotFix);
        }

        actions.push(...this.createFixAllSafeActions(document, range, context.diagnostics));
        return actions;
    }

    private getDiagnosticCode(diagnostic: vscode.Diagnostic): string {
        return typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? '');
    }

    private getStatementBoundaryForRange(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection
    ): { startOffset: number; endOffset: number; sql: string } | undefined {
        try {
            const candidate = range as { start?: vscode.Position };
            if (!candidate?.start) {
                return undefined;
            }

            const offset = document.offsetAt(candidate.start);
            const statement = SqlParser.getStatementAtPosition(document.getText(), offset);
            if (!statement) {
                return undefined;
            }

            return {
                startOffset: statement.start,
                endOffset: statement.end,
                sql: statement.sql,
            };
        } catch {
            return undefined;
        }
    }

    private buildSafeFixEdit(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        code: string,
    ): vscode.WorkspaceEdit | undefined {
        if (code === 'SQL007') {
            const text = document.getText(diagnostic.range);
            const match = text.match(/^(\w+)\.(\w+)$/);
            if (!match) {
                return undefined;
            }
            const [, db, table] = match;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, diagnostic.range, `${db}..${table}`);
            return edit;
        }

        if (code === 'SQL012') {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, diagnostic.range.end, '(100)');
            return edit;
        }

        if (code === 'NZ007') {
            const replacement = this.getKeywordCaseReplacement(document, diagnostic);
            if (!replacement) {
                return undefined;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, diagnostic.range, replacement);
            return edit;
        }

        if (code === 'NZ012' || code === 'SQL046') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, diagnostic.range, '');
            return edit;
        }

        if (code === 'NZP012') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, diagnostic.range, ERROR_CODE_ACTIONS.NZP012.fix);
            return edit;
        }

        if (code === 'NZ021') {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, diagnostic.range, '');
            return edit;
        }

        return undefined;
    }

    /**
     * Returns the offset edits that Fix All Safe would apply for a diagnostic,
     * or undefined when the code is not Fix All eligible or no edit applies.
     */
    private computeSafeFixAllEdits(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): SafeFixAllEdit[] | undefined {
        const code = this.getDiagnosticCode(diagnostic);
        if (!SAFE_FIX_ALL_CODES.has(code)) {
            return undefined;
        }
        const start = document.offsetAt(diagnostic.range.start);
        const end = document.offsetAt(diagnostic.range.end);

        if (code === 'SQL007') {
            const text = document.getText(diagnostic.range);
            const match = text.match(/^(\w+)\.(\w+)$/);
            if (!match) return undefined;
            return [{ start, end, newText: `${match[1]}..${match[2]}`, target: diagnostic.range }];
        }

        if (code === 'SQL012') {
            return [{ start: end, end, newText: '(100)', target: diagnostic.range.end }];
        }

        if (code === 'NZ007') {
            const replacement = this.getKeywordCaseReplacement(document, diagnostic);
            if (!replacement) return undefined;
            return [{ start, end, newText: replacement, target: diagnostic.range }];
        }

        if (code === 'SQL046') {
            // Same production edit as the single SQL046 action (also removes the following space).
            const contract = buildNetezzaQuickFix('SQL046', diagnostic.range, document.getText());
            const range = contract.edit.range as vscode.Range;
            return [{
                start: document.offsetAt(range.start),
                end: document.offsetAt(range.end),
                newText: contract.edit.newText,
                target: range,
            }];
        }

        if (code === 'NZ012' || code === 'NZ021' || code === 'PAR002') {
            return [{ start, end, newText: '', target: diagnostic.range }];
        }

        if (code === 'NZP012') {
            return [{ start, end, newText: ERROR_CODE_ACTIONS.NZP012.fix, target: diagnostic.range }];
        }

        if (code === 'PAR101') {
            const insertAt = this.findMissingAsInCteInsertDocumentOffset(document, diagnostic);
            if (insertAt === undefined) return undefined;
            return [{ start: insertAt, end: insertAt, newText: ERROR_CODE_ACTIONS['PAR101'].fix, target: document.positionAt(insertAt) }];
        }

        return undefined;
    }

    private getKeywordCaseReplacement(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): string | undefined {
        const originalText = document.getText(diagnostic.range);
        if (!originalText) {
            return undefined;
        }

        const useLowerCase = /\blowercase\b/i.test(diagnostic.message);
        return useLowerCase ? originalText.toLowerCase() : originalText.toUpperCase();
    }

    private createFixAllSafeAction(
        title: string,
        kind: vscode.CodeActionKind,
        document: vscode.TextDocument,
        diagnostics: vscode.Diagnostic[]
    ): vscode.CodeAction | undefined {
        if (diagnostics.length === 0) {
            return undefined;
        }

        const action = new vscode.CodeAction(title, kind);
        action.diagnostics = diagnostics;
        const edit = new vscode.WorkspaceEdit();

        const orderedDiagnostics = diagnostics
            .slice()
            .sort((left, right) => document.offsetAt(right.range.start) - document.offsetAt(left.range.start));

        // A fix whose edits overlap an already selected edit, or insert at the
        // same offset, is skipped so the WorkspaceEdit stays valid and the result
        // does not depend on diagnostic order.
        const selected: SafeFixAllEdit[] = [];
        for (const diagnostic of orderedDiagnostics) {
            const fixEdits = this.computeSafeFixAllEdits(document, diagnostic);
            if (!fixEdits || fixEdits.length === 0) {
                continue;
            }
            const conflicts = fixEdits.some((candidate, index) =>
                fixEdits.slice(index + 1).some(other => safeFixAllEditsConflict(candidate, other))
                || selected.some(existing => safeFixAllEditsConflict(candidate, existing)));
            if (conflicts) {
                continue;
            }
            selected.push(...fixEdits);
        }

        if (selected.length === 0) {
            return undefined;
        }

        for (const fixEdit of selected) {
            applySafeFixAllEdit(document, edit, fixEdit);
        }
        action.edit = edit;
        return action;
    }

    private createFixAllSafeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        diagnostics: readonly vscode.Diagnostic[]
    ): vscode.CodeAction[] {
        const uniqueSafeDiagnostics = Array.from(
            new Map(
                diagnostics
                    .filter(diagnostic => SAFE_FIX_ALL_CODES.has(this.getDiagnosticCode(diagnostic)))
                    .map(diagnostic => {
                        const code = this.getDiagnosticCode(diagnostic);
                        const key = `${code}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.range.end.character}`;
                        return [key, diagnostic];
                    })
            ).values()
        );

        if (uniqueSafeDiagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];

        const fileFixAll = this.createFixAllSafeAction(
            'Fix all safe issues in file',
            SOURCE_FIX_ALL_KIND,
            document,
            uniqueSafeDiagnostics
        );
        if (fileFixAll) {
            actions.push(fileFixAll);
        }

        const statementBoundary = this.getStatementBoundaryForRange(document, range);
        if (!statementBoundary) {
            return actions;
        }

        const statementDiagnostics = uniqueSafeDiagnostics.filter(diagnostic => {
            const startOffset = document.offsetAt(diagnostic.range.start);
            return startOffset >= statementBoundary.startOffset && startOffset <= statementBoundary.endOffset;
        });

        const statementFixAll = this.createFixAllSafeAction(
            'Fix all safe issues in statement',
            vscode.CodeActionKind.QuickFix,
            document,
            statementDiagnostics
        );
        if (statementFixAll) {
            statementFixAll.isPreferred = true;
            actions.push(statementFixAll);
        }

        return actions;
    }

    private getUniqueDiagnosticsByRange(diagnostics: readonly vscode.Diagnostic[]): vscode.Diagnostic[] {
        return Array.from(
            new Map(
                diagnostics.map(diagnostic => {
                    const range = diagnostic.range;
                    const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
                    return [key, diagnostic] as const;
                }),
            ).values(),
        );
    }

    private createKeywordCaseFixForDiagnostics(
        document: vscode.TextDocument,
        diagnostics: readonly vscode.Diagnostic[],
    ): vscode.CodeAction | undefined {
        const nz007Diagnostics = this.getUniqueDiagnosticsByRange(
            diagnostics.filter(diagnostic => this.getDiagnosticCode(diagnostic) === 'NZ007'),
        );
        if (nz007Diagnostics.length === 0) {
            return undefined;
        }

        const edit = new vscode.WorkspaceEdit();
        const orderedDiagnostics = nz007Diagnostics
            .slice()
            .sort((left, right) => document.offsetAt(right.range.start) - document.offsetAt(left.range.start));

        let appliedCount = 0;
        for (const diagnostic of orderedDiagnostics) {
            for (const fixEdit of this.computeSafeFixAllEdits(document, diagnostic) ?? []) {
                applySafeFixAllEdit(document, edit, fixEdit);
                appliedCount++;
            }
        }

        if (appliedCount === 0) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS.NZ007.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = orderedDiagnostics;
        action.isPreferred = true;
        action.edit = edit;
        return action;
    }

    private createProcedureElsifFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const edit = this.buildSafeFixEdit(document, diagnostic, 'NZP012');
        if (!edit) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS.NZP012.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = edit;
        return action;
    }

    private createDoubleCommaFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['NZ021'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, '');
        return action;
    }

    private createDuplicateKeywordFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const action = new vscode.CodeAction('Remove duplicate keyword', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, '');
        return action;
    }

    private createKeywordTypoFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const message = diagnostic.message;
        const match = message.match(/Did you mean '(\w+)'\?/);
        if (!match) return undefined;
        const fix = match[1];
        const action = new vscode.CodeAction(`Fix typo: ${fix}`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, fix);
        return action;
    }

    private createParameterizedTemplateActions(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction[] {
        const code = this.getDiagnosticCode(diagnostic);
        const actions: vscode.CodeAction[] = [];

        if (code === 'NZ002' || code === 'NZ003' || code === 'SQL043' || code === 'SQL044') {
            const predicateTemplate = this.createTemplateStatementAppendAction(
                'Template: Add WHERE <condition>',
                document,
                diagnostic,
                ' WHERE <condition>'
            );
            if (predicateTemplate) {
                actions.push(predicateTemplate);
            }

            const keyTemplate = this.createTemplateStatementAppendAction(
                'Template: Add WHERE <key_column> IN (<value_1>, <value_2>)',
                document,
                diagnostic,
                ' WHERE <key_column> IN (<value_1>, <value_2>)'
            );
            if (keyTemplate) {
                actions.push(keyTemplate);
            }
        }

        if (code === 'NZ004') {
            actions.push(
                this.createTemplateReplaceAction(
                    'Template: Convert to INNER JOIN with predicate placeholder',
                    document,
                    diagnostic,
                    'INNER JOIN /* ON <left_alias>.<column> = <right_alias>.<column> */'
                ),
                this.createTemplateReplaceAction(
                    'Template: Convert to LEFT JOIN with predicate placeholder',
                    document,
                    diagnostic,
                    'LEFT JOIN /* ON <left_alias>.<column> = <right_alias>.<column> */'
                )
            );
        }

        if (code === 'NZ011' || code === 'SQL045') {
            const distributionTemplate = this.createTemplateStatementAppendAction(
                'Template: Add DISTRIBUTE ON (<distribution_key>)',
                document,
                diagnostic,
                ' DISTRIBUTE ON (<distribution_key>)'
            );
            if (distributionTemplate) {
                actions.push(distributionTemplate);
            }
        }

        if (code === 'NZ015') {
            actions.push(
                this.createTemplateCommentAction(
                    'Template: Rewrite function predicate to range filter',
                    document,
                    diagnostic,
                    'TEMPLATE NZ015: <column_name> >= <start_value> AND <column_name> < <end_value>'
                )
            );
        }

        if (code === 'NZ020') {
            actions.push(
                this.createTemplateCommentAction(
                    'Template: Rewrite IN subquery to EXISTS',
                    document,
                    diagnostic,
                    'TEMPLATE NZ020 EXISTS: EXISTS (SELECT 1 FROM <subquery_table> s WHERE s.<join_key> = <outer_alias>.<join_key>)'
                ),
                this.createTemplateCommentAction(
                    'Template: Rewrite IN subquery to INNER JOIN',
                    document,
                    diagnostic,
                    'TEMPLATE NZ020 JOIN: INNER JOIN <subquery_table> s ON s.<join_key> = <outer_alias>.<join_key>'
                )
            );
        }

        if (code === 'NZP001') {
            actions.push(
                this.createTemplateInsertAction(
                    'Template: Add BEGIN_PROC/END_PROC skeleton',
                    document,
                    diagnostic,
                    document.offsetAt(diagnostic.range.start),
                    '/* TEMPLATE NZP001:\nAS BEGIN_PROC\nBEGIN\n    <procedure_body>\nEND;\nEND_PROC;\n*/\n'
                )
            );
        }

        if (code === 'NZP002') {
            const nzplsqlAction = this.createTemplateProcedureClauseAction(
                'Template: Add LANGUAGE NZPLSQL',
                document,
                diagnostic,
                'LANGUAGE NZPLSQL',
                [/\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (nzplsqlAction) {
                actions.push(nzplsqlAction);
            }

            const sqlAction = this.createTemplateProcedureClauseAction(
                'Template: Add LANGUAGE SQL',
                document,
                diagnostic,
                'LANGUAGE SQL',
                [/\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (sqlAction) {
                actions.push(sqlAction);
            }
        }

        if (code === 'NZP003') {
            const integerReturn = this.createTemplateProcedureClauseAction(
                'Template: Add RETURNS INTEGER',
                document,
                diagnostic,
                'RETURNS INTEGER',
                [/\bEXECUTE\s+AS\b/i, /\bLANGUAGE\b/i, /\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (integerReturn) {
                actions.push(integerReturn);
            }

            const varcharReturn = this.createTemplateProcedureClauseAction(
                'Template: Add RETURNS VARCHAR(<length>)',
                document,
                diagnostic,
                'RETURNS VARCHAR(<length>)',
                [/\bEXECUTE\s+AS\b/i, /\bLANGUAGE\b/i, /\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (varcharReturn) {
                actions.push(varcharReturn);
            }
        }

        if (code === 'NZP011') {
            actions.push(
                this.createTemplateCommentAction(
                    'Template: Add SELECT ... INTO <target_variable>',
                    document,
                    diagnostic,
                    'TEMPLATE NZP011: SELECT <expression> INTO <target_variable> FROM <source_table> WHERE <condition>;'
                )
            );
        }

        if (code === 'NZP013') {
            actions.push(
                this.createTemplateInsertAction(
                    'Template: Insert THEN with branch body placeholder',
                    document,
                    diagnostic,
                    document.offsetAt(diagnostic.range.end),
                    ' THEN /* <branch_body> */'
                )
            );
        }

        if (code === 'NZP024') {
            const genericReturn = this.createTemplateReturnAction(
                'Template: Add RETURN <result_value>',
                document,
                diagnostic,
                'RETURN <result_value>;'
            );
            if (genericReturn) {
                actions.push(genericReturn);
            }

            const nullReturn = this.createTemplateReturnAction(
                'Template: Add RETURN NULL',
                document,
                diagnostic,
                'RETURN NULL;'
            );
            if (nullReturn) {
                actions.push(nullReturn);
            }
        }

        if (code === 'NZP027') {
            const ownerAction = this.createTemplateProcedureClauseAction(
                'Template: Add EXECUTE AS OWNER',
                document,
                diagnostic,
                'EXECUTE AS OWNER',
                [/\bLANGUAGE\b/i, /\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (ownerAction) {
                actions.push(ownerAction);
            }

            const callerAction = this.createTemplateProcedureClauseAction(
                'Template: Add EXECUTE AS CALLER',
                document,
                diagnostic,
                'EXECUTE AS CALLER',
                [/\bLANGUAGE\b/i, /\bAS\b/i, /\bBEGIN_PROC\b/i]
            );
            if (callerAction) {
                actions.push(callerAction);
            }
        }

        if (code === 'NZP028') {
            const arrayNameMatch = diagnostic.message.match(/VARRAY '([^']+)'/i);
            const arrayName = arrayNameMatch ? arrayNameMatch[1] : '<array_name>';
            actions.push(
                this.createTemplateCommentAction(
                    `Template: Add ${arrayName}.EXTEND(<size>) initialization`,
                    document,
                    diagnostic,
                    `TEMPLATE NZP028: ${arrayName}.EXTEND(<size>); -- place before first assignment`
                )
            );
        }

        return actions;
    }

    private createTemplateStatementAppendAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        appendText: string
    ): vscode.CodeAction | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }
        return this.createTemplateInsertAction(title, document, diagnostic, statementBoundary.endOffset, appendText);
    }

    private createTemplateInsertAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        insertOffset: number,
        text: string
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(insertOffset), text);
        return action;
    }

    private createTemplateReplaceAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        replacementText: string
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, replacementText);
        return action;
    }

    private createTemplateCommentAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        templateComment: string
    ): vscode.CodeAction {
        const commentText = `/* ${templateComment} */\n`;
        return this.createTemplateInsertAction(
            title,
            document,
            diagnostic,
            document.offsetAt(diagnostic.range.start),
            commentText
        );
    }

    private createTemplateProcedureClauseAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        clauseText: string,
        anchorPatterns: RegExp[]
    ): vscode.CodeAction | undefined {
        const sql = document.getText();
        const insertOffset = this.findProcedureClauseInsertionOffset(sql, anchorPatterns);
        if (insertOffset === undefined) {
            return undefined;
        }
        return this.createTemplateInsertAction(title, document, diagnostic, insertOffset, `\n${clauseText}`);
    }

    private createTemplateReturnAction(
        title: string,
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        returnStatement: string
    ): vscode.CodeAction | undefined {
        const sql = document.getText();
        const insertOffset = this.findProcedureReturnInsertionOffset(sql);
        if (insertOffset === undefined) {
            return undefined;
        }
        return this.createTemplateInsertAction(title, document, diagnostic, insertOffset, `\n    ${returnStatement}\n`);
    }

    private findProcedureHeaderEndOffset(sql: string): number | undefined {
        const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
        if (!createMatch) {
            return undefined;
        }

        const openParenIndex = sql.indexOf('(', createMatch.index + createMatch[0].length);
        if (openParenIndex === -1) {
            return createMatch.index + createMatch[0].length;
        }

        let depth = 0;
        for (let index = openParenIndex; index < sql.length; index++) {
            const char = sql[index];
            if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
                if (depth === 0) {
                    return index + 1;
                }
            }
        }

        return undefined;
    }

    private findProcedureClauseInsertionOffset(sql: string, anchorPatterns: RegExp[]): number | undefined {
        const headerEndOffset = this.findProcedureHeaderEndOffset(sql);
        if (headerEndOffset === undefined) {
            return undefined;
        }
        const anchorOffset = this.findFirstMatchOffsetAfter(sql, headerEndOffset, anchorPatterns);
        return anchorOffset ?? headerEndOffset;
    }

    private findFirstMatchOffsetAfter(sql: string, startOffset: number, patterns: RegExp[]): number | undefined {
        let bestOffset: number | undefined;

        for (const pattern of patterns) {
            const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
            const regex = new RegExp(pattern.source, flags);
            regex.lastIndex = startOffset;
            const match = regex.exec(sql);
            if (!match) {
                continue;
            }

            if (bestOffset === undefined || match.index < bestOffset) {
                bestOffset = match.index;
            }
        }

        return bestOffset;
    }

    private findProcedureReturnInsertionOffset(sql: string): number | undefined {
        const beginProcMatch = /\bBEGIN_PROC\b/i.exec(sql);
        const endProcMatch = /\bEND_PROC\b/i.exec(sql);
        if (!beginProcMatch || !endProcMatch || endProcMatch.index <= beginProcMatch.index) {
            return undefined;
        }

        const procedureBody = sql.substring(beginProcMatch.index, endProcMatch.index);
        const exceptionMatch = /\bEXCEPTION\b/i.exec(procedureBody);
        if (exceptionMatch) {
            return beginProcMatch.index + exceptionMatch.index;
        }

        const endStatementPattern = /\bEND\s*;/gi;
        let endStatementMatch: RegExpExecArray | null;
        let lastEndStatementMatch: RegExpExecArray | undefined;
        while ((endStatementMatch = endStatementPattern.exec(procedureBody)) !== null) {
            lastEndStatementMatch = endStatementMatch;
        }

        if (lastEndStatementMatch) {
            return beginProcMatch.index + lastEndStatementMatch.index;
        }

        return endProcMatch.index;
    }

    /**
     * Creates a Quick Fix to add "DISTRIBUTE ON RANDOM" to a CTAS statement
     */
    private createDistributeOnRandomFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction('Add DISTRIBUTE ON RANDOM', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = false; // review-required: not preferred

        // Find where the statement ends to insert the clause
        const offset = document.offsetAt(diagnostic.range.start);
        const text = document.getText();

        // Use SqlParser to find the statement boundaries
        const statement = SqlParser.getStatementAtPosition(text, offset);

        if (!statement) return undefined;

        // Logic: SqlParser returns 'end' as the index of the semicolon (or EOF)
        // So inserting at 'end' positions it correctly before the semicolon.
        // We ensure there is a space before.

        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(statement.end), ' DISTRIBUTE ON RANDOM');

        return action;
    }

    /**
     * Creates a Quick Fix to convert DB.TABLE to DB..TABLE (Netezza syntax)
     */
    private createDbTableFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const edit = this.buildSafeFixEdit(document, diagnostic, 'SQL007');
        if (!edit) {
            return undefined;
        }

        const suggestedFix = this.getDiagnosticSuggestedFix(diagnostic);
        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['SQL007'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = !suggestedFix;
        action.edit = edit;
        return action;
    }

    /**
     * Creates a Quick Fix to add length to VARCHAR type
     */
    private createVarcharLengthFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const edit = this.buildSafeFixEdit(document, diagnostic, 'SQL012');
        if (!edit) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['SQL012'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = edit;
        return action;
    }

    private createMissingAsInCteFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        const lexResult = SqlLexer.tokenize(statementBoundary.sql);
        if (lexResult.errors.length > 0) {
            return undefined;
        }

        const diagnosticOffsetInStatement = document.offsetAt(diagnostic.range.start) - statementBoundary.startOffset;
        const insertOffset = this.findMissingAsInCteInsertOffset(lexResult.tokens, diagnosticOffsetInStatement);
        if (insertOffset === undefined) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['PAR101'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(statementBoundary.startOffset + insertOffset), ERROR_CODE_ACTIONS['PAR101'].fix);
        return action;
    }

    private findMissingAsInCteInsertDocumentOffset(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): number | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }
        const lexResult = SqlLexer.tokenize(statementBoundary.sql);
        if (lexResult.errors.length > 0) {
            return undefined;
        }
        const diagnosticOffsetInStatement = document.offsetAt(diagnostic.range.start) - statementBoundary.startOffset;
        const insertOffset = this.findMissingAsInCteInsertOffset(lexResult.tokens, diagnosticOffsetInStatement);
        return insertOffset === undefined ? undefined : statementBoundary.startOffset + insertOffset;
    }

    private findMissingAsInCteInsertOffset(tokens: IToken[], diagnosticOffsetInStatement: number): number | undefined {
        let bestOffset: number | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let index = 2; index < tokens.length - 1; index++) {
            const lParenToken = tokens[index];
            if (lParenToken.tokenType.name !== 'LParen') {
                continue;
            }

            const cteNameToken = tokens[index - 1];
            const cteLeadToken = tokens[index - 2];
            const firstInnerToken = tokens[index + 1];
            if (!cteNameToken || !cteLeadToken || !firstInnerToken) {
                continue;
            }

            if (!this.isIdentifierTokenName(cteNameToken.tokenType.name)) {
                continue;
            }

            if (!this.isCteLeadTokenName(cteLeadToken.tokenType.name)) {
                continue;
            }

            if (!this.isCteQueryStartTokenName(firstInnerToken.tokenType.name)) {
                continue;
            }

            if (!this.hasWithKeywordBefore(tokens, index - 2)) {
                continue;
            }

            const candidateOffset = lParenToken.startOffset;
            if (candidateOffset === undefined) {
                continue;
            }

            const distance = Math.abs(candidateOffset - diagnosticOffsetInStatement);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestOffset = candidateOffset;
            }
        }

        return bestOffset;
    }

    private isIdentifierTokenName(tokenName: string): boolean {
        return tokenName === 'Identifier' || tokenName === 'QuotedIdentifier';
    }

    private isCteLeadTokenName(tokenName: string): boolean {
        return tokenName === 'With' || tokenName === 'Recursive' || tokenName === 'Comma';
    }

    private isCteQueryStartTokenName(tokenName: string): boolean {
        return tokenName === 'Select' || tokenName === 'With' || tokenName === 'Insert' || tokenName === 'Update' || tokenName === 'Delete';
    }

    private hasWithKeywordBefore(tokens: IToken[], startIndex: number): boolean {
        for (let index = startIndex; index >= 0; index--) {
            const tokenName = tokens[index].tokenType.name;
            if (tokenName === 'With') {
                return true;
            }
            if (tokenName === 'Semicolon') {
                return false;
            }
        }
        return false;
    }

    private getStatementBoundary(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): { startOffset: number; endOffset: number; sql: string } | undefined {
        const text = document.getText();
        const offset = document.offsetAt(diagnostic.range.start);
        const statement = SqlParser.getStatementAtPosition(text, offset);
        if (!statement) {
            return undefined;
        }
        return {
            startOffset: statement.start,
            endOffset: statement.end,
            sql: statement.sql
        };
    }

    private createWhereGuardFix(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        code: 'NZ002' | 'NZ003' | 'SQL043' | 'SQL044'
    ): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS[code].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = false; // review-required: not preferred

        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(
            document.uri,
            document.positionAt(statementBoundary.endOffset),
            ERROR_CODE_ACTIONS[code].fix
        );
        return action;
    }

    private createFetchFirstFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['NZ006'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];

        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(
            document.uri,
            document.positionAt(statementBoundary.endOffset),
            ERROR_CODE_ACTIONS['NZ006'].fix
        );
        return action;
    }

    private createSelectStarExpansionFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        const validator = createSqlValidatorForDocument(document.uri.toString());
        const validationResult = validator.validate(statementBoundary.sql);
        const expandedColumns = this.buildExpandedSelectStarColumns(validationResult.scope);
        if (expandedColumns.length === 0) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['NZ001'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, expandedColumns.join(', '));
        return action;
    }

    private createCrossJoinFix(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
    ): vscode.CodeAction | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        const parsed = parseSqlStatements({
            sql: statementBoundary.sql,
            databaseKind: this.getDocumentDatabaseKind(document),
        });
        if (!parsed.cst || parsed.lexResult.errors.length > 0 || parsed.actionableParserErrors.length > 0) {
            return undefined;
        }

        const diagnosticOffset = document.offsetAt(diagnostic.range.start) - statementBoundary.startOffset;
        const joinRewrite = this.findCrossJoinSpan(parsed.cst, diagnosticOffset);
        if (!joinRewrite) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['NZ004'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = false; // review-required: not preferred
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(
            document.uri,
            {
                start: document.positionAt(statementBoundary.startOffset + joinRewrite.startOffset),
                end: document.positionAt(statementBoundary.startOffset + joinRewrite.joinEndOffset),
            } as vscode.Range,
            'INNER JOIN',
        );
        if (!joinRewrite.hasCondition) {
            const conditionPosition = document.positionAt(
                statementBoundary.startOffset + joinRewrite.tableSourceEndOffset,
            );
            action.edit.insert(document.uri, conditionPosition, ' ON 1=1');
        }
        return action;
    }

    private findCrossJoinSpan(
        root: CstNode,
        diagnosticOffset: number,
    ): {
        startOffset: number;
        joinEndOffset: number;
        tableSourceEndOffset: number;
        hasCondition: boolean;
    } | undefined {
        const visit = (node: CstNode): {
            startOffset: number;
            joinEndOffset: number;
            tableSourceEndOffset: number;
            hasCondition: boolean;
        } | undefined => {
            if (node.name === 'joinClause') {
                const cross = this.getDirectToken(node, 'Cross');
                const join = this.getDirectToken(node, 'Join');
                if (cross && join && cross.startOffset !== undefined && join.endOffset !== undefined) {
                    const startOffset = cross.startOffset;
                    const joinEndOffset = join.endOffset + 1;
                    if (diagnosticOffset >= startOffset && diagnosticOffset <= joinEndOffset) {
                        const tableSource = node.children?.tableSource?.[0];
                        if (!tableSource || !this.isCstNode(tableSource)) {
                            return undefined;
                        }
                        const lastTableSourceToken = this.getLastToken(tableSource);
                        if (lastTableSourceToken?.endOffset === undefined) {
                            return undefined;
                        }
                        return {
                            startOffset,
                            joinEndOffset,
                            tableSourceEndOffset: lastTableSourceToken.endOffset + 1,
                            hasCondition: Boolean(
                                this.getDirectToken(node, 'On') || this.getDirectToken(node, 'Using'),
                            ),
                        };
                    }
                }
            }

            for (const children of Object.values(node.children ?? {})) {
                for (const child of children) {
                    if (this.isCstNode(child)) {
                        const found = visit(child);
                        if (found) {
                            return found;
                        }
                    }
                }
            }
            return undefined;
        };

        return visit(root);
    }

    private getLastToken(node: CstNode): IToken | undefined {
        let lastToken: IToken | undefined;
        for (const children of Object.values(node.children ?? {})) {
            for (const child of children) {
                const candidate = this.isCstNode(child)
                    ? this.getLastToken(child)
                    : child as IToken;
                if (
                    candidate?.endOffset !== undefined &&
                    (lastToken?.endOffset === undefined || candidate.endOffset > lastToken.endOffset)
                ) {
                    lastToken = candidate;
                }
            }
        }
        return lastToken;
    }

    private getDirectToken(node: CstNode, childName: string): IToken | undefined {
        const child = node.children?.[childName]?.[0];
        return child && !this.isCstNode(child) ? child as IToken : undefined;
    }

    private isCstNode(value: unknown): value is CstNode {
        return typeof value === 'object' && value !== null && 'name' in value && 'children' in value;
    }

    private createSuggestedColumnFix(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
    ): vscode.CodeAction | undefined {
        const suggestedFix = this.getDiagnosticSuggestedFix(diagnostic);
        if (!suggestedFix) {
            return undefined;
        }

        const action = new vscode.CodeAction(
            `Did you mean '${suggestedFix}'?`,
            vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, suggestedFix);
        return action;
    }

    private buildExpandedSelectStarColumns(scope: Scope): string[] {
        const visibleTables = this.getVisibleTables(scope);
        if (visibleTables.length === 0) {
            return [];
        }

        const useQualifier = visibleTables.length > 1;
        const columns: string[] = [];
        const seenColumns = new Set<string>();

        for (const table of visibleTables) {
            const qualifier = table.alias || table.name;
            if (!qualifier) {
                continue;
            }

            for (const column of table.columns) {
                const columnName = column.alias || column.name;
                if (!columnName) {
                    continue;
                }

                const expandedColumn = useQualifier ? `${qualifier}.${columnName}` : columnName;
                const dedupeKey = expandedColumn.toUpperCase();
                if (seenColumns.has(dedupeKey)) {
                    continue;
                }

                seenColumns.add(dedupeKey);
                columns.push(expandedColumn);
            }
        }

        return columns;
    }

    private getVisibleTables(scope: Scope): TableInfo[] {
        const tables: TableInfo[] = [];
        scope.tables.forEach(table => {
            tables.push(table);
        });
        scope.ctes.forEach(cte => {
            tables.push(cte);
        });
        return tables;
    }

    private createTableQualificationFixes(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        preferredFirst: boolean,
    ): vscode.CodeAction[] {
        const suggestedFix = this.getDiagnosticSuggestedFix(diagnostic);
        const parsed = this.parseTableReferenceFromDiagnostic(document, diagnostic);
        const resolverProposals = parsed && this.deps
            ? proposeTableQualification(
                {
                    connectionManager: this.deps.connectionManager,
                    metadataCache: this.deps.metadataCache,
                },
                {
                    ...parsed,
                    documentUri: document.uri.toString(),
                },
            )
            : [];

        const actionProposals = collectQualificationActionProposals(
            suggestedFix,
            resolverProposals,
        );
        const preferredIndex = resolveQualificationPreferredIndex(
            actionProposals,
            preferredFirst,
        );

        return actionProposals.map((proposal, index) => {
            const action = new vscode.CodeAction(
                `Qualify as ${proposal.qualifiedText}`,
                vscode.CodeActionKind.QuickFix,
            );
            action.diagnostics = [diagnostic];
            action.isPreferred = index === preferredIndex;
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, proposal.qualifiedText);
            return action;
        });
    }

    private parseTableReferenceFromDiagnostic(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
    ): { database?: string; schema?: string; name: string } | undefined {
        return parseTableReferenceText(
            document.getText(diagnostic.range),
            this.resolveDatabaseKind?.(document.uri.toString()),
        );
    }

    private getDiagnosticSuggestedFix(diagnostic: vscode.Diagnostic): string | undefined {
        const data = (diagnostic as unknown as { data?: { suggestedFix?: unknown } }).data;
        return typeof data?.suggestedFix === 'string' && data.suggestedFix.trim()
            ? data.suggestedFix.trim()
            : undefined;
    }

    private createAmbiguousColumnQualificationFixes(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction[] {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return [];
        }

        const ambiguousColumn = document.getText(diagnostic.range).trim();
        if (!ambiguousColumn) {
            return [];
        }

        const aliasBindings = parseSemanticScopeWithParser(
            statementBoundary.sql,
            undefined,
            this.getDocumentDatabaseKind(document)
        ).preferredAliasBindings;
        const qualifiers = this.getPreferredQualifiers(aliasBindings).slice(0, 6);
        if (qualifiers.length === 0) {
            return [];
        }

        return qualifiers.map((qualifier, index) => {
            const action = new vscode.CodeAction(
                `Qualify column with '${qualifier}'`,
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            if (index === 0) {
                action.isPreferred = true;
            }
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, `${qualifier}.${ambiguousColumn}`);
            return action;
        });
    }

    private createMissingAliasFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const statementBoundary = this.getStatementBoundary(document, diagnostic);
        if (!statementBoundary) {
            return undefined;
        }

        const aliasBindings = parseSemanticScopeWithParser(
            statementBoundary.sql,
            undefined,
            this.getDocumentDatabaseKind(document)
        ).preferredAliasBindings;
        const usedAliases = new Set<string>(Array.from(aliasBindings.keys()).map(alias => alias.toUpperCase()));
        const diagnosticOffsetInStatement = document.offsetAt(diagnostic.range.start) - statementBoundary.startOffset;
        const missingAliasTarget = this.findMissingAliasTarget(
            statementBoundary.sql,
            diagnosticOffsetInStatement,
        );
        if (!missingAliasTarget) {
            return undefined;
        }

        const aliasName = this.generateAliasName(missingAliasTarget.tableName, usedAliases);
        const action = new vscode.CodeAction(
            `Add missing table alias '${aliasName}'${missingAliasTarget.referenceRanges.length > 0 ? ' and update references' : ''}`,
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        const absoluteInsertOffset = statementBoundary.startOffset + missingAliasTarget.insertOffset;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(absoluteInsertOffset), ` ${aliasName}`);
        for (const reference of missingAliasTarget.referenceRanges) {
            action.edit.replace(
                document.uri,
                {
                    start: document.positionAt(statementBoundary.startOffset + reference.startOffset),
                    end: document.positionAt(statementBoundary.startOffset + reference.endOffset),
                } as vscode.Range,
                aliasName,
            );
        }
        return action;
    }

    private getDocumentDatabaseKind(document: vscode.TextDocument): DatabaseKind | undefined {
        const documentUri = document.uri?.toString();
        if (!documentUri) {
            return undefined;
        }

        return this.resolveDatabaseKind?.(documentUri);
    }

    private createUpdateAliasAsFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const code = this.getDiagnosticCode(diagnostic);
        if (code === 'SQL046') {
            const contract = buildNetezzaQuickFix('SQL046', diagnostic.range, document.getText());
            const action = new vscode.CodeAction(contract.title, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(
                document.uri,
                contract.edit.range as vscode.Range,
                contract.edit.newText,
            );
            return action;
        }

        const edit = this.buildSafeFixEdit(document, diagnostic, 'NZ012');
        if (!edit) {
            return undefined;
        }

        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS.NZ012.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = edit;
        return action;
    }

    private createEqualsNullFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const contract = buildNetezzaQuickFix('NZL006', diagnostic.range, document.getText());
        const action = new vscode.CodeAction(contract.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(
            document.uri,
            contract.edit.range as vscode.Range,
            contract.edit.newText,
        );
        return action;
    }

    private createUnionAllFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const action = new vscode.CodeAction(ERROR_CODE_ACTIONS['NZ013'].title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = false; // review-required: not preferred
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, ERROR_CODE_ACTIONS['NZ013'].fix);
        return action;
    }

    /**
     * Creates a Quick Fix to remove an unused CTE
     */
    private createRemoveUnusedCteFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction('Remove unused CTE', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        const text = document.getText();
        const offset = document.offsetAt(diagnostic.range.start);
        const statement = SqlParser.getStatementAtPosition(text, offset);
        if (!statement) {
            return undefined;
        }

        const cteName = document.getText(diagnostic.range);
        const lexResult = SqlLexer.tokenize(statement.sql);
        if (lexResult.errors.length > 0) {
            return undefined;
        }

        const cteRange = this.findCteDefinitionRange(lexResult.tokens, cteName, statement.start);
        if (!cteRange) {
            return undefined;
        }

        action.edit = new vscode.WorkspaceEdit();
        action.edit.delete(document.uri, new vscode.Range(
            document.positionAt(cteRange.removeStart),
            document.positionAt(cteRange.removeEnd)
        ));

        return action;
    }

    private findCteDefinitionRange(
        tokens: IToken[],
        cteName: string,
        statementStartOffset: number,
    ): { removeStart: number; removeEnd: number } | undefined {
        const upperName = cteName.toUpperCase();
        let cteTokenIndex = -1;

        for (let i = 0; i < tokens.length - 2; i++) {
            const leadName = tokens[i].tokenType.name;
            if (leadName !== 'With' && leadName !== 'Recursive' && leadName !== 'Comma') {
                continue;
            }
            const nameToken = tokens[i + 1];
            if (!this.isIdentifierTokenName(nameToken.tokenType.name)) {
                continue;
            }
            if (nameToken.image.toUpperCase() !== upperName) {
                continue;
            }
            if (tokens[i + 2].tokenType.name !== 'LParen') {
                continue;
            }
            cteTokenIndex = i + 1;
            break;
        }

        if (cteTokenIndex === -1) {
            return undefined;
        }

        const cteNameToken = tokens[cteTokenIndex];
        const cteBodyStart = cteNameToken.startOffset;

        let depth = 0;
        let cteBodyEnd = -1;
        for (let i = cteTokenIndex + 1; i < tokens.length; i++) {
            const name = tokens[i].tokenType.name;
            if (name === 'LParen') {
                depth++;
            } else if (name === 'RParen') {
                depth--;
                if (depth === 0) {
                    cteBodyEnd = (tokens[i].endOffset ?? tokens[i].startOffset) + 1;
                    break;
                }
            }
        }

        if (cteBodyEnd === -1) {
            return undefined;
        }

        const absoluteCteStart = statementStartOffset + cteBodyStart;
        const absoluteCteEnd = statementStartOffset + cteBodyEnd;

        const withTokenIndex = this.findLastWithBefore(cteTokenIndex, tokens);
        const absoluteWithEnd = withTokenIndex !== -1
            ? statementStartOffset + (tokens[withTokenIndex].endOffset ?? tokens[withTokenIndex].startOffset)
            : statementStartOffset;

        // Scan forward from CTE body end with depth tracking to find comma at depth 0
        // (CTE-separating comma) before any main-query keyword (SELECT/INSERT/UPDATE etc.)
        let hasNextCte = false;
        let commaAtDepth0: IToken | undefined;
        let scanDepth = 0;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.startOffset < cteBodyEnd) continue;

            const name = t.tokenType.name;
            if (name === 'LParen') scanDepth++;
            else if (name === 'RParen' && scanDepth > 0) scanDepth--;

            if (scanDepth > 0) continue;

            if (name === 'Comma') {
                hasNextCte = true;
                commaAtDepth0 = t;
                break;
            }

            if (name === 'Select' || name === 'Insert' || name === 'Update' || name === 'Delete' || name === 'Merge' || name === 'Truncate') {
                break;
            }

            if (name !== 'Whitespace' && name !== 'LineComment' && name !== 'MultiLineComment') {
                break;
            }
        }

        const hasCommaBefore = cteTokenIndex > 1
            && tokens[cteTokenIndex - 1]?.tokenType.name === 'Comma';

        let removeStart: number;
        let removeEnd: number;

        if (hasNextCte && commaAtDepth0) {
            removeStart = absoluteCteStart;
            removeEnd = statementStartOffset + (commaAtDepth0.endOffset ?? commaAtDepth0.startOffset) + 1;
        } else if (hasCommaBefore) {
            const commaToken = tokens.slice(0, cteTokenIndex).reverse()
                .find(t => t.tokenType.name === 'Comma');
            removeStart = commaToken
                ? statementStartOffset + commaToken.startOffset
                : absoluteCteStart;
            removeEnd = absoluteCteEnd;
        } else {
            removeStart = absoluteWithEnd;
            removeEnd = absoluteCteEnd;
        }

        if (removeStart >= removeEnd) {
            return undefined;
        }

        return { removeStart, removeEnd };
    }

    private findLastWithBefore(startIndex: number, tokens: IToken[]): number {
        for (let i = startIndex; i >= 0; i--) {
            if (tokens[i].tokenType.name === 'With') {
                return i;
            }
            if (tokens[i].tokenType.name === 'Semicolon') {
                return -1;
            }
        }
        return -1;
    }

    /**
     * Creates a Quick Fix to remove an unused table alias
     */
    private createRemoveUnusedAliasFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction('Remove unused alias', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = false; // review-required: not preferred

        // For unused aliases, we just highlight the issue - removing might break the query
        // Instead, offer to comment it
        const range = diagnostic.range;
        
        action.edit = new vscode.WorkspaceEdit();
        // Just delete the alias (keeping the table reference)
        // This is a simple fix - user may need to adjust
        action.edit.delete(document.uri, range);
        
        return action;
    }

    /**
     * Creates a Quick Fix to add an alias to a subquery
     */
    private createSubqueryAliasFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction('Add subquery alias (subq)', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        const text = document.getText();
        const range = diagnostic.range;
        const subqueryStartOffset = document.offsetAt(range.start);

        const statement = SqlParser.getStatementAtPosition(text, subqueryStartOffset);
        const sql = statement?.sql ?? text;
        const sqlOffset = statement?.start ?? 0;

        const lexResult = SqlLexer.tokenize(sql);
        if (lexResult.errors.length > 0) {
            return undefined;
        }

        const relativeOffset = subqueryStartOffset - sqlOffset;
        const rparenOffset = this.findSubqueryCloseParen(lexResult.tokens, relativeOffset);
        if (rparenOffset === undefined) {
            return undefined;
        }

        const insertOffset = sqlOffset + rparenOffset + 1;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(insertOffset), ' AS subq');

        return action;
    }

    private findSubqueryCloseParen(tokens: IToken[], subqueryOffset: number): number | undefined {
        let lparenIndex = -1;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].tokenType.name === 'LParen'
                && tokens[i].startOffset <= subqueryOffset
                && (i + 1 < tokens.length)
                && tokens[i + 1].startOffset >= subqueryOffset) {
                lparenIndex = i;
                break;
            }
        }

        if (lparenIndex === -1) {
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].tokenType.name === 'LParen'
                    && Math.abs(tokens[i].startOffset - subqueryOffset) <= 1) {
                    lparenIndex = i;
                    break;
                }
            }
        }

        if (lparenIndex === -1) {
            return undefined;
        }

        let depth = 1;
        for (let i = lparenIndex + 1; i < tokens.length; i++) {
            const name = tokens[i].tokenType.name;
            if (name === 'LParen') {
                depth++;
            } else if (name === 'RParen') {
                depth--;
                if (depth === 0) {
                    return tokens[i].startOffset;
                }
            }
        }

        return undefined;
    }

    private getPreferredQualifiers(aliasBindings: Map<string, { db?: string; schema?: string; table: string }>): string[] {
        const groups = new Map<string, { tableName: string; qualifiers: string[] }>();
        aliasBindings.forEach((binding, qualifierName) => {
            const key = `${(binding.db || '').toUpperCase()}|${(binding.schema || '').toUpperCase()}|${binding.table.toUpperCase()}`;
            const group = groups.get(key);
            if (!group) {
                groups.set(key, {
                    tableName: binding.table,
                    qualifiers: [qualifierName]
                });
                return;
            }
            group.qualifiers.push(qualifierName);
        });

        const qualifiers: string[] = [];
        groups.forEach(group => {
            const preferred =
                group.qualifiers.find(q => q.toUpperCase() !== group.tableName.toUpperCase()) ?? group.qualifiers[0];
            qualifiers.push(preferred);
        });

        return qualifiers;
    }

    private findMissingAliasTarget(
        statementSql: string,
        diagnosticOffsetInStatement: number,
    ): {
        tableName: string;
        insertOffset: number;
        referenceRanges: Array<{ startOffset: number; endOffset: number }>;
    } | undefined {
        const lexResult = SqlLexer.tokenize(statementSql);
        if (lexResult.errors.length > 0) {
            return undefined;
        }

        const tokens = lexResult.tokens;
        const candidates: Array<{
            tableName: string;
            insertOffset: number;
            sourceStart: number;
            sourceEnd: number;
        }> = [];
        const relationDefinitions: Array<{ tableName: string; sourceStart: number; sourceEnd: number }> = [];

        for (let index = 0; index < tokens.length; index++) {
            const tokenName = tokens[index].tokenType.name;
            if (tokenName !== 'Join') {
                continue;
            }

            let cursor = index + 1;
            if (cursor >= tokens.length) {
                continue;
            }

            if (tokens[cursor].tokenType.name === 'LParen') {
                continue;
            }

            let lastIdentifierToken: typeof tokens[number] | undefined;
            let identifierCount = 0;

            while (cursor < tokens.length) {
                const name = tokens[cursor].tokenType.name;
                if (name === 'Identifier' || name === 'QuotedIdentifier') {
                    lastIdentifierToken = tokens[cursor];
                    identifierCount++;
                    cursor++;
                    continue;
                }
                if (name === 'Dot') {
                    cursor++;
                    continue;
                }
                break;
            }

            if (!lastIdentifierToken || identifierCount === 0) {
                continue;
            }

            const sourceStart = tokens[index + 1].startOffset ?? 0;
            const sourceEnd = (lastIdentifierToken.endOffset ?? (lastIdentifierToken.startOffset ?? 0)) + 1;
            const insertOffset = sourceEnd;
            const tableName = lastIdentifierToken.image.replace(/^"|"$/g, '');
            relationDefinitions.push({ tableName, sourceStart, sourceEnd });

            const nextToken = tokens[cursor];
            if (nextToken) {
                const nextName = nextToken.tokenType.name;
                if (nextName === 'As') {
                    const aliasToken = tokens[cursor + 1];
                    if (aliasToken && (aliasToken.tokenType.name === 'Identifier' || aliasToken.tokenType.name === 'QuotedIdentifier')) {
                        continue;
                    }
                }
                if (nextName === 'Identifier' || nextName === 'QuotedIdentifier') {
                    continue;
                }
            }

            if (nextToken?.tokenType.name === 'On' || nextToken?.tokenType.name === 'Using') {
                candidates.push({ tableName, insertOffset, sourceStart, sourceEnd });
            }
        }

        if (candidates.length === 0) {
            return undefined;
        }

        candidates.sort(
            (left, right) =>
                Math.abs(left.sourceStart - diagnosticOffsetInStatement) -
                Math.abs(right.sourceStart - diagnosticOffsetInStatement),
        );
        const candidate = candidates[0];
        if (!candidate) {
            return undefined;
        }

        const normalizedTableName = candidate.tableName.toUpperCase();
        const sameTableDefinitions = relationDefinitions.filter(
            (definition) => definition.tableName.toUpperCase() === normalizedTableName,
        );
        if (sameTableDefinitions.length !== 1) {
            return undefined;
        }

        const referenceRanges: Array<{ startOffset: number; endOffset: number }> = [];
        for (let index = 0; index < tokens.length - 1; index++) {
            const token = tokens[index];
            const nextToken = tokens[index + 1];
            if (
                (token.tokenType.name !== 'Identifier' && token.tokenType.name !== 'QuotedIdentifier') ||
                nextToken.tokenType.name !== 'Dot' ||
                token.startOffset === undefined ||
                token.endOffset === undefined
            ) {
                continue;
            }

            const previousToken = tokens[index - 1];
            if (previousToken?.tokenType.name === 'Dot') {
                continue;
            }

            const tokenName = token.image.replace(/^"|"$/g, '');
            if (
                tokenName.toUpperCase() !== normalizedTableName ||
                token.startOffset >= candidate.sourceStart && token.startOffset < candidate.sourceEnd
            ) {
                continue;
            }

            referenceRanges.push({ startOffset: token.startOffset, endOffset: token.endOffset + 1 });
        }

        return {
            tableName: candidate.tableName,
            insertOffset: candidate.insertOffset,
            referenceRanges,
        };
    }

    private generateAliasName(tableName: string, usedAliases: Set<string>): string {
        const base = tableName.replace(/[^A-Za-z0-9_]/g, '').charAt(0).toUpperCase() || 'T';
        let index = 1;
        while (index < 1000) {
            const candidate = `${base}${index}`;
            if (!usedAliases.has(candidate.toUpperCase())) {
                return candidate;
            }
            index++;
        }
        return 'T1';
    }

    private isCopilotEligibleDiagnostic(
        diagnostic: vscode.Diagnostic,
        isTestMode: boolean,
    ): boolean {
        const code = this.getDiagnosticCode(diagnostic);
        if (!code) {
            return false;
        }
        if (!isTestMode && LSP_SERVED_CODES.has(code)) {
            return false;
        }
        return code.startsWith('NZ') || code.startsWith('SQL') || code.startsWith('NZP');
    }

    private createCopilotFixAction(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        diagnostics: readonly vscode.Diagnostic[],
        isTestMode: boolean,
    ): vscode.CodeAction | undefined {
        const eligibleDiagnostics = diagnostics.filter(diagnostic =>
            this.isCopilotEligibleDiagnostic(diagnostic, isTestMode)
        );
        if (eligibleDiagnostics.length === 0) {
            return undefined;
        }

        const statementBoundary = this.getStatementBoundaryForRange(document, range)
            ?? this.getStatementBoundary(document, eligibleDiagnostics[0]);
        const sqlContext = statementBoundary?.sql
            ?? document.getText(eligibleDiagnostics[0].range);
        if (!sqlContext.trim()) {
            return undefined;
        }

        const uniqueMessages = Array.from(new Set(eligibleDiagnostics.map(diagnostic => diagnostic.message)));
        const combinedMessage = uniqueMessages.join('\n');

        const action = new vscode.CodeAction('Fix with Copilot', vscode.CodeActionKind.QuickFix);
        action.diagnostics = eligibleDiagnostics;
        action.command = {
            title: 'Fix with Copilot',
            command: 'netezza.fixSqlError',
            arguments: [combinedMessage, sqlContext],
        };
        return action;
    }
}
