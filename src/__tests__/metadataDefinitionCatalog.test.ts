import * as vscode from 'vscode';
import { MetadataCache } from '../metadataCache';
import type { DefinitionCatalogSnapshot } from '../metadata/definitionCatalog';
const snapshot: DefinitionCatalogSnapshot = { definitions:[],objects:[],issues:[] };
describe('metadata-owned ephemeral definition catalog',()=>{
    test('identity, TTL, bounded retention and explicit invalidation',async()=>{
        const cache=new MetadataCache({} as vscode.ExtensionContext);
        const now=jest.spyOn(Date,'now').mockReturnValue(1000);
        cache.setDefinitionCatalog('NZ','DB',snapshot);
        expect(cache.getDefinitionCatalog('NZ','DB')).toBe(snapshot);
        expect(cache.getDefinitionCatalog('NZ','db')).toBeUndefined();
        expect(cache.getDefinitionCatalog('OTHER','DB')).toBeUndefined();
        now.mockReturnValue(301001);expect(cache.getDefinitionCatalog('NZ','DB')).toBeUndefined();
        for(let i=0;i<5;i++){cache.setDefinitionCatalog(`NZ${i}`,'DB',snapshot);}
        expect(cache.getDefinitionCatalog('NZ0','DB')).toBeUndefined();
        expect(cache.getDefinitionCatalog('NZ4','DB')).toBe(snapshot);
        cache.clearDefinitionCatalogs('NZ4');expect(cache.getDefinitionCatalog('NZ4','DB')).toBeUndefined();
        cache.clearDefinitionCatalogs();expect(cache.getDefinitionCatalog('NZ3','DB')).toBeUndefined();
        now.mockRestore();await cache.dispose();
    });
});
