import * as vscode from 'vscode';
import {
    ITuningAdviceToolParameters,
    TuningAdviceTool
} from '../services/copilotTools/tuningAdviceTool';
import { CopilotService } from '../services/copilotService';

jest.mock('vscode', () => ({
    MarkdownString: jest.fn().mockImplementation((text: string) => ({ value: text })),
    LanguageModelTextPart: jest.fn().mockImplementation((text: string) => ({ text })),
    LanguageModelToolResult: jest.fn().mockImplementation((parts: unknown[]) => ({ parts }))
}));

describe('services/copilotTools/tuningAdviceTool', () => {
    let mockCopilotService: jest.Mocked<CopilotService>;
    let tool: TuningAdviceTool;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCopilotService = {
            getTuningAdvice: jest.fn()
        } as unknown as jest.Mocked<CopilotService>;

        tool = new TuningAdviceTool(mockCopilotService);
    });

    it('prepares invocation with sql preview and database info', async () => {
        const options = {
            input: {
                sql: 'SELECT * FROM DB1.ADMIN.FACT_SALES',
                database: 'DB1'
            }
        } as vscode.LanguageModelToolInvocationPrepareOptions<ITuningAdviceToolParameters>;

        const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

        expect(result.invocationMessage).toContain('Generating SQL tuning advice');
        expect(result.confirmationMessages?.title).toBe('Get Tuning Advice');
        expect(vscode.MarkdownString).toHaveBeenCalled();
    });

    it('invokes copilotService.getTuningAdvice and returns tool result', async () => {
        mockCopilotService.getTuningAdvice.mockResolvedValue('summary:\nDetected 1 recommendation(s).');

        const options = {
            input: {
                sql: 'SELECT * FROM SALES',
                database: 'DB1'
            }
        } as vscode.LanguageModelToolInvocationOptions<ITuningAdviceToolParameters>;

        const result = await tool.invoke(options, {} as vscode.CancellationToken);

        expect(mockCopilotService.getTuningAdvice).toHaveBeenCalledWith('SELECT * FROM SALES', 'DB1', true, 5);
        expect(vscode.LanguageModelTextPart).toHaveBeenCalledWith('summary:\nDetected 1 recommendation(s).');
        expect(result).toBeDefined();
    });

    it('handles invoke errors', async () => {
        mockCopilotService.getTuningAdvice.mockRejectedValue(new Error('No active connection'));

        const options = {
            input: {
                sql: 'SELECT 1'
            }
        } as vscode.LanguageModelToolInvocationOptions<ITuningAdviceToolParameters>;

        await expect(tool.invoke(options, {} as vscode.CancellationToken)).rejects.toThrow(
            'Failed to get tuning advice: No active connection'
        );
    });
});
