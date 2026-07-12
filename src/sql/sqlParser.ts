import { IToken } from 'chevrotain';
import { Dot, Semicolon, SqlLexer } from '../sqlParser/lexer';
import {
    findStatementAtOffset,
    getCachedStatementBoundaries,
    setCachedStatementBoundaries,
    clearDocumentStatementCache,
    type SqlParserDocumentKey,
} from './sqlParserDocumentCache';

export type { SqlParserDocumentKey } from './sqlParserDocumentCache';

const DEFAULT_FAST_PATH_THRESHOLD = 1572864;
let fastPathThreshold = DEFAULT_FAST_PATH_THRESHOLD;

export class SqlParser {
    static setFastPathThreshold(value: number): void {
        fastPathThreshold = value;
    }

    static getFastPathThreshold(): number {
        return fastPathThreshold;
    }

    private static shouldUseFastPath(text: string): boolean {
        return text.length <= fastPathThreshold;
    }

    /**
     * Splits a SQL script into individual statements, respecting quotes and comments.
     */
    public static splitStatements(text: string): string[] {
        if (this.shouldUseFastPath(text)) {
            const fastStatements = this.splitStatementsWithPositionsFast(text);
            if (fastStatements) {
                return fastStatements.map(statement => statement.sql);
            }
        }

        if (/\bBEGIN_PROC\b/i.test(text)) {
            return this.splitStatementsWithProtectedProcedureBodies(text).map(statement => statement.sql);
        }

        return this.splitStatementsLegacy(text);
    }

    /**
     * Splits a SQL script into individual statements with their character offsets.
     * Used by CodeLens to position links at the correct line.
     */
    public static splitStatementsWithPositions(text: string): { sql: string; startOffset: number; endOffset: number }[] {
        if (this.shouldUseFastPath(text)) {
            const fastStatements = this.splitStatementsWithPositionsFast(text);
            if (fastStatements) {
                return fastStatements;
            }
        }

        if (/\bBEGIN_PROC\b/i.test(text)) {
            return this.splitStatementsWithProtectedProcedureBodies(text);
        }

        return this.splitStatementsWithPositionsLegacy(text);
    }

    private static splitStatementsWithProtectedProcedureBodies(
        text: string,
    ): { sql: string; startOffset: number; endOffset: number }[] {
        const semicolonOffsets = this.collectSemicolonOffsetsLegacy(text);
        const statements: { sql: string; startOffset: number; endOffset: number }[] = [];
        let segmentStart = 0;

        for (const semicolonOffset of semicolonOffsets) {
            const statementStart = this.findFirstNonWhitespace(text, segmentStart, semicolonOffset);
            if (statementStart !== null) {
                const sql = text.substring(segmentStart, semicolonOffset).trim();
                if (sql) {
                    statements.push({ sql, startOffset: statementStart, endOffset: semicolonOffset });
                }
            }
            segmentStart = semicolonOffset + 1;
        }

        const statementStart = this.findFirstNonWhitespace(text, segmentStart, text.length);
        if (statementStart !== null) {
            const sql = text.substring(segmentStart).trim();
            if (sql) {
                statements.push({ sql, startOffset: statementStart, endOffset: text.length });
            }
        }

        return statements;
    }

    /**
     * Finds the SQL statement at the given offset.
     */
    public static getStatementAtPosition(
        text: string,
        offset: number,
        documentKey?: SqlParserDocumentKey,
    ): { sql: string; start: number; end: number } | null {
        if (documentKey) {
            const cached = getCachedStatementBoundaries(documentKey, text);
            if (cached) {
                return findStatementAtOffset(text, offset, cached.semicolonOffsets);
            }

            const semicolonOffsets = this.getStatementBoundarySemicolonOffsets(text);
            setCachedStatementBoundaries(documentKey, text, semicolonOffsets);
            return findStatementAtOffset(text, offset, semicolonOffsets);
        }

        if (this.shouldUseFastPath(text)) {
            const fastStatement = this.getStatementAtPositionFast(text, offset);
            if (fastStatement) {
                return fastStatement;
            }
        }

        return this.getStatementAtPositionLegacy(text, offset);
    }

