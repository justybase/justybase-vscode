import type { IToken } from 'chevrotain';
import type { TokenPosition, ValidationError } from '@justybase/sql-core/validation';

/**
 * Structural PL/pgSQL diagnostics for routine and `DO` bodies.
 *
 * PostgreSQL validates PL/pgSQL syntax when the routine is created (not at the
 * first call), but the shared PostgreSQL grammar deliberately treats the
 * dollar-quoted body as an opaque string. This analyzer fills that gap without
 * parsing SQL expressions: it masks comments, strings and quoted identifiers,
 * then tracks the block structure (`BEGIN … END`, `IF … END IF`, `LOOP … END
 * LOOP`, `CASE … END CASE`). Diagnostics are warnings so an unusual but valid
 * construct never blocks execution; the server remains the final authority.
 */

export interface PostgresqlPlpgsqlDiagnostic {
    code: string;
    message: string;
    /** Absolute offset in the analysed SQL text. */
    offset: number;
    /** Length of the highlighted token, at least one character. */
    length: number;
}

interface WordToken {
    value: string;
    offset: number;
    length: number;
}

type FrameKind = 'block' | 'if' | 'loop' | 'case';

interface Frame {
    kind: FrameKind;
    offset: number;
    length: number;
    label?: string;
    declared?: boolean;
    bodyStarted?: boolean;
    exceptionSeen?: boolean;
    thenSeen?: boolean;
    elseSeen?: boolean;
}

const WORD_START = /[A-Za-z_]/u;
const WORD_PART = /[A-Za-z0-9_$]/u;

