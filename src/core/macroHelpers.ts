import {
    normalizeVariableName,
} from './macroTypes';
import {
    MacroEnvironment,
    MacroScriptError,
} from './macroTypes';
import type {
    DoBlockRange,
    IfBlockRange,
    MacroDirective,
    MacroEvalFunction,
    MacroExportFormat,
    MacroProcessingState,
    MacroQueryExecutionResult,
    MacroQueryFunction,
    MacroReference,
    MacroScriptEvent,
} from './macroTypes';


export function readDirectiveAt(script: string, offset: number): MacroDirective | undefined {
    const directiveStart = skipHorizontalWhitespace(script, offset);
    const text = script.slice(directiveStart);
    const ifMatch = text.match(/^%if\s+/i);
    if (ifMatch) {
        const payloadStart = directiveStart + ifMatch[0].length;
        const payload = readDirectivePayload(script, payloadStart);
        const conditionMatch = payload.text.match(/^(.*?)\s+%then\s+%do\s*$/is);
        if (!conditionMatch?.[1]?.trim()) {
            throw new Error('Invalid %IF syntax; expected %IF <condition> %THEN %DO;');
        }
        return {
            kind: 'if',
            condition: conditionMatch[1].trim(),
            end: payload.end,
        };
    }

    const elseMatch = text.match(/^%else\s+%do\s*;?/i);
    if (elseMatch) {
        return {
            kind: 'else',
            end: directiveStart + elseMatch[0].length,
        };
    }

    const endMatch = text.match(/^%end\s*;?/i);
    if (endMatch) {
        return {
            kind: 'end',
            end: directiveStart + endMatch[0].length,
        };
    }

    const includeMatch = text.match(/^%include\s+/i);
    if (includeMatch) {
        const payloadStart = directiveStart + includeMatch[0].length;
        const payload = readDirectivePayload(script, payloadStart);
        const pathText = payload.text.trim();
        if (!pathText) {
            throw new Error('%INCLUDE requires a path');
        }
        return {
            kind: 'include',
            path: pathText,
            end: payload.end,
        };
    }

    const declarationMatch = text.match(/^(?:@SET\s+([A-Za-z0-9_]+)|%let\s+([A-Za-z_][A-Za-z0-9_]*))\s*=/i);
    if (declarationMatch) {
        const name = declarationMatch[1] || declarationMatch[2];
        if (!name) {
            return undefined;
        }

        const payloadStart = directiveStart + declarationMatch[0].length;
        const payload = readDirectivePayload(script, payloadStart);
        const rawValue = payload.text.trim();
        return {
            kind: 'declaration',
            name,
            value: declarationMatch[1] ? unquoteVariableValue(rawValue) : rawValue,
            end: payload.end,
        };
    }

    const putMatch = text.match(/^%put\s+/i);
    if (putMatch) {
        const payloadStart = directiveStart + putMatch[0].length;
        const payload = readDirectivePayload(script, payloadStart);
        return {
            kind: 'put',
            message: payload.text.trim(),
            end: payload.end,
        };
    }

    const exportMatch = text.match(/^%export\s*\(/i);
    if (exportMatch) {
        const openParenOffset = directiveStart + exportMatch[0].lastIndexOf('(');
        const closeParenOffset = findMatchingMacroFunctionParen(script, openParenOffset);
        if (closeParenOffset === -1) {
            throw new Error('Unterminated %EXPORT macro');
        }

        let end = closeParenOffset + 1;
        const afterParen = skipHorizontalWhitespace(script, end);
        end = script[afterParen] === ';' ? afterParen + 1 : end;

        return {
            kind: 'export',
            payload: script.slice(openParenOffset + 1, closeParenOffset).trim(),
            end,
        };
    }

    const pythonMatch = text.match(/^%python\s+/i);
    if (pythonMatch) {
        const payloadStart = directiveStart + pythonMatch[0].length;
        const payload = readDirectivePayload(script, payloadStart);
        const payloadText = payload.text.trim();
        if (!payloadText) {
            throw new Error('%PYTHON requires a script path');
        }
        // Parse script path and optional arguments
        const parts = splitPythonDirectiveArguments(payloadText);
        const scriptPath = parts[0];
        const args = parts.slice(1);
        return {
            kind: 'python',
            script: scriptPath,
            args,
            end: payload.end,
        };
    }

    const doMatch = text.match(/^%do\s*;?/i);
    if (doMatch) {
        return {
            kind: 'do',
            end: directiveStart + doMatch[0].length,
        };
    }

    return undefined;
}

export function findIfBlock(
    script: string,
    bodyStart: number,
    blockDepth: number,
): IfBlockRange {
    let offset = bodyStart;
    let nestedDepth = 0;
    let atLineStart = isAtLineStart(script, offset);
    let allowChainedDirective = true;
    let elseStart: number | undefined;
    let elseEnd: number | undefined;

    while (offset < script.length) {
        if (atLineStart || allowChainedDirective) {
            const directiveStart = skipHorizontalWhitespace(script, offset);
            const directive = readDirectiveAt(script, offset);
            if (directive) {
                if (directive.kind === 'if' || directive.kind === 'do') {
                    nestedDepth++;
                } else if (directive.kind === 'end') {
                    if (nestedDepth === 0) {
                        return {
                            thenStart: bodyStart,
                            thenEnd: elseStart ?? directiveStart,
                            elseStart: elseEnd,
                            elseEnd: elseStart === undefined ? undefined : directiveStart,
                            end: directive.end,
                        };
                    }
                    nestedDepth--;
                } else if (directive.kind === 'else' && nestedDepth === 0) {
                    if (elseStart !== undefined) {
                        throw new Error('Multiple %ELSE blocks for one %IF');
                    }
                    elseStart = directiveStart;
                    elseEnd = directive.end;
                }
                offset = directive.end;
                atLineStart = isAtLineStart(script, offset);
                allowChainedDirective = true;
                continue;
            }
        }

        const char = script[offset];
        offset++;
        allowChainedDirective = char === ';';
        atLineStart = updateLineStartState(atLineStart, char);
    }

    throw new Error(`Missing %END for %IF block at depth ${blockDepth + 1}`);
}

export function splitPythonDirectiveArguments(payload: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: "'" | '"' | undefined;
    let macroBraceDepth = 0;

    const pushCurrent = () => {
        if (current.length > 0) {
            args.push(current);
            current = '';
        }
    };

    for (let index = 0; index < payload.length; index++) {
        const char = payload[index];

        if (quote) {
            if (char === quote) {
                if (payload[index + 1] === quote) {
                    current += char;
                    index++;
                } else {
                    quote = undefined;
                }
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (char === '$' && payload[index + 1] === '{') {
            current += '${';
            macroBraceDepth++;
            index++;
            continue;
        }

        if (char === '}' && macroBraceDepth > 0) {
            current += char;
            macroBraceDepth--;
            continue;
        }

        if (/\s/.test(char) && macroBraceDepth === 0) {
            pushCurrent();
            continue;
        }

        current += char;
    }

    pushCurrent();
    return args;
}

export function findDoBlock(
    script: string,
    bodyStart: number,
): DoBlockRange {
    let offset = bodyStart;
    let nestedDepth = 0;
    let atLineStart = isAtLineStart(script, offset);
    let allowChainedDirective = true;

    while (offset < script.length) {
        if (atLineStart || allowChainedDirective) {
            const directiveStart = skipHorizontalWhitespace(script, offset);
            const directive = readDirectiveAt(script, offset);
            if (directive) {
                if (directive.kind === 'if' || directive.kind === 'do') {
                    nestedDepth++;
                } else if (directive.kind === 'end') {
                    if (nestedDepth === 0) {
                        return {
                            bodyEnd: directiveStart,
                            end: directive.end,
                        };
                    }
                    nestedDepth--;
                }
                offset = directive.end;
                atLineStart = isAtLineStart(script, offset);
                allowChainedDirective = true;
                continue;
            }
        }

        const char = script[offset];
        offset++;
        allowChainedDirective = char === ';';
        atLineStart = updateLineStartState(atLineStart, char);
    }

    throw new Error(`Missing %END for %DO block`);
}

interface ParsedMacroExportPayload {
    format?: string;
    filePath?: string;
    query?: string;
    sheetName?: string;
    overwrite?: string;
    update?: string;
}

export function parseMacroExportPayload(payload: string): ParsedMacroExportPayload {
    const fields = new Map<string, string>();
    for (const segment of splitTopLevelCommaSeparated(payload)) {
        if (!segment.trim()) {
            continue;
        }
        const equalsIndex = findTopLevelEquals(segment);
        if (equalsIndex === -1) {
            throw new Error(`Invalid %EXPORT argument: ${segment.trim()}`);
        }

        const key = segment.slice(0, equalsIndex).trim().toLowerCase();
        const value = unwrapExportValue(segment.slice(equalsIndex + 1).trim());
        fields.set(key, value);
    }

    return {
        format: fields.get('format'),
        filePath: fields.get('file') ?? fields.get('path') ?? fields.get('output'),
        query: fields.get('query') ?? fields.get('sql'),
        sheetName: fields.get('sheet') ?? fields.get('sheetname') ?? fields.get('name'),
        overwrite: fields.get('overwrite'),
        update: fields.get('update'),
    };
}

export function splitTopLevelCommaSeparated(text: string): string[] {
    const segments: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: "'" | '"' | undefined;

    for (let offset = 0; offset < text.length; offset++) {
        const char = text[offset];

        if (quote) {
            if (char === quote) {
                if (text[offset + 1] === quote) {
                    offset++;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (char === '(') {
            depth++;
            continue;
        }

        if (char === ')' && depth > 0) {
            depth--;
            continue;
        }

        if (char === ',' && depth === 0) {
            segments.push(text.slice(start, offset));
            start = offset + 1;
        }
    }

    segments.push(text.slice(start));
    return segments;
}

export function findTopLevelEquals(text: string): number {
    let depth = 0;
    let quote: "'" | '"' | undefined;

    for (let offset = 0; offset < text.length; offset++) {
        const char = text[offset];

        if (quote) {
            if (char === quote) {
                if (text[offset + 1] === quote) {
                    offset++;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (char === '(') {
            depth++;
            continue;
        }

        if (char === ')' && depth > 0) {
            depth--;
            continue;
        }

        if (char === '=' && depth === 0) {
            return offset;
        }
    }

    return -1;
}

export function unwrapExportValue(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
    }

    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const closing = findMatchingMacroFunctionParen(trimmed, 0);
        if (closing === trimmed.length - 1) {
            return trimmed.slice(1, -1).trim();
        }
    }

    return trimmed;
}

export function unwrapResolvedScalarExportValue(value: string): string {
    return unwrapExportValue(value);
}

export function inferExportFormatFromPath(filePath: string): string {
    const lowerPath = filePath.toLowerCase();
    if (lowerPath.endsWith('.xlsx')) return 'xlsx';
    if (lowerPath.endsWith('.xlsb')) return 'xlsb';
    if (lowerPath.endsWith('.parquet')) return 'parquet';
    if (lowerPath.endsWith('.csv')) return 'csv';
    if (lowerPath.endsWith('.xpt')) return 'xpt';
    throw new Error('%EXPORT format is required when file extension is not .xlsx/.xlsb/.parquet/.csv/.xpt');
}

export function parseExportFormat(format: string): MacroExportFormat {
    const normalized = format.trim().toLowerCase();
    if (normalized === 'xlsx' || normalized === 'xlsb' || normalized === 'parquet' || normalized === 'csv' || normalized === 'xpt') {
        return normalized;
    }
    throw new Error(`Unsupported %EXPORT format: ${format}`);
}

export function parseExportBoolean(value: string, label: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
        return false;
    }
    throw new Error(`Invalid %EXPORT ${label} value: ${value}`);
}

export function readDirectivePayload(
    script: string,
    payloadStart: number,
): { text: string; end: number } {
    let quote: "'" | '"' | undefined;
    let parenDepth = 0;

    for (let i = payloadStart; i < script.length; i++) {
        const char = script[i];

        if (quote) {
            if (char === quote) {
                const next = script[i + 1];
                if (next === quote) {
                    i++;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (char === '(') {
            parenDepth++;
            continue;
        }

        if (char === ')' && parenDepth > 0) {
            parenDepth--;
            continue;
        }

        if (char === ';' && parenDepth === 0) {
            return {
                text: script.slice(payloadStart, i),
                end: i + 1,
            };
        }

        if ((char === '\n' || char === '\r') && parenDepth === 0) {
            return {
                text: script.slice(payloadStart, i),
                end: i,
            };
        }
    }

    return {
        text: script.slice(payloadStart),
        end: script.length,
    };
}

export function unquoteVariableValue(value: string): string {
    const qm = value.match(/^'(.*)'$/s) || value.match(/^"(.*)"$/s);
    return qm ? qm[1] : value;
}

export function skipHorizontalWhitespace(script: string, offset: number): number {
    let current = offset;
    while (script[current] === ' ' || script[current] === '\t') {
        current++;
    }
    return current;
}

export function skipDirectiveTrailingWhitespace(script: string, offset: number): number {
    const current = skipHorizontalWhitespace(script, offset);

    if (script[current] === '\r' && script[current + 1] === '\n') {
        return current + 2;
    }

    if (script[current] === '\r' || script[current] === '\n') {
        return current + 1;
    }

    return current;
}

export function isAtLineStart(script: string, offset: number): boolean {
    if (offset <= 0) {
        return true;
    }
    return script[offset - 1] === '\n' || script[offset - 1] === '\r';
}

export function updateLineStartState(wasAtLineStart: boolean, char: string): boolean {
    if (char === '\n' || char === '\r') {
        return true;
    }
    return wasAtLineStart && (char === ' ' || char === '\t');
}

export class MacroExpressionParser {
    private index = 0;

    constructor(private readonly expression: string) {}

    public parse(): number {
        const value = this.parseAdditive();
        this.skipWhitespace();
        if (this.index < this.expression.length) {
            throw new Error(`Unexpected token in %EVAL expression: ${this.expression[this.index]}`);
        }
        return value;
    }

    private parseAdditive(): number {
        let value = this.parseMultiplicative();

        while (true) {
            this.skipWhitespace();
            if (this.consume('+')) {
                value += this.parseMultiplicative();
                continue;
            }
            if (this.consume('-')) {
                value -= this.parseMultiplicative();
                continue;
            }
            return value;
        }
    }

    private parseMultiplicative(): number {
        let value = this.parseUnary();

        while (true) {
            this.skipWhitespace();
            if (this.consume('*')) {
                value *= this.parseUnary();
                continue;
            }
            if (this.consume('/')) {
                value /= this.parseUnary();
                continue;
            }
            return value;
        }
    }

    private parseUnary(): number {
        this.skipWhitespace();
        if (this.consume('+')) {
            return this.parseUnary();
        }
        if (this.consume('-')) {
            return -this.parseUnary();
        }
        return this.parsePrimary();
    }

    private parsePrimary(): number {
        this.skipWhitespace();
        if (this.consume('(')) {
            const value = this.parseAdditive();
            this.skipWhitespace();
            if (!this.consume(')')) {
                throw new Error('Missing closing parenthesis in %EVAL expression');
            }
            return value;
        }
        return this.parseNumber();
    }

    private parseNumber(): number {
        this.skipWhitespace();
        const match = this.expression.substring(this.index).match(/^\d+(?:\.\d+)?/);
        if (!match) {
            throw new Error('Expected number in %EVAL expression');
        }
        this.index += match[0].length;
        return Number(match[0]);
    }

    private consume(char: string): boolean {
        if (this.expression[this.index] === char) {
            this.index++;
            return true;
        }
        return false;
    }

    private skipWhitespace(): void {
        while (/\s/.test(this.expression[this.index] ?? '')) {
            this.index++;
        }
    }
}

export function evaluateMacroExpression(expression: string): string {
    return String(new MacroExpressionParser(expression).parse());
}

type ConditionToken =
    | { kind: 'number'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'word'; value: string }
    | { kind: 'operator'; value: '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' }
    | { kind: 'paren'; value: '(' | ')' };

type ConditionValue = string | number | boolean;
type ConditionOperator = Extract<ConditionToken, { kind: 'operator' }>['value'];

export class MacroConditionParser {
    private readonly tokens: ConditionToken[];
    private index = 0;

    constructor(expression: string) {
        this.tokens = tokenizeMacroCondition(expression);
    }

    public parse(): boolean {
        const value = this.parseOr();
        if (this.peek()) {
            throw new Error(`Unexpected token in %IF condition: ${this.describeToken(this.peek())}`);
        }
        return toConditionBoolean(value);
    }

    private parseOr(): ConditionValue {
        let value = this.parseAnd();
        while (this.consumeWord('OR')) {
            const right = this.parseAnd();
            value = toConditionBoolean(value) || toConditionBoolean(right);
        }
        return value;
    }

    private parseAnd(): ConditionValue {
        let value = this.parseNot();
        while (this.consumeWord('AND')) {
            const right = this.parseNot();
            value = toConditionBoolean(value) && toConditionBoolean(right);
        }
        return value;
    }

    private parseNot(): ConditionValue {
        if (this.consumeWord('NOT')) {
            return !toConditionBoolean(this.parseNot());
        }
        return this.parseComparison();
    }

    private parseComparison(): ConditionValue {
        const left = this.parsePrimary();
        const operator = this.peek();
        if (operator?.kind !== 'operator') {
            return left;
        }
        this.index++;
        const right = this.parsePrimary();
        return compareConditionValues(left, right, operator.value);
    }

    private parsePrimary(): ConditionValue {
        const token = this.peek();
        if (!token) {
            throw new Error('Expected value in %IF condition');
        }
        this.index++;

        if (token.kind === 'paren' && token.value === '(') {
            const value = this.parseOr();
            const close = this.peek();
            if (close?.kind !== 'paren' || close.value !== ')') {
                throw new Error('Missing closing parenthesis in %IF condition');
            }
            this.index++;
            return value;
        }

        if (token.kind === 'number' || token.kind === 'string') {
            return token.value;
        }

        if (token.kind === 'word') {
            if (/^(TRUE|YES)$/i.test(token.value)) {
                return true;
            }
            if (/^(FALSE|NO)$/i.test(token.value)) {
                return false;
            }
            return token.value;
        }

        throw new Error(`Expected value in %IF condition, found ${this.describeToken(token)}`);
    }

    private consumeWord(word: string): boolean {
        const token = this.peek();
        if (token?.kind === 'word' && token.value.toUpperCase() === word) {
            this.index++;
            return true;
        }
        return false;
    }

    private peek(): ConditionToken | undefined {
        return this.tokens[this.index];
    }

    private describeToken(token: ConditionToken | undefined): string {
        if (!token) {
            return '<end>';
        }
        return String(token.value);
    }
}

export function evaluateMacroCondition(expression: string): boolean {
    return new MacroConditionParser(expression).parse();
}

export function tokenizeMacroCondition(expression: string): ConditionToken[] {
    const tokens: ConditionToken[] = [];
    let offset = 0;

    while (offset < expression.length) {
        const char = expression[offset];
        if (/\s/.test(char ?? '')) {
            offset++;
            continue;
        }

        const twoChar = expression.slice(offset, offset + 2);
        if (['!=', '<>', '<=', '>='].includes(twoChar)) {
            tokens.push({ kind: 'operator', value: twoChar as ConditionOperator });
            offset += 2;
            continue;
        }

        if (char === '=' || char === '<' || char === '>') {
            tokens.push({ kind: 'operator', value: char });
            offset++;
            continue;
        }

        if (char === '(' || char === ')') {
            tokens.push({ kind: 'paren', value: char });
            offset++;
            continue;
        }

        if (char === "'" || char === '"') {
            const end = skipQuotedLiteral(expression, offset, char);
            const inner = expression.slice(offset + 1, Math.max(offset + 1, end - 1));
            tokens.push({
                kind: 'string',
                value: inner.replace(new RegExp(`${escapeRegExp(char)}${escapeRegExp(char)}`, 'g'), char),
            });
            offset = end;
            continue;
        }

        const numberMatch = expression.slice(offset).match(/^\d+(?:\.\d+)?/);
        if (numberMatch) {
            tokens.push({ kind: 'number', value: Number(numberMatch[0]) });
            offset += numberMatch[0].length;
            continue;
        }

        const wordMatch = expression.slice(offset).match(/^[^\s()=<>!]+/);
        if (wordMatch) {
            tokens.push({ kind: 'word', value: wordMatch[0] });
            offset += wordMatch[0].length;
            continue;
        }

        throw new Error(`Unexpected token in %IF condition: ${char}`);
    }

    return tokens;
}

export function compareConditionValues(
    left: ConditionValue,
    right: ConditionValue,
    operator: ConditionOperator,
): boolean {
    const leftNumber = typeof left === 'number' ? left : Number(left);
    const rightNumber = typeof right === 'number' ? right : Number(right);
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
    const leftComparable = bothNumeric ? leftNumber : String(left).toUpperCase();
    const rightComparable = bothNumeric ? rightNumber : String(right).toUpperCase();

    switch (operator) {
        case '=':
            return leftComparable === rightComparable;
        case '!=':
        case '<>':
            return leftComparable !== rightComparable;
        case '<':
            return leftComparable < rightComparable;
        case '<=':
            return leftComparable <= rightComparable;
        case '>':
            return leftComparable > rightComparable;
        case '>=':
            return leftComparable >= rightComparable;
        default:
            throw new Error(`Unsupported %IF operator: ${operator}`);
    }
}

export function toConditionBoolean(value: ConditionValue): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    const normalized = value.trim().toUpperCase();
    if (!normalized || normalized === '0' || normalized === 'FALSE' || normalized === 'NO') {
        return false;
    }
    return true;
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readTriviaOrQuotedText(
    text: string,
    offset: number,
): { text: string; end: number } | undefined {
    if (text[offset] === '-' && text[offset + 1] === '-') {
        let end = offset + 2;
        while (end < text.length && text[end] !== '\n') {
            end++;
        }
        return { text: text.slice(offset, end), end };
    }

    if (text[offset] === '/' && text[offset + 1] === '*') {
        let end = offset + 2;
        while (end + 1 < text.length && !(text[end] === '*' && text[end + 1] === '/')) {
            end++;
        }
        end = Math.min(end + 2, text.length);
        return { text: text.slice(offset, end), end };
    }

    if (text[offset] === "'") {
        const end = skipQuotedLiteral(text, offset, "'");
        return { text: text.slice(offset, end), end };
    }

    if (text[offset] === '"') {
        const end = skipQuotedLiteral(text, offset, '"');
        return { text: text.slice(offset, end), end };
    }

    return undefined;
}

export function readMacroQueryFunctionAt(
    text: string,
    offset: number,
): MacroQueryFunction | undefined {
    const match = text.slice(offset).match(/^%(sql|sqllist)\s*\(/i);
    if (!match?.[1]) {
        return undefined;
    }

    const openParenOffset = offset + match[0].lastIndexOf('(');
    const closeParenOffset = findMatchingMacroFunctionParen(text, openParenOffset);
    if (closeParenOffset === -1) {
        throw new Error(`Unterminated %${match[1].toUpperCase()} macro`);
    }

    return {
        kind: match[1].toLowerCase() === 'sqllist' ? 'sqllist' : 'sql',
        start: offset,
        end: closeParenOffset + 1,
        text: text.slice(offset, closeParenOffset + 1),
        query: text.slice(openParenOffset + 1, closeParenOffset).trim(),
    };
}

export function readMacroEvalFunctionAt(
    text: string,
    offset: number,
): MacroEvalFunction | undefined {
    const match = text.slice(offset).match(/^%eval\s*\(/i);
    if (!match) {
        return undefined;
    }

    const openParenOffset = offset + match[0].lastIndexOf('(');
    const closeParenOffset = findMatchingMacroFunctionParen(text, openParenOffset);
    if (closeParenOffset === -1) {
        throw new Error('Unterminated %EVAL macro');
    }

    return {
        start: offset,
        end: closeParenOffset + 1,
        text: text.slice(offset, closeParenOffset + 1),
        expression: text.slice(openParenOffset + 1, closeParenOffset).trim(),
    };
}

export function findMatchingMacroFunctionParen(text: string, openParenOffset: number): number {
    let depth = 0;
    let offset = openParenOffset;

    while (offset < text.length) {
        const skipped = readTriviaOrQuotedText(text, offset);
        if (skipped) {
            offset = skipped.end;
            continue;
        }

        if (text[offset] === '(') {
            depth++;
        } else if (text[offset] === ')') {
            depth--;
            if (depth === 0) {
                return offset;
            }
        }

        offset++;
    }

    return -1;
}

export function formatMacroQueryResult(
    kind: MacroQueryFunction['kind'],
    result: MacroQueryExecutionResult,
): string {
    if (kind === 'sql') {
        const firstValue = result.rows[0]?.[0];
        return firstValue === null || firstValue === undefined ? '' : String(firstValue);
    }

    if (result.rows.length === 0) {
        return 'NULL';
    }

    return result.rows.map(row => formatSqlLiteral(row[0])).join(', ');
}

export function formatSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }

    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }

    if (value instanceof Date) {
        return `'${value.toISOString().replace(/'/g, "''")}'`;
    }

    return `'${String(value).replace(/'/g, "''")}'`;
}

export function readMacroReferenceAt(text: string, offset: number): MacroReference | undefined {
    const ampersandMatch = text.slice(offset).match(/^&([A-Za-z_][A-Za-z0-9_]*)/);
    if (ampersandMatch?.[1]) {
        return {
            name: ampersandMatch[1],
            start: offset,
            end: offset + ampersandMatch[0].length,
            text: ampersandMatch[0],
        };
    }

    const bracedMatch = text.slice(offset).match(/^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/);
    if (bracedMatch?.[1]) {
        return {
            name: bracedMatch[1],
            start: offset,
            end: offset + bracedMatch[0].length,
            text: bracedMatch[0],
        };
    }

    const dollarMatch = text.slice(offset).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (dollarMatch?.[1]) {
        return {
            name: dollarMatch[1],
            start: offset,
            end: offset + dollarMatch[0].length,
            text: dollarMatch[0],
        };
    }

    return undefined;
}

export function skipQuotedLiteral(text: string, startOffset: number, quote: "'" | '"'): number {
    let offset = startOffset + 1;
    while (offset < text.length) {
        if (text[offset] === quote) {
            if (text[offset + 1] === quote) {
                offset += 2;
                continue;
            }
            return offset + 1;
        }
        offset++;
    }
    return offset;
}

export function collectMacroReferenceNamesOutsideTrivia(text: string): string[] {
    const names = new Set<string>();
    let offset = 0;

    while (offset < text.length) {
        const skipped = readTriviaOrQuotedText(text, offset);
        if (skipped) {
            offset = skipped.end;
            continue;
        }

        const reference = readMacroReferenceAt(text, offset);
        if (reference) {
            names.add(normalizeVariableName(reference.name));
            offset = reference.end;
            continue;
        }

        offset++;
    }

    return Array.from(names).sort();
}

export function pushScriptEvent(
    state: MacroProcessingState,
    type: MacroScriptEvent['type'],
    message: string,
    sourceName: string,
    script: string,
    offset: number,
): void {
    state.scriptEvents.push({
        type,
        message,
        sourceName,
        line: lineOfOffset(script, offset),
    });
}

export function createBranchScanState(state: MacroProcessingState): MacroProcessingState {
    return {
        ...state,
        environment: new MacroEnvironment(state.environment.toRecord()),
        putMessages: [],
    };
}

export function throwMacroError(
    message: string,
    sourceName: string,
    line: number,
    state: MacroProcessingState,
): never {
    if (message.includes(' at ') && message.includes(':')) {
        throw new MacroScriptError(message);
    }

    const formatted = `${message} at ${sourceName}:${line}`;
    state.scriptEvents.push({
        type: 'error',
        message: `>>> ERROR: ${formatted}`,
        sourceName,
        line,
    });
    throw new MacroScriptError(formatted);
}

export function lineOfOffset(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
        }
    }
    return line;
}

export function unwrapVariableValue(value: string): string {
    return unquoteVariableValue(value.trim());
}

export function formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
