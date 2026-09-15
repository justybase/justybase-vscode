import * as vscode from 'vscode';
import { isConnectionBrokenError } from '../../../core/queryRunner';
import { createSqlValidatorForDocument } from '../../../commands/validationCommands';
import { findProcedureBlocks, type ProcedureBlock } from '../../../sqlParser/procedure/procedureCodeLens';
import type { ValidationError } from '../../../sqlParser/types';
import { CopilotToolRuntime } from './copilotToolRuntime';
import {
    buildProcedureCall,
    extractProcedureIdentity,
    findProcedureTarget,
    normalizeProcedureName,
    PROCEDURE_REPAIR_MAX_ATTEMPTS,
    type ProcedureCallArgument,
    type ProcedureRepairInput,
} from './procedureRepairUtils';

interface ProcedureCandidateContext {
    editor: vscode.TextEditor;
    documentUri: string;
    documentVersion: number;
    range: vscode.Range;
    sql: string;
    identity: NonNullable<ReturnType<typeof extractProcedureIdentity>>;
}

interface RepairSession {
    documentUri: string;
    documentVersion: number;
    key: string;
    attempts: number;
    expiresAt: number;
}

interface ProcedureRepairResult {
    status: 'success' | 'compile_error' | 'call_error' | 'cancelled' | 'blocked';
    mode: ProcedureRepairInput['mode'];
    procedureName?: string;
    attempt?: number;
    remainingAttempts?: number;
    createMode?: 'CREATE' | 'CREATE OR REPLACE';
    callSql?: string;
    editorUpdated?: boolean;
    callExecuted?: boolean;
    connectionOutcome?: 'known_failure' | 'unknown';
}

const SESSION_TTL_MS = 10 * 60 * 1000;

export class CopilotProcedureRepairService {
    private readonly sessions = new Map<string, RepairSession>();

    constructor(private readonly runtime: CopilotToolRuntime) { }