function skipSingleQuoted(text: string, quoteIndex: number, backslashEscapes: boolean): number {
    let index = quoteIndex + 1;
    while (index < text.length) {
        const character = text[index];
        if (backslashEscapes && character === '\\') {
            index += 2;
            continue;
        }
        if (character === "'") {
            if (text[index + 1] === "'") {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    return text.length;
}

function matchDollarDelimiter(text: string, index: number): string | undefined {
    if (text[index] !== '$') return undefined;
    let end = index + 1;
    while (end < text.length && /[A-Za-z0-9_]/u.test(text[end] ?? '')) end += 1;
    if (text[end] !== '$') return undefined;
    return text.slice(index, end + 1);
}

/** Tokenises only the words and block symbols the structural rules need. */
function scanBody(body: string): WordToken[] {
    const tokens: WordToken[] = [];
    let index = 0;
    while (index < body.length) {
        const character = body[index];

        if (character === '-' && body[index + 1] === '-') {
            index += 2;
            while (index < body.length && body[index] !== '\n') index += 1;
            continue;
        }

        if (character === '/' && body[index + 1] === '*') {
            index += 2;
            let depth = 1;
            while (index < body.length && depth > 0) {
                if (body[index] === '/' && body[index + 1] === '*') {
                    depth += 1;
                    index += 2;
                } else if (body[index] === '*' && body[index + 1] === '/') {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }

        if (character === '"') {
            index += 1;
            while (index < body.length) {
                if (body[index] === '"') {
                    if (body[index + 1] === '"') index += 2;
                    else {
                        index += 1;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }

        if (character === "'") {
            index = skipSingleQuoted(body, index, false);
            continue;
        }

        if (
            (character === 'E' || character === 'e' || character === 'B' || character === 'b'
                || character === 'X' || character === 'x' || character === 'N' || character === 'n')
            && body[index + 1] === "'"
        ) {
            index = skipSingleQuoted(body, index + 1, character === 'E' || character === 'e');
            continue;
        }

        if ((character === 'U' || character === 'u') && body[index + 1] === '&' && body[index + 2] === "'") {
            index = skipSingleQuoted(body, index + 2, false);
            continue;
        }

        if (character === '$') {
            const delimiter = matchDollarDelimiter(body, index);
            if (delimiter) {
                const closing = body.indexOf(delimiter, index + delimiter.length);
                if (closing < 0) {
                    index = body.length;
                    continue;
                }
                index = closing + delimiter.length;
                continue;
            }
            index += 1;
            continue;
        }

        if (
            character === '<'
            && body[index + 1] === '<'
            && /^<<\s*[A-Za-z_][A-Za-z0-9_$]*\s*>>\s*(?:LOOP|BEGIN|DECLARE|WHILE|FOR|FOREACH)\b/iu.test(body.slice(index))
        ) {
            tokens.push({ value: '<<', offset: index, length: 2 });
            index += 2;
            continue;
        }

        if (character === '>' && body[index + 1] === '>') {
            tokens.push({ value: '>>', offset: index, length: 2 });
            index += 2;
            continue;
        }

        if (character === ';') {
            tokens.push({ value: ';', offset: index, length: 1 });
            index += 1;
            continue;
        }

        if (WORD_START.test(character)) {
            const start = index;
            index += 1;
            while (index < body.length && WORD_PART.test(body[index] ?? '')) index += 1;
            tokens.push({ value: body.slice(start, index).toUpperCase(), offset: start, length: index - start });
            continue;
        }

        index += 1;
    }
    return tokens;
}

interface LocalDiagnostic {
    code: string;
    message: string;
    offset: number;
    length: number;
}

function declareWithoutBeginDiagnostic(frame: Frame): LocalDiagnostic | undefined {
    return frame.kind === 'block' && frame.declared === true && frame.bodyStarted === false
        ? {
            code: 'PGP006',
            message: 'DECLARE block is missing BEGIN.',
            offset: frame.offset,
            length: frame.length,
        }
        : undefined;
}

function pushUnclosed(stack: Frame[], fromIndex: number, diagnostics: LocalDiagnostic[]): void {
    for (let index = stack.length - 1; index >= fromIndex; index -= 1) {
        const frame = stack[index];
        if (frame.kind === 'block') {
            diagnostics.push(declareWithoutBeginDiagnostic(frame) ?? {
                code: 'PGP001',
                message: 'BEGIN has no matching END in this PL/pgSQL block.',
                offset: frame.offset,
                length: frame.length,
            });
        } else if (frame.kind === 'if') {
            diagnostics.push({
                code: 'PGP003',
                message: 'IF has no matching END IF.',
                offset: frame.offset,
                length: frame.length,
            });
        } else if (frame.kind === 'loop') {
            diagnostics.push({
                code: 'PGP004',
                message: 'LOOP has no matching END LOOP.',
                offset: frame.offset,
                length: frame.length,
            });
        } else {
            diagnostics.push({
                code: 'PGP005',
                message: 'CASE has no matching END CASE.',
                offset: frame.offset,
                length: frame.length,
            });
        }
    }
}

function findLastBlock(stack: readonly Frame[]): number {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].kind === 'block') return index;
    }
    return -1;
}

function popKind(stack: Frame[], kind: FrameKind, diagnostics: LocalDiagnostic[]): Frame | undefined {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].kind === kind) {
            pushUnclosed(stack, index + 1, diagnostics);
            const frame = stack[index];
            stack.length = index;
            return frame;
        }
    }
    return undefined;
}

function analyzeBodyStructure(
    body: string,
    bodyStart: number,
): { diagnostics: LocalDiagnostic[]; hasReturn: boolean } {
    const tokens = scanBody(body);
    const diagnostics: LocalDiagnostic[] = [];
    const stack: Frame[] = [];
    let pendingLabel: string | undefined;
    let expectLabel = false;
    let sawTopLevelBlock = false;
    let hasReturn = false;
    let inMerge = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const word = token.value;

        if (word === ';') {
            inMerge = false;
            continue;
        }
        if (word === 'MERGE') {
            inMerge = true;
            continue;
        }

        if (word === '<<') {
            expectLabel = true;
            continue;
        }
        if (word === '>>') {
            continue;
        }
        if (expectLabel) {
            pendingLabel = word;
            expectLabel = false;
            continue;
        }

        if (word === 'DECLARE') {
            stack.push({
                kind: 'block',
                offset: bodyStart + token.offset,
                length: token.length,
                label: pendingLabel,
                declared: true,
                bodyStarted: false,
            });
            if (stack.length === 1) sawTopLevelBlock = true;
            pendingLabel = undefined;
            continue;
        }

        if (word === 'BEGIN') {
            const top = stack[stack.length - 1];
            if (top?.kind === 'block' && top.declared === true && top.bodyStarted === false) {
                top.bodyStarted = true;
                top.label ??= pendingLabel;
            } else {
                stack.push({
                    kind: 'block',
                    offset: bodyStart + token.offset,
                    length: token.length,
                    label: pendingLabel,
                    declared: false,
                    bodyStarted: true,
                });
                if (stack.length === 1) sawTopLevelBlock = true;
            }
            pendingLabel = undefined;
            continue;
        }

        if (word === 'IF') {
            stack.push({
                kind: 'if',
                offset: bodyStart + token.offset,
                length: token.length,
                thenSeen: false,
                elseSeen: false,
            });
            continue;
        }

        if (word === 'THEN') {
            const top = stack[stack.length - 1];
            if (top?.kind === 'if' && top.thenSeen === false) {
                top.thenSeen = true;
            }
            continue;
        }

        if (word === 'ELSIF' || word === 'ELSEIF') {
            const top = stack[stack.length - 1];
            if (top?.kind === 'if' && top.thenSeen === true && top.elseSeen !== true) {
                top.thenSeen = false;
            } else {
                diagnostics.push({
                    code: 'PGP009',
                    message: 'ELSIF is only valid after IF … THEN.',
                    offset: bodyStart + token.offset,
                    length: token.length,
                });
            }
            continue;
        }

        if (word === 'ELSE') {
            const top = stack[stack.length - 1];
            if (top?.kind === 'if' && top.thenSeen === true && top.elseSeen !== true) {
                top.elseSeen = true;
            } else if (top?.kind !== 'case') {
                diagnostics.push({
                    code: 'PGP009',
                    message: 'ELSE is only valid inside an IF or CASE statement.',
                    offset: bodyStart + token.offset,
                    length: token.length,
                });
            }
            continue;
        }

        if (word === 'LOOP') {
            stack.push({
                kind: 'loop',
                offset: bodyStart + token.offset,
                length: token.length,
                label: pendingLabel,
            });
            pendingLabel = undefined;
            continue;
        }

        if (word === 'CASE') {
            stack.push({
                kind: 'case',
                offset: bodyStart + token.offset,
                length: token.length,
            });
            continue;
        }

        if (word === 'EXCEPTION') {
            const top = stack[stack.length - 1];
            if (top?.kind === 'block' && top.bodyStarted === true && top.exceptionSeen !== true) {
                top.exceptionSeen = true;
            } else {
                diagnostics.push({
                    code: 'PGP008',
                    message: 'EXCEPTION handler is only valid once, inside a block body.',
                    offset: bodyStart + token.offset,
                    length: token.length,
                });
            }
            continue;
        }

        if (word === 'WHEN') {
            if (inMerge) continue;
            const top = stack[stack.length - 1];
            if (top?.kind === 'block' && top.exceptionSeen !== true) {
                diagnostics.push({
                    code: 'PGP008',
                    message: 'WHEN is only valid after an EXCEPTION clause.',
                    offset: bodyStart + token.offset,
                    length: token.length,
                });
            }
            continue;
        }

        if (word === 'RETURN') {
            hasReturn = true;
            continue;
        }

        if (word !== 'END') {
            continue;
        }

        const next = tokens[index + 1];
        const nextWord = next?.value;

        if (nextWord === 'IF') {
            const frame = popKind(stack, 'if', diagnostics);
            if (!frame) {
                diagnostics.push({
                    code: 'PGP003',
                    message: 'END IF has no matching IF.',
                    offset: bodyStart + token.offset,
                    length: token.length + 1 + (next?.length ?? 0),
                });
            } else if (frame.thenSeen === false) {
                diagnostics.push({
                    code: 'PGP003',
                    message: 'IF is missing THEN.',
                    offset: frame.offset,
                    length: frame.length,
                });
            }
            index += 1;
            continue;
        }

        if (nextWord === 'LOOP') {
            const frame = popKind(stack, 'loop', diagnostics);
            if (!frame) {
                diagnostics.push({
                    code: 'PGP004',
                    message: 'END LOOP has no matching LOOP.',
                    offset: bodyStart + token.offset,
                    length: token.length + 1 + (next?.length ?? 0),
                });
            }
            index += 1;
            continue;
        }

        if (nextWord === 'CASE') {
            const frame = popKind(stack, 'case', diagnostics);
            if (!frame) {
                diagnostics.push({
                    code: 'PGP005',
                    message: 'END CASE has no matching CASE.',
                    offset: bodyStart + token.offset,
                    length: token.length + 1 + (next?.length ?? 0),
                });
            }
            index += 1;
            continue;
        }

        const top = stack[stack.length - 1];
        if (top?.kind === 'case') {
            // A CASE expression also ends with a bare END; do not force END CASE.
            stack.pop();
            continue;
        }

        if (nextWord !== undefined && top?.label !== undefined && top.label === nextWord) {
            const missingBegin = declareWithoutBeginDiagnostic(top);
            if (missingBegin) diagnostics.push(missingBegin);
            stack.pop();
            index += 1;
            continue;
        }

        if (top?.kind === 'block') {
            const missingBegin = declareWithoutBeginDiagnostic(top);
            if (missingBegin) diagnostics.push(missingBegin);
            stack.pop();
            continue;
        }

        const blockIndex = findLastBlock(stack);
        if (blockIndex >= 0) {
            pushUnclosed(stack, blockIndex + 1, diagnostics);
            const missingBegin = declareWithoutBeginDiagnostic(stack[blockIndex]);
            if (missingBegin) diagnostics.push(missingBegin);
            stack.length = blockIndex;
            continue;
        }

        if (stack.length > 0) {
            pushUnclosed(stack, 0, diagnostics);
            stack.length = 0;
            continue;
        }

        diagnostics.push({
            code: 'PGP002',
            message: 'END has no matching BEGIN.',
            offset: bodyStart + token.offset,
            length: token.length,
        });
    }

    pushUnclosed(stack, 0, diagnostics);
    if (!sawTopLevelBlock) {
        diagnostics.push({
            code: 'PGP001',
            message: 'A PL/pgSQL body must start with BEGIN or DECLARE.',
            offset: bodyStart,
            length: 1,
        });
    }

    return { diagnostics, hasReturn };
}

function lineColumnAt(text: string, offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, text.length));
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < clamped; index += 1) {
        if (text[index] === '\n') {
            line += 1;
            lineStart = index + 1;
        }
    }
    return { line, column: clamped - lineStart + 1 };
}

