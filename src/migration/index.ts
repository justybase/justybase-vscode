/**
 * Cross-database migration feature.
 */

export { MigrationService } from './migrationService';
export type { MigrationServiceDependencies } from './migrationService';
export * from './types';
export {
    translateType,
    toCanonicalType,
    renderTargetType,
} from './typeTranslation/translateType';
export { parseSqlType, getSqlTypeBaseName } from './typeTranslation/parseSqlType';
export { buildCreateTableDdl, buildTargetQualifiedName } from './ddlBuilder';