    async repairProcedure(
        input: ProcedureRepairInput,
        cancellationToken?: vscode.CancellationToken,
    ): Promise<string> {
        const candidate = this.resolveCandidate(input.sql);
        if (!candidate) {
            return this.runtime.formatStructuredToolResponse({
                summary: 'Procedure repair could not start.',
                errors: ['Select a complete CREATE [OR REPLACE] PROCEDURE block or open a document containing exactly one procedure.'],
                nextActions: ['Provide the corrected procedure SQL in the next tool call or select one complete procedure in the editor.']
            });
        }

        const callArguments = input.callArguments ?? [];
        if (input.mode === 'compile_and_call' && input.callArguments === undefined) {
            return this.runtime.formatStructuredToolResponse({
                summary: 'Procedure compilation mode was selected, but test CALL arguments were not supplied.',
                data: { procedureName: candidate.identity.name, mode: input.mode },
                errors: ['callArguments is required for compile_and_call, including an empty array for a no-argument procedure.'],
                nextActions: ['Provide typed callArguments and retry.']
            });
        }

        let callSql: string | undefined;
        try {
            if (input.mode === 'compile_and_call') {
                callSql = buildProcedureCall(candidate.identity.name, callArguments);
            }
        } catch (error: unknown) {
            return this.runtime.formatStructuredToolResponse({
                summary: 'Test CALL arguments are invalid.',
                data: { procedureName: candidate.identity.name, mode: input.mode },
                errors: [errorMessage(error)],
                nextActions: ['Use only typed string, number, boolean, null, date, or timestamp values.']
            });
        }

        const sessionKey = buildSessionKey(candidate.documentUri, input.mode, candidate.identity.name, callArguments);
        const attempt = this.startAttempt(sessionKey, candidate.documentUri, candidate.documentVersion);
        if (!attempt) {
            return this.runtime.formatStructuredToolResponse({
                summary: `Procedure repair stopped after ${PROCEDURE_REPAIR_MAX_ATTEMPTS} attempts.`,
                data: {
                    procedureName: candidate.identity.name,
                    mode: input.mode,
                    maxAttempts: PROCEDURE_REPAIR_MAX_ATTEMPTS
                },
                errors: ['The repair loop reached its hard safety limit. Edit the procedure or start a new document version before retrying.'],
                nextActions: ['Review the last database diagnostic and make a deliberate change before retrying.']
            });
        }

        const baseData: ProcedureRepairResult = {
            status: 'compile_error',
            mode: input.mode,
            procedureName: candidate.identity.name,
            createMode: candidate.identity.createMode,
            attempt: attempt.number,
            remainingAttempts: attempt.remaining,
            ...(callSql ? { callSql } : {})
        };

        if (cancellationToken?.isCancellationRequested) {
            return this.formatResult(
                { ...baseData, status: 'cancelled' },
                ['Procedure repair was cancelled before compilation.'],
                ['Retry only after confirming the target procedure and connection.']
            );
        }

        const localValidation = this.validateCandidate(candidate);
        if (localValidation.errors.length > 0) {
            return this.formatResult(
                baseData,
                localValidation.errors.map(formatLintIssue),
                [
                    'Fix the parser errors and call this tool again with the complete corrected procedure.',
                    `Attempts remaining: ${attempt.remaining}.`
                ]
            );
        }

        let compileError: unknown;
        try {
            await this.runtime.executeProcedureStatement(candidate.sql, candidate.documentUri, cancellationToken);
        } catch (error: unknown) {
            compileError = error;
        }

        if (compileError) {
            const unknownOutcome = isUnknownConnectionFailure(compileError);
            const errorData: ProcedureRepairResult = {
                ...baseData,
                status: 'compile_error',
                ...(unknownOutcome ? { connectionOutcome: 'unknown' as const } : {})
            };
            return this.formatResult(
                errorData,
                [unknownOutcome
                    ? `Compilation failed with an ambiguous connection outcome: ${errorMessage(compileError)}`
                    : `Compilation failed: ${errorMessage(compileError)}`],
                unknownOutcome
                    ? ['Do not automatically retry this DDL. Verify the database object and connection state first.']
                    : [
                        'Use the database diagnostic to prepare a corrected complete procedure and call this tool again.',
                        `Attempts remaining: ${attempt.remaining}.`
                    ]
            );
        }

        const editorUpdated = await this.applyCandidate(candidate);
        if (editorUpdated) {
            this.updateSessionDocumentVersion(sessionKey, candidate.editor.document.version);
        }
        const successData: ProcedureRepairResult = {
            ...baseData,
            status: 'success',
            editorUpdated,
            ...(input.mode === 'compile_and_call' ? { callExecuted: false } : {})
        };

        if (input.mode === 'compile_only') {
            this.sessions.delete(sessionKey);
            return this.formatResult(
                successData,
                [],
                [editorUpdated
                    ? 'The compiled procedure was inserted into the active editor. Save the file when ready.'
                    : 'The database compiled the procedure, but the editor changed during execution; review it before retrying.']
            );
        }

        const callConfirmed = await this.confirmTestCall(candidate.identity.name, callSql!, attempt.number);
        if (!callConfirmed) {
            this.sessions.delete(sessionKey);
            return this.formatResult(
                successData,
                ['Compilation succeeded; the test CALL was not executed because explicit user consent was not granted.'],
                ['Review the compiled procedure in the editor. Run the test CALL manually when it is safe.']
            );
        }

        let callError: unknown;
        let callExecution: Awaited<ReturnType<CopilotToolRuntime['executeProcedureStatement']>> | undefined;
        try {
            callExecution = await this.runtime.executeProcedureStatement(callSql!, candidate.documentUri, cancellationToken);
        } catch (error: unknown) {
            callError = error;
        }

        if (callError) {
            const unknownOutcome = isUnknownConnectionFailure(callError);
            return this.formatResult(
                {
                    ...successData,
                    status: 'call_error',
                    callExecuted: true,
                    ...(unknownOutcome ? { connectionOutcome: 'unknown' as const } : {})
                },
                [unknownOutcome
                    ? `Test CALL ended with an ambiguous connection outcome: ${errorMessage(callError)}`
                    : `Test CALL failed: ${errorMessage(callError)}`],
                unknownOutcome
                    ? ['Do not repeat the CALL automatically. Verify whether the procedure changed data before continuing.']
                    : [
                        'You may correct the procedure using this runtime diagnostic and call the tool again.',
                        `Attempts remaining: ${attempt.remaining}. Every retry executes the test CALL again and may repeat side effects.`
                    ]
            );
        }

        this.sessions.delete(sessionKey);
        return this.formatResult(
            {
                ...successData,
                status: 'success',
                callExecuted: true
            },
            [],
            [
                editorUpdated
                    ? 'The procedure compiled and the test CALL succeeded. Save the corrected procedure when ready.'
                    : 'The procedure compiled and the test CALL succeeded, but the editor changed during execution; review the database and editor state.',
                `CALL returned ${callExecution?.rowCount ?? 0} row(s)`
            ]
        );
    }