    public static clearDocumentCache(documentId?: string): void {
        clearDocumentStatementCache(documentId);
    }

    /**
     * Extracts the database object reference at the given offset.
     * Supports formats: NAME, SCHEMA.NAME, DB.SCHEMA.NAME, DB..NAME
     */
    public static getObjectAtPosition(
        text: string,
        offset: number
    ): { database?: string; schema?: string; name: string } | null {
        if (this.shouldUseFastPath(text)) {
            const fastObject = this.getObjectAtPositionFast(text, offset);
            if (fastObject) {
                return fastObject;
            }
        }

        return this.getObjectAtPositionLegacy(text, offset);
    }

    private static splitStatementsWithPositionsFast(
        text: string
    ): { sql: string; startOffset: number; endOffset: number }[] | null {
        const semicolonOffsets = this.collectSemicolonOffsetsFast(text);
        if (!semicolonOffsets) {
            return null;
        }

        const statements: { sql: string; startOffset: number; endOffset: number }[] = [];
        let segmentStart = 0;

        for (const semicolonOffset of semicolonOffsets) {
            const statementStart = this.findFirstNonWhitespace(text, segmentStart, semicolonOffset);
            if (statementStart !== null) {
                const sql = text.substring(segmentStart, semicolonOffset).trim();
                if (sql) {
                    statements.push({
                        sql,
                        startOffset: statementStart,
                        endOffset: semicolonOffset,
                    });
                }
            }

            segmentStart = semicolonOffset + 1;
        }

        const statementStart = this.findFirstNonWhitespace(text, segmentStart, text.length);
        if (statementStart !== null) {
            const sql = text.substring(segmentStart).trim();
            if (sql) {
                statements.push({
                    sql,
                    startOffset: statementStart,
                    endOffset: text.length,
                });
            }
        }

        return statements;
    }

    private static getStatementAtPositionFast(
        text: string,
        offset: number
    ): { sql: string; start: number; end: number } | null {
        const semicolonOffsets = this.collectSemicolonOffsetsFast(text);
        if (!semicolonOffsets) {
            return null;
        }

        return findStatementAtOffset(text, offset, semicolonOffsets);
    }

    private static getObjectAtPositionFast(
        text: string,
        offset: number
    ): { database?: string; schema?: string; name: string } | null {
        const tokens = this.tokenize(text);
        if (!tokens) {
            return null;
        }

        const isObjectToken = (token: IToken): boolean =>
            this.isTokenType(token, Dot) || this.isIdentifierLikeImage(token.image);
        const objectTokenIndex = this.findObjectTokenIndex(tokens, offset);
        if (objectTokenIndex < 0 || !isObjectToken(tokens[objectTokenIndex])) {
            return null;
        }

        let startTokenIndex = objectTokenIndex;
        while (
            startTokenIndex > 0 &&
            isObjectToken(tokens[startTokenIndex - 1]) &&
            this.areAdjacent(tokens[startTokenIndex - 1], tokens[startTokenIndex])
        ) {
            startTokenIndex--;
        }

        let endTokenIndex = objectTokenIndex;
        while (
            endTokenIndex < tokens.length - 1 &&
            isObjectToken(tokens[endTokenIndex + 1]) &&
            this.areAdjacent(tokens[endTokenIndex], tokens[endTokenIndex + 1])
        ) {
            endTokenIndex++;
        }

        const startOffset = tokens[startTokenIndex].startOffset;
        const endOffset = tokens[endTokenIndex].endOffset;
        if (startOffset === undefined || endOffset === undefined) {
            return null;
        }

        const identifier = text.substring(startOffset, endOffset + 1);
        if (!identifier) {
            return null;
        }

        return this.parseObjectIdentifier(identifier);
    }

    private static tokenize(text: string): IToken[] | null {
        const lexResult = SqlLexer.tokenize(text);
        if (lexResult.errors.length > 0 || !this.hasValidTokenOffsets(text, lexResult.tokens)) {
            return null;
        }

        return lexResult.tokens;
    }

    private static getStatementBoundarySemicolonOffsets(text: string): number[] {
        if (this.shouldUseFastPath(text)) {
            const semicolonOffsets = this.collectSemicolonOffsetsFast(text);
            if (semicolonOffsets) {
                return semicolonOffsets;
            }
        }

        return this.collectSemicolonOffsetsLegacy(text);
    }

