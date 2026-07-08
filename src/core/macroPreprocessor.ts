export interface MacroVariable {
    name: string;
    normalizedName: string;
    value: string;
}

export interface MacroPreprocessorOptions {
    environment?: MacroEnvironment;
    initialValues?: Record<string, string>;
    replaceVariables?: boolean;
    resolvePutMessages?: boolean;
}

export interface MacroPreprocessorContext {
    log?: (message: string) => void | Promise<void>;
    prompt?: (variables: Set<string>) => Promise<Record<string, string>>;
    query?: MacroQueryExecutor;
}

export interface MacroPreprocessResult {
    sql: string;
    variables: Record<string, string>;
    putMessages: string[];
    unresolvedVariables: string[];
    environment: MacroEnvironment;
}

export interface MacroQueryExecutionResult {
    columns?: readonly { name: string; type?: string }[];
    rows: readonly (readonly unknown[])[];
}

export type MacroQueryExecutor = (
    sql: string,
) => Promise<MacroQueryExecutionResult>;

interface MacroReference {
    name: string;
    start: number;
    end: number;
    text: string;
}

interface ScanOptions {
    replaceVariables: boolean;
    unresolved: Set<string>;
}

interface MacroQueryFunction {
    kind: 'sql' | 'sqllist';
    start: number;
    end: number;
    text: string;
    query: string;
}

interface MacroEvalFunction {
    start: number;
    end: number;
    text: string;
    expression: string;
}

type MacroDirective =
    | { kind: 'declaration'; name: string; value: string; end: number }
    | { kind: 'put'; message: string; end: number };

export class MacroEnvironment {
    private readonly values = new Map<string, MacroVariable>();

    constructor(initialValues?: Record<string, string>) {
        this.setMany(initialValues);
    }

    public set(name: string, value: string): void {
        const normalizedName = normalizeVariableName(name);
        this.values.set(normalizedName, {
            name: name.trim(),
            normalizedName,
            value,
        });
    }

    public setMany(values?: Record<string, string>): void {
        if (!values) {
            return;
        }

        for (const [name, value] of Object.entries(values)) {
            this.set(name, value);
        }
    }

    public get(name: string): string | undefined {
        return this.values.get(normalizeVariableName(name))?.value;
    }

    public has(name: string): boolean {
        return this.values.has(normalizeVariableName(name));
    }

    public toRecord(): Record<string, string> {
        const record: Record<string, string> = {};
        for (const [name, variable] of this.values) {
            record[name] = variable.value;
        }
        return record;
    }
}

function normalizeVariableName(name: string): string {
    return name.trim().toUpperCase();
}

export class MacroPreprocessor {
    public async processScript(
        script: string,
        options: MacroPreprocessorOptions = {},
        context: MacroPreprocessorContext = {},
    ): Promise<MacroPreprocessResult> {
        const environment = options.environment ?? new MacroEnvironment(options.initialValues);
        environment.setMany(options.initialValues);

        if (!script) {
            return {
                sql: '',
                variables: environment.toRecord(),
                putMessages: [],
                unresolvedVariables: [],
                environment,
            };
        }

        const putMessages: string[] = [];
        const unresolved = new Set<string>();
        const remainingSql = await this.processDirectiveLinesAsync(
            script,
            environment,
            putMessages,
            unresolved,
            options.replaceVariables !== false,
            options.resolvePutMessages === true,
            context,
        );

        const sql = await this.resolveMacroTextAsync(
            remainingSql,
            environment,
            {
                replaceVariables: options.replaceVariables !== false,
                unresolved,
            },
            context,
        );

        const result: MacroPreprocessResult = {
            sql,
            variables: environment.toRecord(),
            putMessages,
            unresolvedVariables: Array.from(unresolved).sort(),
            environment,
        };
        for (const message of result.putMessages) {
            await context.log?.(message);
        }
        return result;
    }

    public processScriptSync(
        script: string,
        options: MacroPreprocessorOptions = {},
    ): MacroPreprocessResult {
        const environment = options.environment ?? new MacroEnvironment(options.initialValues);
        environment.setMany(options.initialValues);

        if (!script) {
            return {
                sql: '',
                variables: environment.toRecord(),
                putMessages: [],
                unresolvedVariables: [],
                environment,
            };
        }

        const putMessages: string[] = [];
        const unresolved = new Set<string>();
        const remainingSql = this.processDirectiveLines(
            script,
            environment,
            putMessages,
            unresolved,
            options.replaceVariables !== false,
            options.resolvePutMessages === true,
        );

        const sql = this.resolveMacroReferencesOutsideTrivia(
            remainingSql,
            environment,
            {
                replaceVariables: options.replaceVariables !== false,
                unresolved,
            },
        );

        return {
            sql,
            variables: environment.toRecord(),
            putMessages,
            unresolvedVariables: Array.from(unresolved).sort(),
            environment,
        };
    }

