import {
    collectMacroReferenceNamesOutsideTrivia,
    createBranchScanState,
    evaluateMacroCondition,
    evaluateMacroExpression,
    findDoBlock,
    findIfBlock,
    formatErrorMessage,
    formatMacroQueryResult,
    inferExportFormatFromPath,
    isAtLineStart,
    lineOfOffset,
    parseExportBoolean,
    parseExportFormat,
    parseMacroExportPayload,
    pushScriptEvent,
    readDirectiveAt,
    readMacroEvalFunctionAt,
    readMacroQueryFunctionAt,
    readMacroReferenceAt,
    readTriviaOrQuotedText,
    skipDirectiveTrailingWhitespace,
    throwMacroError,
    unwrapResolvedScalarExportValue,
    unwrapVariableValue,
    updateLineStartState,
} from './macroHelpers';
import {
    DEFAULT_MAX_BLOCK_DEPTH,
    DEFAULT_MAX_INCLUDE_DEPTH,
    MacroEnvironment,
    normalizeVariableName,
} from './macroTypes';
import type {
    MacroExportRequest,
    MacroPreprocessorContext,
    MacroPreprocessorOptions,
    MacroPreprocessResult,
    MacroProcessingState,
    MacroQueryExecutionResult,
    MacroScriptEvent,
    ScanOptions,
} from './macroTypes';

