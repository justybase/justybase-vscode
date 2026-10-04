import type { ObjectDefinition } from '../services/analysis/dependencyIndex';
import type { ObjectReference } from '../services/analysis/sqlAnalysis';
/** Catalog metadata owned by MetadataCache; indexes retain hashes/edges only. */
export interface DefinitionCatalogSnapshot {
    definitions: ObjectDefinition[];
    objects: ObjectReference[];
    issues: string[];
}