    private static collectSemicolonOffsetsFast(text: string): number[] | null {
        const tokens = this.tokenize(text);
        if (!tokens) {
            return null;
        }

        const semicolonOffsets: number[] = [];
        for (const token of tokens) {
            if (this.isTokenType(token, Semicolon) && token.startOffset !== undefined) {
                semicolonOffsets.push(token.startOffset);
            }
        }

        return this.filterProcedureBlockSemicolonOffsets(
            text,
            this.filterMacroBlockSemicolonOffsets(text, semicolonOffsets),
        );
    }

    private static collectSemicolonOffsetsLegacy(text: string): number[] {
        const semicolonOffsets: number[] = [];
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') inDoubleQuote = false;
            } else {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                } else if (char === "'") {
                    inSingleQuote = true;
                } else if (char === '"') {
                    inDoubleQuote = true;
                } else if (char === ';') {
                    semicolonOffsets.push(i);
                }
            }
        }

        return this.filterProcedureBlockSemicolonOffsets(
            text,
            this.filterMacroBlockSemicolonOffsets(text, semicolonOffsets),
        );
    }

    /**
     * BEGIN_PROC/END_PROC delimit a Netezza procedure body whose internal
     * semicolons are part of the CREATE PROCEDURE statement.
     */
    private static filterProcedureBlockSemicolonOffsets(
        text: string,
        semicolonOffsets: number[],
    ): number[] {
        if (!/\bBEGIN_PROC\b/i.test(text)) {
            return semicolonOffsets;
        }

        const semicolonSet = new Set(semicolonOffsets);
        const filtered: number[] = [];
        let procedureDepth = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
                continue;
            }
            if (inDoubleQuote) {
                if (char === '"' && nextChar === '"') {
                    i++;
                } else if (char === '"') {
                    inDoubleQuote = false;
                }
                continue;
            }

            if (char === '-' && nextChar === '-') {
                inLineComment = true;
                i++;
            } else if (char === '/' && nextChar === '*') {
                inBlockComment = true;
                i++;
            } else if (char === "'") {
                inSingleQuote = true;
            } else if (char === '"') {
                inDoubleQuote = true;
            } else if (/[A-Za-z_]/.test(char)) {
                const wordStart = i;
                while (i + 1 < text.length && /[A-Za-z0-9_$]/.test(text[i + 1])) {
                    i++;
                }
                const word = text.slice(wordStart, i + 1).toUpperCase();
                if (word === 'BEGIN_PROC') {
                    procedureDepth++;
                } else if (word === 'END_PROC' && procedureDepth > 0) {
                    procedureDepth--;
                }
            } else if (char === ';' && semicolonSet.has(i) && procedureDepth === 0) {
                filtered.push(i);
            }
        }

        return filtered;
    }

    private static filterMacroBlockSemicolonOffsets(text: string, semicolonOffsets: number[]): number[] {
        if (!/%(?:if|else|do|end)\b/i.test(text)) {
            return semicolonOffsets;
        }

        const filtered: number[] = [];
        let macroBlockDepth = 0;

        for (const offset of semicolonOffsets) {
            const directive = this.readMacroDirectiveBeforeSemicolon(text, offset);
            if (directive === 'if') {
                macroBlockDepth++;
                continue;
            }
            if (directive === 'do') {
                macroBlockDepth++;
                continue;
            }
            if (directive === 'else' && macroBlockDepth > 0) {
                continue;
            }
            if (directive === 'end' && macroBlockDepth > 0) {
                macroBlockDepth--;
                if (macroBlockDepth === 0) {
                    filtered.push(offset);
                }
                continue;
            }
            if (macroBlockDepth === 0) {
                filtered.push(offset);
            }
        }

        return filtered;
    }

    private static readMacroDirectiveBeforeSemicolon(
        text: string,
        semicolonOffset: number,
    ): 'if' | 'else' | 'do' | 'end' | undefined {
        let lineStart = semicolonOffset;
        while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
            lineStart--;
        }

        const linePrefix = text.slice(lineStart, semicolonOffset).trim();
        if (/^%if\b[\s\S]*\s+%then\s+%do$/i.test(linePrefix)) {
            return 'if';
        }
        if (/(?:^|;)\s*%else\s+%do\s*$/i.test(linePrefix)) {
            return 'else';
        }
        if (/(?:^|;)\s*%end\s*$/i.test(linePrefix)) {
            return 'end';
        }
        if (/(?:^|;)\s*%do\s*$/i.test(linePrefix)) {
            return 'do';
        }
        return undefined;
    }

    private static hasValidTokenOffsets(text: string, tokens: IToken[]): boolean {
        for (const token of tokens) {
            const startOffset = token.startOffset;
            const endOffset = token.endOffset;

            if (
                startOffset === undefined ||
                endOffset === undefined ||
                startOffset < 0 ||
                endOffset < startOffset ||
                endOffset >= text.length
            ) {
                return false;
            }

            if (text.substring(startOffset, endOffset + 1) !== token.image) {
                return false;
            }
        }

        return true;
    }

    private static findFirstNonWhitespace(text: string, start: number, end: number): number | null {
        for (let i = start; i < end; i++) {
            if (/\S/.test(text[i])) {
                return i;
            }
        }

        return null;
    }

    private static isIdentifierLikeImage(image: string): boolean {
        return /^[a-zA-Z0-9_"]+$/i.test(image);
    }

    private static areAdjacent(left: IToken, right: IToken): boolean {
        return left.endOffset !== undefined && right.startOffset !== undefined && left.endOffset + 1 === right.startOffset;
    }

    private static isTokenType(token: IToken, tokenType: { name: string }): boolean {
        return token.tokenType === tokenType || token.tokenType.name === tokenType.name;
    }

    private static findObjectTokenIndex(tokens: IToken[], offset: number): number {
        for (let i = 0; i < tokens.length; i++) {
            const startOffset = tokens[i].startOffset;
            const endOffset = tokens[i].endOffset;
            if (startOffset === undefined || endOffset === undefined) {
                continue;
            }

            if (offset >= startOffset && offset <= endOffset) {
                return i;
            }

            if (offset === endOffset + 1) {
                return i;
            }
        }

        return -1;
    }

    private static parseObjectIdentifier(identifier: string): { database?: string; schema?: string; name: string } | null {
        const clean = (s: string) => (s ? s.replace(/"/g, '') : undefined);

        if (identifier.includes('..')) {
            const parts = identifier.split('..');
            if (parts.length === 2) {
                return {
                    database: clean(parts[0]),
                    name: clean(parts[1])!,
                };
            }
        }

        const parts = identifier.split('.');
        if (parts.length === 1) {
            return { name: clean(parts[0])! };
        } else if (parts.length === 2) {
            return {
                schema: clean(parts[0]),
                name: clean(parts[1])!,
            };
        } else if (parts.length === 3) {
            return {
                database: clean(parts[0]),
                schema: clean(parts[1]),
                name: clean(parts[2])!,
            };
        }

        return null;
    }

    private static splitStatementsLegacy(text: string): string[] {
        const statements: string[] = [];
        let currentStatement = '';
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;
        let i = 0;
        let macroBlockDepth = 0;

        while (i < text.length) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    currentStatement += char + nextChar;
                    i++;
                    i++;
                    continue;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    currentStatement += char;
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') inDoubleQuote = false;
            } else {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                } else if (char === "'") {
                    inSingleQuote = true;
                } else if (char === '"') {
                    inDoubleQuote = true;
                } else if (char === ';') {
                    const directive = this.readMacroDirectiveBeforeSemicolon(text, i);
                    if (directive === 'if') {
                        macroBlockDepth++;
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'do') {
                        macroBlockDepth++;
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'else' && macroBlockDepth > 0) {
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'end' && macroBlockDepth > 0) {
                        macroBlockDepth--;
                        if (macroBlockDepth > 0) {
                            currentStatement += char;
                            i++;
                            continue;
                        }
                    } else if (macroBlockDepth > 0) {
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (currentStatement.trim()) {
                        statements.push(currentStatement.trim());
                    }
                    currentStatement = '';
                    i++;
                    continue;
                }
            }

            currentStatement += char;
            i++;
        }

        if (currentStatement.trim()) {
            statements.push(currentStatement.trim());
        }

        return statements;
    }

    private static splitStatementsWithPositionsLegacy(
        text: string
    ): { sql: string; startOffset: number; endOffset: number }[] {
        const statements: { sql: string; startOffset: number; endOffset: number }[] = [];
        let currentStatement = '';
        let statementStartOffset = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;
        let i = 0;
        let foundNonWhitespace = false;
        let macroBlockDepth = 0;

        while (i < text.length) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (!foundNonWhitespace && /\S/.test(char)) {
                foundNonWhitespace = true;
                statementStartOffset = i;
            }

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    currentStatement += char + nextChar;
                    i++;
                    i++;
                    continue;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    currentStatement += char;
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') inDoubleQuote = false;
            } else {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                } else if (char === "'") {
                    inSingleQuote = true;
                } else if (char === '"') {
                    inDoubleQuote = true;
                } else if (char === ';') {
                    const directive = this.readMacroDirectiveBeforeSemicolon(text, i);
                    if (directive === 'if') {
                        macroBlockDepth++;
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'do') {
                        macroBlockDepth++;
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'else' && macroBlockDepth > 0) {
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (directive === 'end' && macroBlockDepth > 0) {
                        macroBlockDepth--;
                        if (macroBlockDepth > 0) {
                            currentStatement += char;
                            i++;
                            continue;
                        }
                    } else if (macroBlockDepth > 0) {
                        currentStatement += char;
                        i++;
                        continue;
                    }
                    if (currentStatement.trim()) {
                        statements.push({
                            sql: currentStatement.trim(),
                            startOffset: statementStartOffset,
                            endOffset: i,
                        });
                    }
                    currentStatement = '';
                    foundNonWhitespace = false;
                    i++;
                    continue;
                }
            }

            currentStatement += char;
            i++;
        }

        if (currentStatement.trim()) {
            statements.push({
                sql: currentStatement.trim(),
                startOffset: statementStartOffset,
                endOffset: text.length,
            });
        }

        return statements;
    }

    private static getStatementAtPositionLegacy(
        text: string,
        offset: number
    ): { sql: string; start: number; end: number } | null {
        let end = text.length;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inLineComment = false;
        let inBlockComment = false;
        let lastSemi = -1;

        for (let i = 0; i < offset; i++) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') inDoubleQuote = false;
            } else {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                } else if (char === "'") {
                    inSingleQuote = true;
                } else if (char === '"') {
                    inDoubleQuote = true;
                } else if (char === ';') {
                    lastSemi = i;
                }
            }
        }

        const start = lastSemi + 1;

        inSingleQuote = false;
        inDoubleQuote = false;
        inLineComment = false;
        inBlockComment = false;

        for (let i = start; i < text.length; i++) {
            const char = text[i];
            const nextChar = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++;
                }
            } else if (inSingleQuote) {
                if (char === "'" && nextChar === "'") {
                    i++;
                } else if (char === "'") {
                    inSingleQuote = false;
                }
            } else if (inDoubleQuote) {
                if (char === '"') inDoubleQuote = false;
            } else {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                } else if (char === "'") {
                    inSingleQuote = true;
                } else if (char === '"') {
                    inDoubleQuote = true;
                } else if (char === ';') {
                    end = i;
                    break;
                }
            }
        }

        const sql = text.substring(start, end).trim();
        if (!sql) {
            return null;
        }

        return { sql, start, end };
    }

    private static getObjectAtPositionLegacy(
        text: string,
        offset: number
    ): { database?: string; schema?: string; name: string } | null {
        const isIdentifierChar = (char: string) => /[a-zA-Z0-9_."]/i.test(char);

        let start = offset;
        while (start > 0 && isIdentifierChar(text[start - 1])) {
            start--;
        }

        let end = offset;
        while (end < text.length && isIdentifierChar(text[end])) {
            end++;
        }

        const identifier = text.substring(start, end);
        if (!identifier) {
            return null;
        }

        return this.parseObjectIdentifier(identifier);
    }
}