export * from './macroTypes';


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
                scriptEvents: [],
            };
        }

        const putMessages: string[] = [];
        const scriptEvents: MacroScriptEvent[] = [];
        const unresolved = new Set<string>();
        const remainingSql = await this.processScriptBodyAsync(
            script,
            {
                environment,
                putMessages,
                scriptEvents,
                unresolved,
                replaceVariables: options.replaceVariables !== false,
                resolvePutMessages: options.resolvePutMessages === true,
                context,
            },
            context.sourceName ?? 'main',
            0,
            [context.sourceName ?? 'main'],
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
            scriptEvents,
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
                scriptEvents: [],
            };
        }

        const putMessages: string[] = [];
        const scriptEvents: MacroScriptEvent[] = [];
        const unresolved = new Set<string>();
        const remainingSql = this.processScriptBody(
            script,
            {
                environment,
                putMessages,
                scriptEvents,
                unresolved,
                replaceVariables: options.replaceVariables !== false,
                resolvePutMessages: options.resolvePutMessages === true,
                context: {},
            },
            'main',
            0,
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
            scriptEvents,
        };
    }

    private processScriptBody(
        script: string,
        state: MacroProcessingState,
        sourceName: string,
        blockDepth: number,
    ): string {
        if (blockDepth > (state.context.maxBlockDepth ?? DEFAULT_MAX_BLOCK_DEPTH)) {
            throwMacroError('Macro block nesting is too deep', sourceName, 1, state);
        }

        let remaining = '';
        let offset = 0;
        let atLineStart = true;
        let allowChainedDirective = true;

        while (offset < script.length) {
            if (atLineStart || allowChainedDirective) {
                const directive = readDirectiveAt(script, offset);
                if (directive) {
                    try {
                        if (directive.kind === 'declaration') {
                            const value = this.resolveDirectiveText(
                                directive.value,
                                state.environment,
                                state.unresolved,
                                state.replaceVariables,
                            );
                            state.environment.set(directive.name, value);
                        } else if (directive.kind === 'put') {
                            const message = this.resolveDirectiveText(
                                directive.message,
                                state.environment,
                                state.unresolved,
                                state.replaceVariables || state.resolvePutMessages,
                            );
                            state.putMessages.push(message);
                            pushScriptEvent(state, 'put', `>>> %PUT: ${message}`, sourceName, script, offset);
                        } else if (directive.kind === 'export') {
                            this.resolveExportDirectiveScan(
                                directive.payload,
                                state.environment,
                                state.unresolved,
                            );
                            if (state.replaceVariables) {
                                throw new Error('%EXPORT requires an async export execution context');
                            }
                        } else if (directive.kind === 'include') {
                            throw new Error('%INCLUDE requires an async file read context');
                        } else if (directive.kind === 'python') {
                            if (state.replaceVariables) {
                                throw new Error('%PYTHON requires an async execution context');
                            }
                        } else if (directive.kind === 'do') {
                            const block = findDoBlock(script, directive.end);
                            const blockText = script.slice(directive.end, block.bodyEnd);
                            remaining += this.processScriptBody(
                                blockText,
                                state,
                                sourceName,
                                blockDepth + 1,
                            );
                            offset = skipDirectiveTrailingWhitespace(script, block.end);
                            atLineStart = isAtLineStart(script, offset);
                            allowChainedDirective = true;
                            continue;
                        } else if (directive.kind === 'if') {
                            const block = findIfBlock(script, directive.end, blockDepth);
                            const condition = this.resolveDirectiveText(
                                directive.condition,
                                state.environment,
                                state.unresolved,
                                true,
                            );
                            const conditionUnresolved = collectMacroReferenceNamesOutsideTrivia(condition);
                            if (state.replaceVariables && conditionUnresolved.length > 0) {
                                throw new Error(`%IF condition has unresolved variables: ${conditionUnresolved.join(', ')}`);
                            }
                            if (!state.replaceVariables && conditionUnresolved.length > 0) {
                                const thenState = createBranchScanState(state);
                                const thenSql = this.processScriptBody(
                                    script.slice(block.thenStart, block.thenEnd),
                                    thenState,
                                    sourceName,
                                    blockDepth + 1,
                                );
                                this.resolveMacroReferencesOutsideTrivia(
                                    thenSql,
                                    thenState.environment,
                                    { replaceVariables: false, unresolved: state.unresolved },
                                );
                                if (block.elseStart !== undefined && block.elseEnd !== undefined) {
                                    const elseState = createBranchScanState(state);
                                    const elseSql = this.processScriptBody(
                                        script.slice(block.elseStart, block.elseEnd),
                                        elseState,
                                        sourceName,
                                        blockDepth + 1,
                                    );
                                    this.resolveMacroReferencesOutsideTrivia(
                                        elseSql,
                                        elseState.environment,
                                        { replaceVariables: false, unresolved: state.unresolved },
                                    );
                                }
                                offset = skipDirectiveTrailingWhitespace(script, block.end);
                                atLineStart = isAtLineStart(script, offset);
                                allowChainedDirective = true;
                                continue;
                            }
                            const shouldRunThen = evaluateMacroCondition(condition);
                            pushScriptEvent(
                                state,
                                'branch',
                                `>>> %IF: ${shouldRunThen ? 'executed THEN branch' : 'skipped THEN branch'}`,
                                sourceName,
                                script,
                                offset,
                            );
                            const branchText = shouldRunThen
                                ? script.slice(block.thenStart, block.thenEnd)
                                : block.elseStart !== undefined && block.elseEnd !== undefined
                                    ? script.slice(block.elseStart, block.elseEnd)
                                    : '';
                            remaining += this.processScriptBody(
                                branchText,
                                state,
                                sourceName,
                                blockDepth + 1,
                            );
                            offset = skipDirectiveTrailingWhitespace(script, block.end);
                            atLineStart = isAtLineStart(script, offset);
                            allowChainedDirective = true;
                            continue;
                        } else if (directive.kind === 'else') {
                            throw new Error('%ELSE without matching %IF');
                        } else {
                            throw new Error('%END without matching %IF');
                        }
                    } catch (error) {
                        throwMacroError(formatErrorMessage(error), sourceName, lineOfOffset(script, offset), state);
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

    private async processScriptBodyAsync(
        script: string,
        state: MacroProcessingState,
        sourceName: string,
        blockDepth: number,
        includeStack: string[],
    ): Promise<string> {
        if (blockDepth > (state.context.maxBlockDepth ?? DEFAULT_MAX_BLOCK_DEPTH)) {
            throwMacroError('Macro block nesting is too deep', sourceName, 1, state);
        }

        let remaining = '';
        let offset = 0;
        let atLineStart = true;
        let allowChainedDirective = true;

        while (offset < script.length) {
            if (atLineStart || allowChainedDirective) {
                const directive = readDirectiveAt(script, offset);
                if (directive) {
                    try {
                        if (directive.kind === 'declaration') {
                            const value = await this.resolveDirectiveTextAsync(
                                directive.value,
                                state.environment,
                                state.unresolved,
                                state.replaceVariables,
                                state.context,
                            );
                            state.environment.set(directive.name, value);
                        } else if (directive.kind === 'put') {
                            const message = await this.resolveDirectiveTextAsync(
                                directive.message,
                                state.environment,
                                state.unresolved,
                                state.replaceVariables || state.resolvePutMessages,
                                state.context,
                            );
                            state.putMessages.push(message);
                            pushScriptEvent(state, 'put', `>>> %PUT: ${message}`, sourceName, script, offset);
                        } else if (directive.kind === 'export') {
                            if (state.replaceVariables) {
                                if (!state.context.exporter) {
                                    throw new Error('%EXPORT requires an export execution context');
                                }
                                const request = await this.resolveExportDirectiveAsync(
                                    directive.payload,
                                    state.environment,
                                    state.unresolved,
                                    state.context,
                                );
                                const unresolvedExportQueryVariables =
                                    collectMacroReferenceNamesOutsideTrivia(request.query);
                                if (unresolvedExportQueryVariables.length > 0) {
                                    throw new Error(
                                        `%EXPORT query has unresolved variables: ${unresolvedExportQueryVariables.join(', ')}`,
                                    );
                                }
                                const exportResult = await state.context.exporter(request);
                                pushScriptEvent(
                                    state,
                                    'export',
                                    exportResult.message ?? `>>> %EXPORT: Exported ${exportResult.rowsExported} rows to ${exportResult.filePath}`,
                                    sourceName,
                                    script,
                                    offset,
                                );
                            } else {
                                await this.resolveExportDirectiveScanAsync(
                                    directive.payload,
                                    state.environment,
                                    state.unresolved,
                                    state.context,
                                );
                            }
                        } else if (directive.kind === 'include') {
                            const resolvedPath = unwrapVariableValue(
                                await this.resolveDirectiveTextAsync(
                                    directive.path,
                                    state.environment,
                                    state.unresolved,
                                    state.replaceVariables,
                                    state.context,
                                ),
                            );
                            if (!state.context.readFile) {
                                throw new Error('%INCLUDE requires a file read context');
                            }
                            if (includeStack.length > (state.context.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH)) {
                                throw new Error('Macro include nesting is too deep');
                            }
                            const included = await state.context.readFile(resolvedPath, sourceName);
                            if (includeStack.includes(included.path)) {
                                throw new Error(`Macro include cycle detected: ${[...includeStack, included.path].join(' -> ')}`);
                            }
                            pushScriptEvent(state, 'include', `>>> %INCLUDE: ${included.path}`, sourceName, script, offset);
                            remaining += await this.processScriptBodyAsync(
                                included.content,
                                state,
                                included.path,
                                blockDepth,
                                [...includeStack, included.path],
                            );
                        } else if (directive.kind === 'python') {
                            if (state.replaceVariables) {
                                if (!state.context.pythonExecutor) {
                                    throw new Error('%PYTHON requires a python execution context');
                                }
                                const resolvedScript = await this.resolveDirectiveTextAsync(
                                    directive.script,
                                    state.environment,
                                    state.unresolved,
                                    state.replaceVariables,
                                    state.context,
                                );
                                const resolvedArgs = await Promise.all(
                                    directive.args.map((arg) =>
                                        this.resolveDirectiveTextAsync(
                                            arg,
                                            state.environment,
                                            state.unresolved,
                                            state.replaceVariables,
                                            state.context,
                                        ),
                                    ),
                                );
                                const result = await state.context.pythonExecutor(resolvedScript, resolvedArgs);
                                if (result.exitCode !== 0) {
                                    throw new Error(`%PYTHON script failed with exit code ${result.exitCode}: ${result.stderr}`);
                                }
                                pushScriptEvent(
                                    state,
                                    'python',
                                    `>>> %PYTHON: executed ${resolvedScript} (exit ${result.exitCode})`,
                                    sourceName,
                                    script,
                                    offset,
                                );
                                remaining += result.stdout;
                            } else {
                                await this.resolveDirectiveTextAsync(
                                    directive.script,
                                    state.environment,
                                    state.unresolved,
                                    false,
                                    state.context,
                                );
                                for (const arg of directive.args) {
                                    await this.resolveDirectiveTextAsync(
                                        arg,
                                        state.environment,
                                        state.unresolved,
                                        false,
                                        state.context,
                                    );
                                }
                            }
                        } else if (directive.kind === 'do') {
                            const block = findDoBlock(script, directive.end);
                            const blockText = script.slice(directive.end, block.bodyEnd);
                            remaining += await this.processScriptBodyAsync(
                                blockText,
                                state,
                                sourceName,
                                blockDepth + 1,
                                includeStack,
                            );
                            offset = skipDirectiveTrailingWhitespace(script, block.end);
                            atLineStart = isAtLineStart(script, offset);
                            allowChainedDirective = true;
                            continue;
                        } else if (directive.kind === 'if') {
                            const block = findIfBlock(script, directive.end, blockDepth);
                            const condition = await this.resolveDirectiveTextAsync(
                                directive.condition,
                                state.environment,
                                state.unresolved,
                                true,
                                state.context,
                            );
                            const conditionUnresolved = collectMacroReferenceNamesOutsideTrivia(condition);
                            if (state.replaceVariables && conditionUnresolved.length > 0) {
                                throw new Error(`%IF condition has unresolved variables: ${conditionUnresolved.join(', ')}`);
                            }
                            if (!state.replaceVariables && conditionUnresolved.length > 0) {
                                const thenState = createBranchScanState(state);
                                const thenSql = await this.processScriptBodyAsync(
                                    script.slice(block.thenStart, block.thenEnd),
                                    thenState,
                                    sourceName,
                                    blockDepth + 1,
                                    includeStack,
                                );
                                await this.resolveMacroTextAsync(
                                    thenSql,
                                    thenState.environment,
                                    { replaceVariables: false, unresolved: state.unresolved },
                                    state.context,
                                );
                                if (block.elseStart !== undefined && block.elseEnd !== undefined) {
                                    const elseState = createBranchScanState(state);
                                    const elseSql = await this.processScriptBodyAsync(
                                        script.slice(block.elseStart, block.elseEnd),
                                        elseState,
                                        sourceName,
                                        blockDepth + 1,
                                        includeStack,
                                    );
                                    await this.resolveMacroTextAsync(
                                        elseSql,
                                        elseState.environment,
                                        { replaceVariables: false, unresolved: state.unresolved },
                                        state.context,
                                    );
                                }
                                offset = skipDirectiveTrailingWhitespace(script, block.end);
                                atLineStart = isAtLineStart(script, offset);
                                allowChainedDirective = true;
                                continue;
                            }
                            const shouldRunThen = evaluateMacroCondition(condition);
                            pushScriptEvent(
                                state,
                                'branch',
                                `>>> %IF: ${shouldRunThen ? 'executed THEN branch' : 'skipped THEN branch'}`,
                                sourceName,
                                script,
                                offset,
                            );
                            const branchText = shouldRunThen
                                ? script.slice(block.thenStart, block.thenEnd)
                                : block.elseStart !== undefined && block.elseEnd !== undefined
                                    ? script.slice(block.elseStart, block.elseEnd)
                                    : '';
                            remaining += await this.processScriptBodyAsync(
                                branchText,
                                state,
                                sourceName,
                                blockDepth + 1,
                                includeStack,
                            );
                            offset = skipDirectiveTrailingWhitespace(script, block.end);
                            atLineStart = isAtLineStart(script, offset);
                            allowChainedDirective = true;
                            continue;
                        } else if (directive.kind === 'else') {
                            throw new Error('%ELSE without matching %IF');
                        } else {
                            throw new Error('%END without matching %IF');
                        }
                    } catch (error) {
                        throwMacroError(formatErrorMessage(error), sourceName, lineOfOffset(script, offset), state);
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

    private resolveExportDirectiveScan(
        payload: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
    ): void {
        const parsed = parseMacroExportPayload(payload);
        for (const value of [
            parsed.format,
            parsed.filePath,
            parsed.query,
            parsed.sheetName,
            parsed.overwrite,
        ]) {
            if (value !== undefined) {
                this.resolveMacroReferencesOutsideTrivia(
                    value,
                    environment,
                    { replaceVariables: false, unresolved },
                );
            }
        }
    }

    private async resolveExportDirectiveScanAsync(
        payload: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
        context: MacroPreprocessorContext,
    ): Promise<void> {
        const parsed = parseMacroExportPayload(payload);
        for (const value of [
            parsed.format,
            parsed.filePath,
            parsed.query,
            parsed.sheetName,
            parsed.overwrite,
        ]) {
            if (value !== undefined) {
                await this.resolveMacroTextAsync(
                    value,
                    environment,
                    { replaceVariables: false, unresolved },
                    context,
                );
            }
        }
    }

    private async resolveExportDirectiveAsync(
        payload: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
        context: MacroPreprocessorContext,
    ): Promise<MacroExportRequest> {
        const parsed = parseMacroExportPayload(payload);
        const filePath = unwrapResolvedScalarExportValue(
            await this.resolveRequiredExportValue(
                parsed.filePath,
                'file',
                environment,
                unresolved,
                context,
            ),
        );
        const query = await this.resolveRequiredExportValue(
            parsed.query,
            'query',
            environment,
            unresolved,
            context,
        );
        const sheetName = parsed.sheetName
            ? unwrapResolvedScalarExportValue(await this.resolveMacroTextAsync(
                parsed.sheetName,
                environment,
                { replaceVariables: true, unresolved },
                context,
            ))
            : 'Query Results';
        const formatText = parsed.format
            ? unwrapResolvedScalarExportValue(await this.resolveMacroTextAsync(
                parsed.format,
                environment,
                { replaceVariables: true, unresolved },
                context,
            ))
            : inferExportFormatFromPath(filePath);
        const overwriteText = parsed.overwrite
            ? unwrapResolvedScalarExportValue(await this.resolveMacroTextAsync(
                parsed.overwrite,
                environment,
                { replaceVariables: true, unresolved },
                context,
            ))
            : 'false';

        return {
            format: parseExportFormat(formatText),
            filePath,
            query,
            sheetName,
            overwrite: parseExportBoolean(overwriteText, 'overwrite'),
        };
    }

    private async resolveRequiredExportValue(
        value: string | undefined,
        label: string,
        environment: MacroEnvironment,
        unresolved: Set<string>,
        context: MacroPreprocessorContext,
    ): Promise<string> {
        if (value === undefined || value.trim().length === 0) {
            throw new Error(`%EXPORT requires ${label}=...`);
        }
        return await this.resolveMacroTextAsync(
            value,
            environment,
            { replaceVariables: true, unresolved },
            context,
        );
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
                const unresolvedQueryVariables =
                    collectMacroReferenceNamesOutsideTrivia(resolvedQuery);
                if (unresolvedQueryVariables.length > 0) {
                    throw new Error(
                        `%${queryFunction.kind.toUpperCase()} macro query has unresolved variables: ${unresolvedQueryVariables.join(', ')}`,
                    );
                }

                let queryResult: MacroQueryExecutionResult;
                try {
                    queryResult = await context.query(resolvedQuery);
                } catch (error) {
                    throw new Error(
                        `Failed to execute %${queryFunction.kind.toUpperCase()} macro query: ${formatErrorMessage(error)}`,
                        { cause: error },
                    );
                }
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
