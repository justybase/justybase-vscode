/**
 * Schema Commands - Backward Compatibility Re-export
 *
 * This file has been refactored into smaller modules in ./schema/
 * It now re-exports from the new location for backward compatibility.
 *
 * Module structure:
 * - schema/types.ts - Shared types and interfaces
 * - schema/helpers.ts - Common helper functions
 * - schema/copyCommands.ts - Copy/clipboard operations
 * - schema/tableCommands.ts - Table modification commands
 * - schema/maintenanceCommands.ts - Maintenance operations
 * - schema/ddlCommands.ts - DDL generation and comparison
 * - schema/viewCommands.ts - Visualization commands
 * - schema/utilityCommands.ts - Utility commands
 * - schema/schemaCommands.ts - Main entry point
 * - schema/index.ts - Module re-exports
 */

export { registerSchemaCommands, SchemaCommandsDependencies } from './schema';