    private processDirectiveLines(
        script: string,
        environment: MacroEnvironment,
        putMessages: string[],
        unresolved: Set<string>,
        replaceVariables: boolean,
        resolvePutMessages: boolean,
    ): string {
        let remaining = '';
        let offset = 0;
        let atLineStart = true;
        let allowChainedDirective = true;

        while (offset < script.length) {
            if (atLineStart || allowChainedDirective) {
                const directive = readDirectiveAt(script, offset);
                if (directive) {
                    if (directive.kind === 'declaration') {
                        const value = this.resolveDirectiveText(
                            directive.value,
                            environment,
                            unresolved,
                            replaceVariables,
                        );
                        environment.set(directive.name, value);
                    } else {
                        putMessages.push(
                            this.resolveDirectiveText(
                                directive.message,
                                environment,
                                unresolved,
                                replaceVariables || resolvePutMessages,
                            ),
                        );
                    }
                    offset = skipDirectiveTrailingWhitespace(script, directive.end);
                    atLineStart = isAtLineStart(script, offset);
                    allowChainedDirective = true;
                    continue;
                }
            }

            const char = script[offset];
            remaining += char;
            offset++;
            allowChainedDirective = false;
            atLineStart = updateLineStartState(atLineStart, char);
        }

        return remaining;
    }

    private async processDirectiveLinesAsync(
        script: string,
        environment: MacroEnvironment,
        putMessages: string[],
        unresolved: Set<string>,
        replaceVariables: boolean,
        resolvePutMessages: boolean,
        context: MacroPreprocessorContext,
    ): Promise<string> {
        let remaining = '';
        let offset = 0;
        let atLineStart = true;
        let allowChainedDirective = true;

        while (offset < script.length) {
            if (atLineStart || allowChainedDirective) {
                const directive = readDirectiveAt(script, offset);
                if (directive) {
                    if (directive.kind === 'declaration') {
                        const value = await this.resolveDirectiveTextAsync(
                            directive.value,
                            environment,
                            unresolved,
                            replaceVariables,
                            context,
                        );
                        environment.set(directive.name, value);
                    } else {
                        putMessages.push(
                            await this.resolveDirectiveTextAsync(
                                directive.message,
                                environment,
                                unresolved,
                                replaceVariables || resolvePutMessages,
                                context,
                            ),
                        );
                    }
                    offset = skipDirectiveTrailingWhitespace(script, directive.end);
                    atLineStart = isAtLineStart(script, offset);
                    allowChainedDirective = true;
                    continue;
                }
            }

            const char = script[offset];
            remaining += char;
            offset++;
            allowChainedDirective = false;
            atLineStart = updateLineStartState(atLineStart, char);
        }

        return remaining;
    }

    private resolveDirectiveText(
        text: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
        replaceVariables: boolean,
    ): string {
        const evalMatch = text.match(/^%eval\s*\((.*)\)$/i);
        if (evalMatch) {
            const expression = this.resolveMacroReferencesOutsideTrivia(
                evalMatch[1],
                environment,
                { replaceVariables: true, unresolved },
            );
            return evaluateMacroExpression(expression);
        }

        return this.resolveMacroReferencesOutsideTrivia(
            text,
            environment,
            { replaceVariables, unresolved },
        );
    }

    private async resolveDirectiveTextAsync(
        text: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
        replaceVariables: boolean,
        context: MacroPreprocessorContext,
    ): Promise<string> {
        const evalMatch = text.match(/^%eval\s*\((.*)\)$/i);
        if (evalMatch) {
            const expression = await this.resolveMacroTextAsync(
                evalMatch[1],
                environment,
                { replaceVariables: true, unresolved },
                context,
            );
            return evaluateMacroExpression(expression);
        }

        return await this.resolveMacroTextAsync(
            text,
            environment,
            { replaceVariables, unresolved },
            context,
        );
    }

    private async resolveMacroTextAsync(
        text: string,
        environment: MacroEnvironment,
        options: ScanOptions,
        context: MacroPreprocessorContext,
    ): Promise<string> {
        let result = '';
        let i = 0;

        while (i < text.length) {
            const skipped = readTriviaOrQuotedText(text, i);
            if (skipped) {
                result += skipped.text;
                i = skipped.end;
                continue;
            }

            const evalFunction = readMacroEvalFunctionAt(text, i);
            if (evalFunction) {
                if (!options.replaceVariables) {
                    await this.resolveMacroTextAsync(
                        evalFunction.expression,
                        environment,
                        options,
                        context,
                    );
                    result += evalFunction.text;
                    i = evalFunction.end;
                    continue;
                }

                const expression = await this.resolveMacroTextAsync(
                    evalFunction.expression,
                    environment,
                    options,
                    context,
                );
                result += evaluateMacroExpression(expression);
                i = evalFunction.end;
                continue;
            }

            const queryFunction = readMacroQueryFunctionAt(text, i);
            if (queryFunction) {
                if (!options.replaceVariables) {
                    await this.resolveMacroTextAsync(
                        queryFunction.query,
                        environment,
                        options,
                        context,
                    );
                    result += queryFunction.text;
                    i = queryFunction.end;
                    continue;
                }

                if (!context.query) {
                    throw new Error(`%${queryFunction.kind.toUpperCase()} requires a query execution context`);
                }

                const resolvedQuery = await this.resolveMacroTextAsync(
                    queryFunction.query,
                    environment,
                    options,
                    context,
                );
                const queryResult = await context.query(resolvedQuery);
                result += formatMacroQueryResult(queryFunction.kind, queryResult);
                i = queryFunction.end;
                continue;
            }

            const reference = readMacroReferenceAt(text, i);
            if (reference) {
                const value = environment.get(reference.name);
                if (value === undefined) {
                    options.unresolved.add(normalizeVariableName(reference.name));
                    result += reference.text;
                } else {
                    result += options.replaceVariables ? value : reference.text;
                }
                i = reference.end;
                continue;
            }

            result += text[i];
            i++;
        }

        return result;
    }