    private resolveCandidate(sqlInput?: string): ProcedureCandidateContext | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }

        const documentText = editor.document.getText();
        const blocks = findProcedureBlocks(documentText);
        const selection = editor.selection;
        const selectedText = !selection.isEmpty ? editor.document.getText(selection).trim() : '';
        const sql = (sqlInput?.trim() || selectedText || findBlockAtCursor(editor, blocks)?.sql || (blocks.length === 1 ? blocks[0].sql : '')).trim();
        if (!sql) {
            return undefined;
        }

        const identity = extractProcedureIdentity(sql);
        if (!identity || !isCompleteSingleProcedure(sql)) {
            return undefined;
        }

        let range: vscode.Range | undefined;
        if (sqlInput && selectedText && normalizeSql(selectedText) === normalizeSql(sql)) {
            range = selection;
        } else {
            const target = findProcedureTarget(blocks, sql);
            if (target) {
                range = new vscode.Range(editor.document.positionAt(target.block.startOffset), editor.document.positionAt(target.block.endOffset));
            }
        }

        if (!range) {
            return undefined;
        }

        return {
            editor,
            documentUri: editor.document.uri.toString(),
            documentVersion: editor.document.version,
            range,
            sql,
            identity
        };
    }

    private validateCandidate(candidate: ProcedureCandidateContext): { errors: ValidationError[] } {
        try {
            const result = createSqlValidatorForDocument(candidate.documentUri).validate(candidate.sql);
            return { errors: result.errors.filter(issue => issue.severity === 'error') };
        } catch {
            // Database compilation remains authoritative when the desktop
            // validator cannot initialize a document-scoped schema context.
            return { errors: [] };
        }
    }

    private async applyCandidate(candidate: ProcedureCandidateContext): Promise<boolean> {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== candidate.documentUri) {
            return false;
        }
        if (activeEditor.document.version !== candidate.documentVersion) {
            return false;
        }

        const existingText = activeEditor.document.getText(candidate.range);
        if (normalizeSql(existingText) === normalizeSql(candidate.sql)) {
            return true;
        }

        return activeEditor.edit(editBuilder => {
            editBuilder.replace(candidate.range, candidate.sql);
        });
    }

    private startAttempt(
        key: string,
        documentUri: string,
        documentVersion: number,
    ): { number: number; remaining: number } | undefined {
        const now = Date.now();
        const existing = this.sessions.get(key);
        if (existing && (existing.expiresAt <= now || existing.documentVersion !== documentVersion)) {
            this.sessions.delete(key);
        }

        const current = this.sessions.get(key);
        if (current && current.attempts >= PROCEDURE_REPAIR_MAX_ATTEMPTS) {
            return undefined;
        }

        const attempts = (current?.attempts ?? 0) + 1;
        this.sessions.set(key, {
            documentUri,
            documentVersion,
            key,
            attempts,
            expiresAt: now + SESSION_TTL_MS
        });

        return {
            number: attempts,
            remaining: PROCEDURE_REPAIR_MAX_ATTEMPTS - attempts
        };
    }

    private updateSessionDocumentVersion(key: string, documentVersion: number): void {
        const session = this.sessions.get(key);
        if (session) {
            session.documentVersion = documentVersion;
        }
    }

    private async confirmTestCall(procedureName: string, callSql: string, attempt: number): Promise<boolean> {
        const selected = await vscode.window.showWarningMessage(
            `Compilation succeeded for ${procedureName}. Execute the test CALL now? This is attempt ${attempt} and the procedure may modify database data.\n\n${callSql}`,
            { modal: true },
            'Execute test CALL'
        );
        if (selected !== 'Execute test CALL') {
            return false;
        }

        return true;
    }

    private formatResult(result: ProcedureRepairResult, errors: string[], nextActions: string[]): string {
        return this.runtime.formatStructuredToolResponse({
            summary: result.status === 'success'
                ? 'Procedure repair operation completed.'
                : 'Procedure repair operation requires another bounded attempt.',
            data: result,
            errors,
            nextActions
        });
    }
}

function findBlockAtCursor(editor: vscode.TextEditor, blocks: readonly ProcedureBlock[]): ProcedureBlock | undefined {
    const cursorOffset = editor.document.offsetAt(editor.selection.active);
    return blocks.find(block => cursorOffset >= block.startOffset && cursorOffset <= block.endOffset);
}

function isCompleteSingleProcedure(sql: string): boolean {
    const trimmed = sql.trim();
    const blocks = findProcedureBlocks(trimmed);
    return blocks.length === 1 && normalizeSql(blocks[0].sql) === normalizeSql(trimmed);
}

function normalizeSql(sql: string): string {
    return sql.trim().replace(/\s+/gu, ' ');
}

function buildSessionKey(
    documentUri: string,
    mode: ProcedureRepairInput['mode'],
    procedureName: string,
    callArguments: readonly ProcedureCallArgument[],
): string {
    return `${documentUri}|${mode}|${normalizeProcedureName(procedureName)}|${JSON.stringify(callArguments)}`;
}

function formatLintIssue(issue: ValidationError): string {
    const lineColumn = issue.position.offset >= 0 ? ` at offset ${issue.position.offset}` : '';
    return `${issue.code}${lineColumn}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isUnknownConnectionFailure(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth++) {
        if (isConnectionBrokenError(current)) {
            return true;
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return false;
}