function toTokenPosition(sql: string, offset: number, length: number): TokenPosition {
    const start = lineColumnAt(sql, offset);
    const end = lineColumnAt(sql, offset + Math.max(1, length));
    return {
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
        offset,
    };
}

interface RoutineStatement {
    kind: 'function' | 'procedure' | 'do';
    statementStart: number;
    statementEnd: number;
    body: string;
    bodyStart: number;
    returnsVoid: boolean;
}

function isSemicolon(token: IToken): boolean {
    return token.tokenType.name === 'Semicolon';
}

function tokenImage(token: IToken | undefined): string {
    return (token?.image ?? '').toUpperCase();
}

function collectRoutineStatements(sql: string, tokens: readonly IToken[]): RoutineStatement[] {
    const statements: RoutineStatement[] = [];
    let statementTokens: IToken[] = [];

    const flush = (endOffset: number): void => {
        if (statementTokens.length === 0) return;
        const statementStart = statementTokens[0].startOffset ?? 0;
        const first = tokenImage(statementTokens[0]);
        let kind: RoutineStatement['kind'] | undefined;
        if (first === 'DO') {
            kind = 'do';
        } else if (first === 'CREATE') {
            let cursor = 1;
            if (tokenImage(statementTokens[cursor]) === 'OR') cursor += 1;
            if (tokenImage(statementTokens[cursor]) === 'REPLACE') cursor += 1;
            const objectKind = tokenImage(statementTokens[cursor]);
            if (objectKind === 'FUNCTION') kind = 'function';
            else if (objectKind === 'PROCEDURE') kind = 'procedure';
        }
        if (!kind) {
            statementTokens = [];
            return;
        }

        let bodyTokenIndex = -1;
        if (kind === 'do') {
            bodyTokenIndex = statementTokens.findIndex(token => token.tokenType.name === 'DollarQuotedString');
        } else {
            const asIndex = statementTokens.findIndex(token => tokenImage(token) === 'AS');
            if (asIndex >= 0) {
                for (let index = asIndex + 1; index < statementTokens.length; index += 1) {
                    if (statementTokens[index].tokenType.name === 'DollarQuotedString') {
                        bodyTokenIndex = index;
                        break;
                    }
                }
            }
        }
        if (bodyTokenIndex < 0) {
            statementTokens = [];
            return;
        }

        const bodyToken = statementTokens[bodyTokenIndex];
        const image = bodyToken.image;
        const tagEnd = image.indexOf('$', 1);
        if (tagEnd < 0) {
            statementTokens = [];
            return;
        }
        const delimiter = image.slice(0, tagEnd + 1);
        const bodyStart = (bodyToken.startOffset ?? 0) + delimiter.length;
        const bodyEnd = (bodyToken.endOffset ?? bodyStart) + 1 - delimiter.length;
        if (bodyEnd < bodyStart) {
            statementTokens = [];
            return;
        }

        const before = sql.slice(statementStart, bodyToken.startOffset ?? statementStart);
        const after = sql.slice((bodyToken.endOffset ?? 0) + 1, endOffset);
        const languageText = `${before} ${after}`;
        const isPlpgsql = /\bLANGUAGE\s+(?:'plpgsql'|plpgsql)\b/iu.test(languageText);
        const hasLanguage = /\bLANGUAGE\b/iu.test(languageText);
        if (!isPlpgsql && !(kind === 'do' && !hasLanguage)) {
            statementTokens = [];
            return;
        }

        const returnsVoid = /\bRETURNS\s+(?:SETOF\s+)?(?:VOID|TRIGGER|EVENT_TRIGGER)\b/iu.test(before);
        statements.push({
            kind,
            statementStart,
            statementEnd: endOffset,
            body: sql.slice(bodyStart, bodyEnd),
            bodyStart,
            returnsVoid,
        });
        statementTokens = [];
    };

    for (const token of tokens) {
        if (isSemicolon(token)) {
            flush(token.startOffset ?? sql.length);
        } else {
            statementTokens.push(token);
        }
    }
    flush(sql.length);
    return statements;
}

