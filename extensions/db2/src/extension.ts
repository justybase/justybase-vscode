/**
 * DB2CODEPAGE UTF-8 Strategy - Defense-in-Depth Layering
 * =======================================================
 * The DB2CODEPAGE=1208 (UTF-8) environment variable is set at multiple layers
 * to ensure proper Unicode support (Polish characters, etc.) before any ibm_db
 * code runs. This defense-in-depth approach handles different execution contexts:
 *
 * Layer 1: esbuild.db2.js banner (FIRST for packaged extensions)
 * - Injected at the very top of the bundled JS file
 * - Runs before any module code in production builds
 * - This is the primary mechanism for packaged extensions
 *
 * Layer 2: .vscode/launch.json env (for F5 debug sessions)
 * - Sets DB2CODEPAGE in the Extension Development Host environment
 * - Only applies when debugging via F5 in VS Code
 *
 * Layer 3: This file - extension.ts module-level check (fallback)
 * - Runs when the extension module is loaded
 * - Catches cases where Layer 1 or 2 didn't apply
 * - MUST be before any imports (imports are hoisted)
 *
 * Layer 4: db2Connection.ts ensureClidriverOnPath() (runtime fallback)
 * - Sets DB2CODEPAGE before establishing connections
 * - Last line of defense if all other layers failed
 *
 * The IBM CLI driver reads DB2CODEPAGE during initialization, so it must be set
 * before the ibm_db module is loaded or any connection is established.
 */
if (!process.env.DB2CODEPAGE) {
  process.env.DB2CODEPAGE = '1208';
}

import * as vscode from 'vscode';
import { db2Dialect } from './db2Dialect';
import { registerDb2PartitionCommands } from './db2PartitionCommands';
import { registerDb2IndexCommands } from './db2IndexCommands';
import { registerDb2DesignerCommands } from './db2DesignerCommands';
import { isDb2MaintenanceApi } from './db2CommandContext';
import { activateCoreExtension } from '../../../src/api/companionActivation';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(db2Dialect);
    if (!isDb2MaintenanceApi(api)) {
        vscode.window.showWarningMessage('Update the JustyBase core extension to enable Db2 maintenance commands.');
        return;
    }

    // Register DB2 specific commands
    context.subscriptions.push(
        ...registerDb2PartitionCommands(context, api),
        ...registerDb2IndexCommands(context, api),
        ...registerDb2DesignerCommands(context, api)
    );
}

export function deactivate(): void {}