    private resolveMacroReferencesOutsideTrivia(
        text: string,
        environment: MacroEnvironment,
        options: ScanOptions,
    ): string {
        let result = '';
        let i = 0;

        while (i < text.length) {
            const skipped = readTriviaOrQuotedText(text, i);
            if (skipped) {
                result += skipped.text;
                i = skipped.end;
                continue;
            }

            const evalFunction = readMacroEvalFunctionAt(text, i);
            if (evalFunction) {
                this.resolveMacroReferencesOutsideTrivia(
                    evalFunction.expression,
                    environment,
                    options,
                );

                if (!options.replaceVariables) {
                    result += evalFunction.text;
                    i = evalFunction.end;
                    continue;
                }

                const expression = this.resolveMacroReferencesOutsideTrivia(
                    evalFunction.expression,
                    environment,
                    options,
                );
                result += evaluateMacroExpression(expression);
                i = evalFunction.end;
                continue;
            }

            const queryFunction = readMacroQueryFunctionAt(text, i);
            if (queryFunction) {
                this.resolveMacroReferencesOutsideTrivia(
                    queryFunction.query,
                    environment,
                    options,
                );
                if (options.replaceVariables) {
                    throw new Error(`%${queryFunction.kind.toUpperCase()} requires a query execution context`);
                }
                result += queryFunction.text;
                i = queryFunction.end;
                continue;
            }

            const reference = readMacroReferenceAt(text, i);
            if (reference) {
                const value = environment.get(reference.name);
                if (value === undefined) {
                    options.unresolved.add(normalizeVariableName(reference.name));
                    result += reference.text;
                } else {
                    result += options.replaceVariables ? value : reference.text;
                }
                i = reference.end;
                continue;
            }

            result += text[i];
            i++;
        }

        return result;
    }
}

function readDirectiveAt(script: string, offset: number): MacroDirective | undefined {
    const directiveStart = skipHorizontalWhitespace(script, offset);
    const text = script.slice(directiveStart);
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

    return undefined;
}

function readDirectivePayload(
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

function unquoteVariableValue(value: string): string {
    const qm = value.match(/^'(.*)'$/s) || value.match(/^"(.*)"$/s);
    return qm ? qm[1] : value;
}

function skipHorizontalWhitespace(script: string, offset: number): number {
    let current = offset;
    while (script[current] === ' ' || script[current] === '\t') {
        current++;
    }
    return current;
}

function skipDirectiveTrailingWhitespace(script: string, offset: number): number {
    const current = skipHorizontalWhitespace(script, offset);

    if (script[current] === '\r' && script[current + 1] === '\n') {
        return current + 2;
    }

    if (script[current] === '\r' || script[current] === '\n') {
        return current + 1;
    }

    return current;
}

function isAtLineStart(script: string, offset: number): boolean {
    if (offset <= 0) {
        return true;
    }
    return script[offset - 1] === '\n' || script[offset - 1] === '\r';
}

function updateLineStartState(wasAtLineStart: boolean, char: string): boolean {
    if (char === '\n' || char === '\r') {
        return true;
    }
    return wasAtLineStart && (char === ' ' || char === '\t');
}

class MacroExpressionParser {
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

function evaluateMacroExpression(expression: string): string {
    return String(new MacroExpressionParser(expression).parse());
}

function readTriviaOrQuotedText(
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

function readMacroQueryFunctionAt(
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

function readMacroEvalFunctionAt(
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

function findMatchingMacroFunctionParen(text: string, openParenOffset: number): number {
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

function formatMacroQueryResult(
    kind: MacroQueryFunction['kind'],
    result: MacroQueryExecutionResult,
): string {
    if (kind === 'sql') {
        const firstValue = result.rows[0]?.[0];
        return firstValue === null || firstValue === undefined ? '' : String(firstValue);
    }

    return result.rows.map(row => formatSqlLiteral(row[0])).join(', ');
}

function formatSqlLiteral(value: unknown): string {
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

function readMacroReferenceAt(text: string, offset: number): MacroReference | undefined {
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

function skipQuotedLiteral(text: string, startOffset: number, quote: "'" | '"'): number {
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