/**
 * Returns structural diagnostics for every PL/pgSQL routine or `DO` body in
 * the script. Offsets are absolute in {@link sql}.
 */
export function analyzePostgresqlRoutineBodies(
    sql: string,
    tokens: readonly IToken[],
): PostgresqlPlpgsqlDiagnostic[] {
    const diagnostics: PostgresqlPlpgsqlDiagnostic[] = [];
    for (const statement of collectRoutineStatements(sql, tokens)) {
        const analysis = analyzeBodyStructure(statement.body, statement.bodyStart);
        diagnostics.push(...analysis.diagnostics);
        if (statement.kind === 'function' && !statement.returnsVoid && !analysis.hasReturn) {
            diagnostics.push({
                code: 'PGP007',
                message: 'Function returns a non-void type but the body has no RETURN statement.',
                offset: statement.bodyStart,
                length: 1,
            });
        }
    }
    return diagnostics;
}

/** Adapts the structural diagnostics to the shared validation result shape. */
export function getPostgresqlPlpgsqlDiagnostics(
    sql: string,
    tokens: readonly IToken[],
): ValidationError[] {
    return analyzePostgresqlRoutineBodies(sql, tokens).map(diagnostic => ({
        code: diagnostic.code,
        severity: 'warning',
        message: diagnostic.message,
        position: toTokenPosition(sql, diagnostic.offset, diagnostic.length),
    }));
}
