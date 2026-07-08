import * as vscode from 'vscode';
import { NodeConfigurator } from '../views/etl/nodeConfigurator';
import { EtlNode } from '../etl/etlTypes';

jest.mock('vscode', () => ({
    window: {
        showInputBox: jest.fn(),
        showQuickPick: jest.fn(),
        showOpenDialog: jest.fn(),
        showSaveDialog: jest.fn()
    }
}));

describe('views/etl/nodeConfigurator', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let projectManager: any;
    let onUpdate: jest.Mock;
    let configurator: NodeConfigurator;

    beforeEach(() => {
        jest.clearAllMocks();
        projectManager = {
            getNode: jest.fn(),
            updateNode: jest.fn()
        };
        onUpdate = jest.fn();
        configurator = new NodeConfigurator(projectManager, onUpdate);
    });

    it('should return without updates when node does not exist', async () => {
        projectManager.getNode.mockReturnValue(undefined);
        await configurator.configureNode('missing');
        expect(projectManager.updateNode).not.toHaveBeenCalled();
    });

    it('should configure SQL node', async () => {
        const node: EtlNode = {
            id: 'n1',
            type: 'sql',
            name: 'SQL',
            position: { x: 0, y: 0 },
            config: { type: 'sql', query: 'SELECT 1', timeout: 10 }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Task SQL')
            .mockResolvedValueOnce('SELECT * FROM T')
            .mockResolvedValueOnce('120');

        await configurator.configureNode('n1');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n1',
            expect.objectContaining({
                name: 'Task SQL',
                config: expect.objectContaining({ query: 'SELECT * FROM T', timeout: 120 })
            })
        );
        expect(onUpdate).toHaveBeenCalled();
    });

    it('should configure Python node (inline script)', async () => {
        const node: EtlNode = {
            id: 'n2',
            type: 'python',
            name: 'Py',
            position: { x: 0, y: 0 },
            config: { type: 'python', script: 'print(1)', timeout: 5 }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Task Py')
            .mockResolvedValueOnce('print("ok")')
            .mockResolvedValueOnce('30');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('Enter script inline');

        await configurator.configureNode('n2');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n2',
            expect.objectContaining({
                config: expect.objectContaining({ script: 'print("ok")', scriptPath: undefined, timeout: 30 })
            })
        );
    });

    it('should configure Python node (script file)', async () => {
        const node: EtlNode = {
            id: 'n3',
            type: 'python',
            name: 'Py file',
            position: { x: 0, y: 0 },
            config: { type: 'python', script: '' }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('Task Py File').mockResolvedValueOnce('60');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('Select script file');
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: 'D:\\scripts\\etl.py' }]);

        await configurator.configureNode('n3');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n3',
            expect.objectContaining({
                config: expect.objectContaining({ scriptPath: 'D:\\scripts\\etl.py', script: '', timeout: 60 })
            })
        );
    });

    it('should configure Export node', async () => {
        const node: EtlNode = {
            id: 'n4',
            type: 'export',
            name: 'Export',
            position: { x: 0, y: 0 },
            config: { type: 'export', format: 'csv', outputPath: '' }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Export Task')
            .mockResolvedValueOnce('SELECT * FROM SALES')
            .mockResolvedValueOnce('300');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('csv');
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: 'D:\\out\\sales.csv' });

        await configurator.configureNode('n4');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n4',
            expect.objectContaining({
                config: expect.objectContaining({
                    format: 'csv',
                    outputPath: 'D:\\out\\sales.csv',
                    query: 'SELECT * FROM SALES',
                    timeout: 300
                })
            })
        );
    });

    it('should configure Import node', async () => {
        const node: EtlNode = {
            id: 'n5',
            type: 'import',
            name: 'Import',
            position: { x: 0, y: 0 },
            config: { type: 'import', format: 'csv', inputPath: '', targetTable: 'A.B' }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Import Task')
            .mockResolvedValueOnce('SCH.TBL')
            .mockResolvedValueOnce('200');
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: 'D:\\in\\source.xlsb' }]);

        await configurator.configureNode('n5');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n5',
            expect.objectContaining({
                config: expect.objectContaining({
                    format: 'xlsb',
                    inputPath: 'D:\\in\\source.xlsb',
                    targetTable: 'SCH.TBL',
                    timeout: 200
                })
            })
        );
    });

    it('should configure Variable node with prompt source', async () => {
        const node: EtlNode = {
            id: 'n6',
            type: 'variable',
            name: 'Var',
            position: { x: 0, y: 0 },
            config: { type: 'variable', variableName: 'v', source: 'prompt', promptMessage: 'm' }
        };
        projectManager.getNode.mockReturnValue(node);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Variable Task')
            .mockResolvedValueOnce('date_var')
            .mockResolvedValueOnce('Enter date')
            .mockResolvedValueOnce('2024-01-01');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ value: 'prompt' });

        await configurator.configureNode('n6');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n6',
            expect.objectContaining({
                config: expect.objectContaining({
                    variableName: 'date_var',
                    source: 'prompt',
                    promptMessage: 'Enter date',
                    defaultValue: '2024-01-01'
                })
            })
        );
    });

    it('should configure Variable node with static and sql source', async () => {
        const staticNode: EtlNode = {
            id: 'n7',
            type: 'variable',
            name: 'Var static',
            position: { x: 0, y: 0 },
            config: { type: 'variable', variableName: 'v', source: 'static', value: 'x' }
        };
        projectManager.getNode.mockReturnValueOnce(staticNode);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('Static Task')
            .mockResolvedValueOnce('status')
            .mockResolvedValueOnce('ACTIVE');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'static' });

        await configurator.configureNode('n7');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n7',
            expect.objectContaining({
                config: expect.objectContaining({ source: 'static', value: 'ACTIVE' })
            })
        );

        const sqlNode: EtlNode = {
            id: 'n8',
            type: 'variable',
            name: 'Var sql',
            position: { x: 0, y: 0 },
            config: { type: 'variable', variableName: 'v', source: 'sql', query: 'SELECT 1' }
        };
        projectManager.getNode.mockReturnValueOnce(sqlNode);
        (vscode.window.showInputBox as jest.Mock)
            .mockResolvedValueOnce('SQL Task')
            .mockResolvedValueOnce('max_date')
            .mockResolvedValueOnce('SELECT MAX(d) FROM t')
            .mockResolvedValueOnce('40');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ value: 'sql' });

        await configurator.configureNode('n8');
        expect(projectManager.updateNode).toHaveBeenCalledWith(
            'n8',
            expect.objectContaining({
                config: expect.objectContaining({ source: 'sql', query: 'SELECT MAX(d) FROM t', timeout: 40 })
            })
        );
    });

    it('should return default node names', () => {
        expect(configurator.getDefaultNodeName('sql')).toBe('SQL Task');
        expect(configurator.getDefaultNodeName('python')).toBe('Python Script');
        expect(configurator.getDefaultNodeName('container')).toBe('Container');
        expect(configurator.getDefaultNodeName('export')).toBe('Export Data');
        expect(configurator.getDefaultNodeName('import')).toBe('Import Data');
        expect(configurator.getDefaultNodeName('variable')).toBe('Variable');
    });
});

