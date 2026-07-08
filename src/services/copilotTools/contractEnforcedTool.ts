import * as vscode from 'vscode';
import { getToolContract } from '../../contracts/copilotTools/contracts';
import type { ToolContract, ValidationError, ValidationResult } from '../../contracts/copilotTools/types';
import { getLogger } from '../../utils/logger';

interface OutputValidationResult {
    success: boolean;
    message?: string;
}

function toValidationMessage(toolName: string, error: ValidationError): string {
    if (error.code === 'REQUIRED') {
        return `Missing required parameter '${error.field}' in tool '${toolName}'.`;
    }

    if (error.code === 'INVALID_TYPE' || error.code === 'INVALID_ARRAY_TYPE') {
        return `Invalid type for parameter '${error.field}' in tool '${toolName}'. ${error.message}`;
    }

    if (error.code === 'EMPTY_STRING' || error.code === 'EMPTY_ARRAY') {
        return `Invalid value for parameter '${error.field}' in tool '${toolName}'. ${error.message}`;
    }

    return `Invalid parameter '${error.field}' in tool '${toolName}'. ${error.message}`;
}

function toValidationSummary(toolName: string, errors: ValidationError[]): string {
    const normalizedErrors = errors.map(error => `- ${toValidationMessage(toolName, error)}`);
    return [
        `Tool input validation failed for '${toolName}'.`,
        ...normalizedErrors
    ].join('\n');
}

function toExecutionSummary(toolName: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `Tool execution failed for '${toolName}'. ${message}`;
}

function createTextResult(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}

function isTextPart(part: unknown): part is vscode.LanguageModelTextPart {
    if (part instanceof vscode.LanguageModelTextPart) {
        return true;
    }

    if (typeof part !== 'object' || part === null) {
        return false;
    }

    const candidate = part as { value?: unknown };
    return typeof candidate.value === 'string';
}

class ContractEnforcedTool<TInput extends object> implements vscode.LanguageModelTool<TInput> {
    private readonly _contract: ToolContract<unknown, unknown> | undefined;

    constructor(
        private readonly _toolName: string,
        private readonly _innerTool: vscode.LanguageModelTool<TInput>
    ) {
        this._contract = getToolContract(_toolName);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<TInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const inputValidation = this.validateInput(options.input);
        if (!inputValidation.success) {
            this.logTelemetry('warn', 'copilot_tool_input_validation_failed_prepare', {
                errorCount: inputValidation.errors.length,
                errors: inputValidation.errors
            });
            return {
                invocationMessage: `Input validation failed for ${this._toolName}.`,
                confirmationMessages: {
                    title: 'Invalid tool parameters',
                    message: new vscode.MarkdownString(toValidationSummary(this._toolName, inputValidation.errors))
                }
            };
        }

        const validatedOptions = {
            ...options,
            input: inputValidation.data as TInput
        } as vscode.LanguageModelToolInvocationPrepareOptions<TInput>;
        if (!this._innerTool.prepareInvocation) {
            return { invocationMessage: `Preparing ${this._toolName}...` };
        }

        const preparedInvocation = await this._innerTool.prepareInvocation(validatedOptions, token);
        return preparedInvocation ?? { invocationMessage: `Preparing ${this._toolName}...` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const startedAt = Date.now();
        const inputValidation = this.validateInput(options.input);
        if (!inputValidation.success) {
            const message = toValidationSummary(this._toolName, inputValidation.errors);
            this.logTelemetry('warn', 'copilot_tool_input_validation_failed_invoke', {
                durationMs: Date.now() - startedAt,
                errorCount: inputValidation.errors.length,
                errors: inputValidation.errors
            });
            return createTextResult(message);
        }

        try {
            if (!this._innerTool.invoke) {
                const missingInvokeMessage = `Tool execution failed for '${this._toolName}'. Tool invoke handler is not available.`;
                this.logTelemetry('error', 'copilot_tool_invoke_missing_handler', {
                    durationMs: Date.now() - startedAt
                });
                return createTextResult(missingInvokeMessage);
            }

            const validatedOptions = {
                ...options,
                input: inputValidation.data as TInput
            } as vscode.LanguageModelToolInvocationOptions<TInput>;
            const result = await this._innerTool.invoke(validatedOptions, token);
            if (!result) {
                const missingOutputMessage = `Invalid output contract in tool '${this._toolName}'. Tool returned no result payload.`;
                this.logTelemetry('warn', 'copilot_tool_output_missing', {
                    durationMs: Date.now() - startedAt
                });
                return createTextResult(missingOutputMessage);
            }

            const outputValidation = this.validateOutput(result);
            if (!outputValidation.success) {
                const outputMessage = outputValidation.message ?? `Invalid output contract in tool '${this._toolName}'.`;
                this.logTelemetry('warn', 'copilot_tool_output_validation_failed', {
                    durationMs: Date.now() - startedAt,
                    message: outputMessage
                });
                return createTextResult(outputMessage);
            }

            this.logTelemetry('info', 'copilot_tool_invoke_succeeded', {
                durationMs: Date.now() - startedAt
            });
            return result;
        } catch (error) {
            const message = toExecutionSummary(this._toolName, error);
            this.logTelemetry('error', 'copilot_tool_invoke_failed', {
                durationMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error)
            });
            return createTextResult(message);
        }
    }

    private validateInput(input: unknown): ValidationResult<unknown> {
        const normalizedInput = input ?? {};
        if (!this._contract) {
            return { success: true, data: normalizedInput };
        }

        return this._contract.validateInput(normalizedInput);
    }

    private validateOutput(result: vscode.LanguageModelToolResult): OutputValidationResult {
        const content = (result as unknown as { content?: unknown }).content;
        if (!Array.isArray(content) || content.length === 0) {
            return {
                success: false,
                message: `Invalid output contract in tool '${this._toolName}'. Expected non-empty text response.`
            };
        }

        const textValues = content.filter(part => isTextPart(part)).map(part => part.value);
        if (textValues.length === 0) {
            return {
                success: false,
                message: `Invalid output contract in tool '${this._toolName}'. Expected at least one text part.`
            };
        }

        if (!this._contract) {
            return { success: true };
        }

        const normalizedOutput = {
            summary: `Tool ${this._toolName} executed successfully.`,
            data: textValues.join('\n'),
            errors: []
        };
        const outputContractValidation = this._contract.validateOutput(normalizedOutput);
        if (!outputContractValidation.success) {
            return {
                success: false,
                message: `Invalid output contract in tool '${this._toolName}'. ${outputContractValidation.errors
                    .map(error => error.message)
                    .join(' ')}`
            };
        }

        return { success: true };
    }

    private logTelemetry(level: 'info' | 'warn' | 'error', event: string, payload: Record<string, unknown>): void {
        try {
            const logger = getLogger();
            const telemetryPayload = {
                event,
                toolName: this._toolName,
                ...payload
            };

            if (level === 'error') {
                logger.error('[CopilotToolTelemetry]', telemetryPayload);
            } else if (level === 'warn') {
                logger.warn('[CopilotToolTelemetry]', telemetryPayload);
            } else {
                logger.info('[CopilotToolTelemetry]', telemetryPayload);
            }
        } catch {
            // Logger is not initialized in some tests, so telemetry logging is best-effort.
        }
    }
}

export function withContractEnforcement<TInput extends object>(
    toolName: string,
    tool: vscode.LanguageModelTool<TInput>
): vscode.LanguageModelTool<TInput> {
    return new ContractEnforcedTool(toolName, tool);
}
