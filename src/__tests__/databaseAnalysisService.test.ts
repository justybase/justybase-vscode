jest.unmock('chevrotain');
jest.mock('../services/analysis/analysisSession');
import * as vscode from 'vscode';
import { DatabaseAnalysisService } from '../services/analysis/databaseAnalysisService';
import { AnalysisSession } from '../services/analysis/analysisSession';
import type { MetadataCache } from '../metadataCache';
import type { ConnectionManager } from '../core/connectionManager';
import type { ObjectReference } from '../services/analysis/sqlAnalysis';
import type { DefinitionCatalogSnapshot } from '../metadata/definitionCatalog';
const context = {} as vscode.ExtensionContext;
const root: ObjectReference = { database:'DB',schema:'PUBLIC',name:'CUSTOMER',type:'TABLE' };
function setup() {
    const invalidation = new vscode.EventEmitter<string | undefined>();
    const external = new vscode.EventEmitter<string>();
    const refresh = new vscode.EventEmitter<{completedAt?:number;connectionName:string}>();
    const catalogs = new Map<string,DefinitionCatalogSnapshot>();
    const cache = { onDidInvalidate:invalidation.event,onDidExternalRefresh:external.event,onDidPrefetchRefreshDetails:refresh.event,
        getDefinitionCatalog:jest.fn((connection:string)=>catalogs.get(connection)),setDefinitionCatalog:jest.fn((connection:string,_db:string,value:DefinitionCatalogSnapshot)=>catalogs.set(connection,value)),
        clearDefinitionCatalogs:jest.fn((connection?:string)=> { if(connection){catalogs.delete(connection);}else{catalogs.clear();} }),
        setForeignKeyRelationshipsForDatabase:jest.fn(),getForeignKeyRelationshipsForDatabase:jest.fn(()=>({complete:true,references:[]})),getColumns:jest.fn(()=>undefined),getColumnsAnySchema:jest.fn(()=>undefined),setColumns:jest.fn() };
    const session = { open:jest.fn(async()=>undefined),close:jest.fn(async()=>undefined),database:'DB',connectionName:'NZ',
        rows:jest.fn(async(query:string): Promise<Record<string,unknown>[]>=>query.includes("'EXTERNAL TABLE' AS OBJTYPE")?[{OBJNAME:'EXT',SCHEMA:'PUBLIC',OBJTYPE:'EXTERNAL TABLE'}]:query.includes('PROCEDURESOURCE')?[]:query.includes('DEFINITION')?[{SCHEMA:'PUBLIC',VIEWNAME:'V',DEFINITION:'SELECT C.EMAIL FROM CUSTOMER C'}]:[{OBJNAME:'CUSTOMER',SCHEMA:'PUBLIC',OBJTYPE:'TABLE'}]),
        explain:jest.fn(async()=> 'Sequential Scan table "CUSTOMER" (cost=0.0..20.0 rows=2000000.0 width=32.0 conf=0.0)') };
    (AnalysisSession as jest.MockedClass<typeof AnalysisSession>).mockImplementation(()=>session as unknown as AnalysisSession);
    const service=new DatabaseAnalysisService(context,{} as ConnectionManager,cache as unknown as MetadataCache);
    return {service,cache,session,invalidation,external,refresh,catalogs};
}
describe('database analysis lifecycle',()=>{
    beforeEach(()=>jest.clearAllMocks());
    test('bulk catalog cache, reverse column references and refresh invalidation',async()=>{
        const {service,session,cache,invalidation,external,refresh}=setup();
        const token=new vscode.CancellationTokenSource();
        expect((await service.dependencies('NZ',root,'incoming',2,token.token,'EMAIL')).affected.map(a=>a.object.name)).toEqual(['V']);
        expect(session.rows).toHaveBeenCalledTimes(4);
        await service.dependencies('NZ',root,'incoming',2,token.token);
        expect(session.rows).toHaveBeenCalledTimes(4);
        invalidation.fire('NZ');await service.dependencies('NZ',root,'incoming',2,token.token);
        expect(session.rows).toHaveBeenCalledTimes(8);
        external.fire('NZ');refresh.fire({completedAt:1,connectionName:'NZ'});
        expect(cache.clearDefinitionCatalogs).toHaveBeenCalled();
        service.dispose();expect(session.close).toHaveBeenCalledTimes(2);
    });
    test('one catalog failure preserves other definitions',async()=>{
        const {service,session}=setup();const original=session.rows.getMockImplementation()!;
        session.rows.mockImplementation(async q=>{if(q.includes('PROCEDURESOURCE')){throw new Error('denied');}return original(q);});
        const report=await service.dependencies('NZ',root,'incoming',2,new vscode.CancellationTokenSource().token);
        expect(report.affected).toHaveLength(1);expect(report.issues.join(' ')).toContain('denied');
        service.dispose();
    });
    test('metadata invalidation during load prevents stale publication',async()=>{
        const {service,session,cache,invalidation}=setup();
        session.rows.mockImplementation(async()=>{invalidation.fire('NZ');return [];});
        await expect(service.dependencies('NZ',root,'incoming',2,new vscode.CancellationTokenSource().token)).rejects.toBeInstanceOf(vscode.CancellationError);
        expect(cache.setDefinitionCatalog).not.toHaveBeenCalled();service.dispose();
    });
    test('disposal cancels in-flight analysis and closes connection',async()=>{
        const {service,session}=setup();
        let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        session.rows.mockImplementation(async()=>{entered();await wait;return [];});
        const request=service.dependencies('NZ',root,'incoming',2,new vscode.CancellationTokenSource().token);
        await started;service.dispose();release();
        await expect(request).rejects.toBeInstanceOf(vscode.CancellationError);expect(session.close).toHaveBeenCalledTimes(1);
    });
    test('EXPLAIN failure preserves static findings without table scans',async()=>{
        const {service,session}=setup();session.explain.mockRejectedValue(new Error('EXPLAIN denied'));
        const report=await service.performance('NZ','SELECT * FROM A CROSS JOIN B',root,new vscode.CancellationTokenSource().token);
        expect(report.recommendations.map(r=>r.id)).toContain('NZPERF007');expect(report.issues.join(' ')).toContain('EXPLAIN denied');
        expect(session.rows.mock.calls.some(([q])=>q.includes('COUNT(*)'))).toBe(false);
        service.dispose();
    });
    test('optional skew scan is explicit and bounded to referenced tables',async()=>{
        const {service,session}=setup();const original=session.rows.getMockImplementation()!;
        session.rows.mockImplementation(async q=>q.includes('COUNT(*)')?[{DATASLICEID:1,ROW_COUNT:100},{DATASLICEID:2,ROW_COUNT:0}]:original(q));
        const report=await service.performance('NZ','SELECT * FROM CUSTOMER',root,new vscode.CancellationTokenSource().token,true);
        expect(report.recommendations.map(r=>r.id)).toContain('NZPERF002');
        expect(session.rows.mock.calls.filter(([q])=>q.includes('COUNT(*)'))).toHaveLength(1);service.dispose();
    });

    test('loads missing table constraints in one bulk query through the existing cache',async()=>{
        const {service,session,cache}=setup();
        cache.getForeignKeyRelationshipsForDatabase.mockReturnValue({complete:false,references:[]});
        const original=session.rows.getMockImplementation()!;
        session.rows.mockImplementation(async query=>query.includes('FROM_DATABASE') ? [{FROM_DATABASE:'DB',FROM_SCHEMA:'PUBLIC',FROM_TABLE:'ORDERS',FROM_COLUMN:'CUSTOMER_ID',TO_DATABASE:'DB',TO_SCHEMA:'PUBLIC',TO_TABLE:'CUSTOMER',TO_COLUMN:'ID',CONSTRAINT_NAME:'FK_CUSTOMER',ORDINAL_POSITION:1}] : original(query));
        await service.dependencies('NZ',root,'incoming',2,new vscode.CancellationTokenSource().token);
        expect(session.rows.mock.calls.filter(([query])=>query.includes('FROM_DATABASE'))).toHaveLength(1);
        expect(cache.setForeignKeyRelationshipsForDatabase).toHaveBeenCalledWith('NZ','DB',expect.arrayContaining([expect.objectContaining({fromTable:'ORDERS',toTable:'CUSTOMER',toColumn:'ID'})]),true);
        service.dispose();
    });
});
