jest.unmock('chevrotain');
jest.mock('../core/connectionFactory',()=>({createConnectedDatabaseConnectionFromDetails:jest.fn()}));
jest.mock('../core/queryRunner',()=>({runQueryRaw:jest.fn(),queryResultToRows:jest.fn((r:unknown)=>r),runExplainQuery:jest.fn()}));
jest.mock('../core/queryCancellation',()=>({streamingManager:{abortQuery:jest.fn(),clearAborted:jest.fn()}}));
import * as vscode from 'vscode';
import { AnalysisSession } from '../services/analysis/analysisSession';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { runQueryRaw,runExplainQuery } from '../core/queryRunner';
import { streamingManager } from '../core/queryCancellation';
import type { ConnectionManager } from '../core/connectionManager';
function setup() {
    const source=new vscode.CancellationTokenSource();const close=jest.fn(async()=>undefined);
    (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue({close});
    (runQueryRaw as jest.Mock).mockResolvedValue([{VALUE:1}]);(runExplainQuery as jest.Mock).mockResolvedValue('plan');
    const manager={getConnection:jest.fn(async()=>({host:'local',user:'test',database:'DEFAULT'})),getConnectionDatabaseKind:()=> 'netezza'} as unknown as ConnectionManager;
    return{session:new AnalysisSession({} as vscode.ExtensionContext,manager,'NZ','TARGET',source.token),source,close,manager};
}
describe('isolated analysis runtime adapter',()=>{
    beforeEach(()=>jest.clearAllMocks());
    test('uses factory, caller-owned execution and existing planner-only gate',async()=>{
        const {session,close}=setup();await session.open();
        expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalledWith(expect.anything(),'TARGET');
        expect(await session.rows('SELECT * FROM _V_VIEW')).toEqual([{VALUE:1}]);
        expect(runQueryRaw).toHaveBeenCalledWith(expect.objectContaining({isUserQuery:false,connectionOverride:{close},maxRows:20001,isExecutionCurrent:expect.any(Function)}));
        expect(await session.explain('SELECT * FROM CUSTOMER')).toBe('plan');
        expect(runExplainQuery).toHaveBeenCalledWith(expect.anything(),'EXPLAIN VERBOSE SELECT * FROM CUSTOMER','NZ',expect.anything(),expect.stringMatching(/^justybase-analysis:/),{close});
        await expect(session.explain('SELECT 1; DELETE FROM CUSTOMER')).rejects.toThrow(/exactly one/);
        expect(runExplainQuery).toHaveBeenCalledTimes(1);await session.close();expect(close).toHaveBeenCalledTimes(1);
    });
    test('cancellation stops future commands and retires isolated source',async()=>{
        const {session,source,close}=setup();await session.open();source.cancel();
        expect(streamingManager.abortQuery).toHaveBeenCalledTimes(1);
        await expect(session.rows('SELECT 1')).rejects.toBeInstanceOf(vscode.CancellationError);
        expect(runQueryRaw).not.toHaveBeenCalled();await session.close();expect(close).toHaveBeenCalledTimes(1);expect(streamingManager.clearAborted).toHaveBeenCalledTimes(1);
    });
    test('already cancelled/open failure performs no database work',async()=>{
        const {session,source}=setup();source.cancel();await expect(session.open()).rejects.toBeInstanceOf(vscode.CancellationError);expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();await session.close();
    });
});
