/**
 * Schema Commands - Main Entry Point
 * Aggregates all schema-related command registrations
 */

import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';
import { registerCopyCommands } from './copyCommands';
import { registerDataCommands } from './dataCommands';
import { registerReportCommands } from './reportCommands';
import { registerObjectNoteCommands } from './objectNoteCommands';
import { registerDuckdbCommands } from './duckdbCommands';
import { registerTableExportCommands } from './tableExportCommands';
import { registerTableCommands } from './tableCommands';
import { registerMaintenanceCommands } from './maintenanceCommands';
import { registerDDLCommands } from './ddlCommands';
import { registerSqliteCommands } from './sqliteCommands';
import { registerViewCommands } from './viewCommands';
import { registerUtilityCommands } from './utilityCommands';

/**
 * Register all schema-related commands
 * This is the main entry point that combines all command registrations
 */
export function registerSchemaCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        ...registerCopyCommands(deps),
        ...registerDataCommands(deps),
        ...registerReportCommands(deps),
        ...registerObjectNoteCommands(deps),
        ...registerDuckdbCommands(deps),
        ...registerTableExportCommands(deps),
        ...registerTableCommands(deps),
        ...registerMaintenanceCommands(deps),
        ...registerDDLCommands(deps),
        ...registerSqliteCommands(deps),
        ...registerViewCommands(deps),
        ...registerUtilityCommands(deps)
    ];
}
