import * as vscode from 'vscode';
import { withContractEnforcement } from '../services/copilotTools/contractEnforcedTool';

interface ColumnsInput {
    tables?: string[];
}

function getResultText(result: vscode.LanguageModelToolResult | null | undefined): string {
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    const nonNullResult = result as vscode.LanguageModelToolResult;
    return (nonNullResult.content[0] as vscode.LanguageModelTextPart).value;
}

describe('contractEnforcedTool', () => {
    const token = {} as vscode.CancellationToken;

    it('returns standardized missing-parameter error and skips inner invoke', async () => {
        const innerTool: vscode.LanguageModelTool<ColumnsInput> = {
            prepareInvocation: jest.fn().mockResolvedValue({ invocationMessage: 'ok' }),
            invoke: jest.fn().mockResolvedValue(
                new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('should-not-run')])
            )
        };
        const tool = withContractEnforcement('netezza_get_columns', innerTool);
        expect(tool.invoke).toBeDefined();

        const result = await tool.invoke!(
            { input: {} } as unknown as vscode.LanguageModelToolInvocationOptions<ColumnsInput>,
            token
        );
        const text = getResultText(result);

        expect(text).toContain("Missing required parameter 'tables' in tool 'netezza_get_columns'.");
        expect(innerTool.invoke).not.toHaveBeenCalled();
    });

    it('passes through valid input and returns inner result', async () => {
        const innerTool: vscode.LanguageModelTool<ColumnsInput> = {
            prepareInvocation: jest.fn().mockResolvedValue({ invocationMessage: 'ok' }),
            invoke: jest
                .fn()
                .mockResolvedValue(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('query result')]))
        };
        const tool = withContractEnforcement('netezza_get_columns', innerTool);
        expect(tool.invoke).toBeDefined();

        const result = await tool.invoke!(
            { input: { tables: ['ADMIN.T'] } } as unknown as vscode.LanguageModelToolInvocationOptions<ColumnsInput>,
            token
        );
        const text = getResultText(result);

        expect(innerTool.invoke).toHaveBeenCalledTimes(1);
        expect(text).toBe('query result');
    });

    it('normalizes thrown invoke errors to string tool results', async () => {
        const innerTool: vscode.LanguageModelTool<ColumnsInput> = {
            prepareInvocation: jest.fn().mockResolvedValue({ invocationMessage: 'ok' }),
            invoke: jest.fn().mockRejectedValue(new Error('boom'))
        };
        const tool = withContractEnforcement('netezza_get_columns', innerTool);
        expect(tool.invoke).toBeDefined();

        const result = await tool.invoke!(
            { input: { tables: ['ADMIN.T'] } } as unknown as vscode.LanguageModelToolInvocationOptions<ColumnsInput>,
            token
        );
        const text = getResultText(result);

        expect(text).toContain("Tool execution failed for 'netezza_get_columns'. boom");
    });

    it('returns standardized output-contract error for empty tool result content', async () => {
        const innerTool: vscode.LanguageModelTool<ColumnsInput> = {
            prepareInvocation: jest.fn().mockResolvedValue({ invocationMessage: 'ok' }),
            invoke: jest.fn().mockResolvedValue(new vscode.LanguageModelToolResult([]))
        };
        const tool = withContractEnforcement('netezza_get_columns', innerTool);
        expect(tool.invoke).toBeDefined();

        const result = await tool.invoke!(
            { input: { tables: ['ADMIN.T'] } } as unknown as vscode.LanguageModelToolInvocationOptions<ColumnsInput>,
            token
        );
        const text = getResultText(result);

        expect(text).toContain("Invalid output contract in tool 'netezza_get_columns'.");
    });

    it('returns validation details in prepareInvocation for invalid input', async () => {
        const innerTool: vscode.LanguageModelTool<ColumnsInput> = {
            prepareInvocation: jest.fn().mockResolvedValue({ invocationMessage: 'ok' }),
            invoke: jest.fn().mockResolvedValue(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('ok')]))
        };
        const tool = withContractEnforcement('netezza_get_columns', innerTool);
        expect(tool.prepareInvocation).toBeDefined();

        const prepared = await tool.prepareInvocation!(
            { input: {} } as unknown as vscode.LanguageModelToolInvocationPrepareOptions<ColumnsInput>,
            token
        );
        expect(prepared).toBeDefined();
        expect(prepared).not.toBeNull();

        const nonNullPrepared = prepared as vscode.PreparedToolInvocation;
        expect(nonNullPrepared.invocationMessage).toContain('Input validation failed');
        expect(innerTool.prepareInvocation).not.toHaveBeenCalled();
    });
});
