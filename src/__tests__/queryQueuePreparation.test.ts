import type * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import * as batch from '../core/queryBatchExecutor';
import { executionTargetFingerprint, prepareQueuedQuery } from '../commands/query/queryQueuePreparation';
import { VariableInputWebviewPanel } from '../views/variableInputWebviewPanel';

jest.mock('../views/variableInputWebviewPanel', () => ({ VariableInputWebviewPanel: { show: jest.fn() } }));

const sourceUri = 'file:///workspace/query.sql';
const profile = { name: 'A', database: 'DB', host: 'server', user: 'user' };
const context = { globalState: { get: () => ({}), update: jest.fn() } } as unknown as vscode.ExtensionContext;

function manager() {
    return {
        getConnectionForExecution: jest.fn(() => 'A'),
        getActiveConnectionName: jest.fn(() => 'A'),
        getDocumentDatabase: jest.fn((): string | undefined => undefined),
        getConnection: jest.fn(async () => profile),
    };
}

describe('queue input snapshots', () => {
    afterEach(() => jest.restoreAllMocks());

    it('prompts at submission and captures values plus include contents for later expansion', async () => {
        const show = VariableInputWebviewPanel.show as jest.Mock;
        show.mockResolvedValue({ ID: '42' });
        let include = 'SELECT &id;';
        const readFile = jest.fn(async () => ({ path: '/workspace/include.sql', content: include }));
        jest.spyOn(batch, 'createMacroFileReadContext').mockReturnValue({ sourceName: '/workspace/query.sql', readFile });
        const owner = manager();
        const prepared = await prepareQueuedQuery(["%INCLUDE 'include.sql';"], context, sourceUri,
            owner as unknown as ConnectionManager, 'A', undefined, executionTargetFingerprint(profile));
        expect(show).toHaveBeenCalledTimes(1);
        expect(prepared.preparedVariables).toEqual({ ID: '42' });
        include = 'DELETE FROM CUSTOMER;';
        const expanded = await batch.prepareQueryForExecutionWithMetadata("%INCLUDE 'include.sql';",
            { ...prepared.preparedVariables }, undefined, undefined, prepared.macroFileContext);
        expect(expanded.sql.trim()).toBe('SELECT 42;');
        expect(show).toHaveBeenCalledTimes(1);
        expect(readFile).toHaveBeenCalledTimes(1);
        await expect(prepared.macroFileContext!.readFile!('uncaptured.sql')).rejects.toThrow('not captured');
    });

    it('rejects changed profiles, document connections and database overrides before execution', async () => {
        const owner = manager();
        const prepared = await prepareQueuedQuery(['SELECT 1'], context, sourceUri,
            owner as unknown as ConnectionManager, 'A', undefined, executionTargetFingerprint(profile));
        await expect(prepared.validateExecutionTarget!()).resolves.toBeUndefined();
        owner.getDocumentDatabase.mockReturnValue('OTHERDB');
        await expect(prepared.validateExecutionTarget!()).rejects.toThrow('target changed');
        owner.getDocumentDatabase.mockReturnValue(undefined);
        owner.getConnectionForExecution.mockReturnValue('B');
        await expect(prepared.validateExecutionTarget!()).rejects.toThrow('target changed');
        owner.getConnectionForExecution.mockReturnValue('A');
        owner.getConnection.mockResolvedValue({ ...profile, host: 'different-server' });
        await expect(prepared.validateExecutionTarget!()).rejects.toThrow('target changed');
    });

    it('does not execute session-dependent macros while collecting interactive inputs', async () => {
        const owner = manager();
        const prepared = await prepareQueuedQuery(['%LET x = %SQL(SELECT COUNT(*) FROM CUSTOMER); SELECT &x;'],
            context, sourceUri, owner as unknown as ConnectionManager, 'A', undefined, executionTargetFingerprint(profile));
        expect(prepared.preparedVariables).toBeDefined();
        const query = jest.fn(async () => ({ rows: [[12]] }));
        const result = await batch.prepareQueryForExecutionWithMetadata('%LET x = %SQL(SELECT COUNT(*) FROM CUSTOMER); SELECT &x;',
            { ...prepared.preparedVariables }, undefined, query, prepared.macroFileContext);
        expect(query).toHaveBeenCalledTimes(1);
        expect(result.sql.trim()).toBe('SELECT 12;');
    });
});
