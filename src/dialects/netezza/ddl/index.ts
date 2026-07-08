/**
 * DDL Generator - Module Index
 * Re-exports all DDL generator functions and types
 */

// Types
export * from './types';

// Helpers (exported for potential external use)
export { quoteNameIfNeeded } from './helpers';

// Metadata queries (exported for potential external use)
export {
    getColumns,
    getDistributionInfo,
    getOrganizeInfo,
    getKeysInfo,
    getTableComment,
    getTableOwner
} from './metadata';

// DDL Generators
export { generateTableDDL, buildTableDDLFromCache } from './tableDDL';
export { generateViewDDL } from './viewDDL';
export { generateProcedureDDL } from './procedureDDL';
export { generateExternalTableDDL } from './externalTableDDL';
export { generateSynonymDDL } from './synonymDDL';
export { generateBatchDDL } from './batchDDL';

// Main entry point
export { generateDDL } from './ddlGenerator';
