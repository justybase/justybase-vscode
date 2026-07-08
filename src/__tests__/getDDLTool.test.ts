/**
 * Unit tests for GetDDLTool
 */

import * as vscode from 'vscode';
import { GetDDLTool, IGetDDLToolParameters } from '../services/copilotTools/getDDLTool';

// Mock vscode
jest.mock('vscode', () => ({
    MarkdownString: jest.fn().mockImplementation((text: string) => ({ text })),
    LanguageModelToolResult: jest.fn().mockImplementation((content: unknown[]) => ({ content })),
    LanguageModelTextPart: jest.fn().mockImplementation((text: string) => ({ text })),
    CancellationToken: jest.fn()
}));

// Mock CopilotService
const mockCopilotService = {
    getDDL: jest.fn()
};

describe('GetDDLTool', () => {
    let tool: GetDDLTool;

    beforeEach(() => {
        tool = new GetDDLTool(mockCopilotService as unknown as never);
        jest.clearAllMocks();
    });

    describe('prepareInvocation', () => {
        it('should prepare invocation with table name', async () => {
            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE',
                    objectType: 'table' as const
                }
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('TABLE DDL');
            expect(result.invocationMessage).toContain('DIMEMPLOYEE');
            expect(result.confirmationMessages?.title).toBe('Get TABLE DDL');
        });

        it('should prepare invocation with schema qualified name', async () => {
            const options = {
                input: {
                    objectName: 'ADMIN.DIMEMPLOYEE',
                    objectType: 'table' as const
                }
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('DIMEMPLOYEE');
        });

        it('should prepare invocation for view', async () => {
            const options = {
                input: {
                    objectName: 'MY_VIEW',
                    objectType: 'view' as const
                }
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('VIEW DDL');
        });

        it('should prepare invocation for procedure', async () => {
            const options = {
                input: {
                    objectName: 'MY_PROC',
                    objectType: 'procedure' as const
                }
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('PROCEDURE DDL');
        });

        it('should include database info when provided', async () => {
            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE',
                    objectType: 'table' as const,
                    database: 'MYDB'
                }
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('MYDB');
        });

        it('should default to table when objectType is missing in prepareInvocation', async () => {
            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE'
                } as unknown as IGetDDLToolParameters
            } as vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>;

            const result = await tool.prepareInvocation(options, {} as vscode.CancellationToken);

            expect(result.invocationMessage).toContain('TABLE DDL');
            expect(result.confirmationMessages?.title).toBe('Get TABLE DDL');
        });
    });

    describe('invoke', () => {
        it('should fetch DDL for table', async () => {
            const mockDDL = 'CREATE TABLE DIMEMPLOYEE (ID INT, NAME VARCHAR(100));';
            mockCopilotService.getDDL.mockResolvedValue(mockDDL);

            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE',
                    objectType: 'table' as const
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await tool.invoke(options, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'DIMEMPLOYEE',
                objectType: 'table',
                database: undefined,
                schema: undefined
            });
        });

        it('should fetch DDL for view', async () => {
            const mockDDL = 'CREATE VIEW MY_VIEW AS SELECT * FROM TABLE1;';
            mockCopilotService.getDDL.mockResolvedValue(mockDDL);

            const options = {
                input: {
                    objectName: 'MY_VIEW',
                    objectType: 'view' as const
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            const result = await tool.invoke(options, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'MY_VIEW',
                objectType: 'view',
                database: undefined,
                schema: undefined
            });
            expect(result).toBeDefined();
        });

        it('should fetch DDL for procedure', async () => {
            const mockDDL = 'CREATE PROCEDURE MY_PROC() RETURNS INT BEGIN RETURN 1; END;';
            mockCopilotService.getDDL.mockResolvedValue(mockDDL);

            const options = {
                input: {
                    objectName: 'MY_PROC',
                    objectType: 'procedure' as const
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await tool.invoke(options, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'MY_PROC',
                objectType: 'procedure',
                database: undefined,
                schema: undefined
            });
        });

        it('should fetch DDL for Db2 nickname and alias objects', async () => {
            mockCopilotService.getDDL.mockResolvedValue('CREATE NICKNAME DB2INST1.REMOTE_CUSTOMERS FOR SERVER1.REMOTE.CUSTOMERS;');

            await tool.invoke({
                input: {
                    objectName: 'REMOTE_CUSTOMERS',
                    objectType: 'nickname',
                    schema: 'DB2INST1'
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'REMOTE_CUSTOMERS',
                objectType: 'nickname',
                database: undefined,
                schema: 'DB2INST1'
            });

            await tool.invoke({
                input: {
                    objectName: 'EMP_ALIAS',
                    objectType: 'alias',
                    schema: 'DB2INST1'
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'EMP_ALIAS',
                objectType: 'alias',
                database: undefined,
                schema: 'DB2INST1'
            });
        });

        it('should throw error when object name is missing', async () => {
            const options = {
                input: {
                    objectName: '',
                    objectType: 'table' as const
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await expect(tool.invoke(options, {} as vscode.CancellationToken))
                .rejects.toThrow('Object name is required');
        });

        it('should throw error when object type is invalid', async () => {
            const options = {
                input: {
                    objectName: 'SOMETHING',
                    objectType: 'invalid' as unknown as 'table'
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await expect(tool.invoke(options, {} as vscode.CancellationToken))
                .rejects.toThrow('Object type must be one of');
        });

        it('should handle service errors', async () => {
            mockCopilotService.getDDL.mockRejectedValue(new Error('Connection failed'));

            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE',
                    objectType: 'table' as const
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await expect(tool.invoke(options, {} as vscode.CancellationToken))
                .rejects.toThrow('Failed to get DDL');
        });

        it('should pass database and schema parameters', async () => {
            const mockDDL = 'CREATE TABLE DIMEMPLOYEE (ID INT);';
            mockCopilotService.getDDL.mockResolvedValue(mockDDL);

            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE',
                    objectType: 'table' as const,
                    database: 'MYDB',
                    schema: 'ADMIN'
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await tool.invoke(options, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'DIMEMPLOYEE',
                objectType: 'table',
                database: 'MYDB',
                schema: 'ADMIN'
            });
        });

        it('should default object type to table when missing in invoke', async () => {
            const mockDDL = 'CREATE TABLE DIMEMPLOYEE (ID INT);';
            mockCopilotService.getDDL.mockResolvedValue(mockDDL);

            const options = {
                input: {
                    objectName: 'DIMEMPLOYEE'
                } as unknown as IGetDDLToolParameters
            } as vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>;

            await tool.invoke(options, {} as vscode.CancellationToken);

            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'DIMEMPLOYEE',
                objectType: 'table',
                database: undefined,
                schema: undefined
            });
        });
    });
});
