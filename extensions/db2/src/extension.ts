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
import type { DatabaseDialect } from '@justybase/contracts';
import { db2Dialect } from './db2Dialect';
import { registerDb2PartitionCommands } from './db2PartitionCommands';
import { registerDb2IndexCommands } from './db2IndexCommands';
import { ConnectionManager } from '../../../src/core/connectionManager';

interface JustyBaseLiteApi {
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
}

const CORE_EXTENSION_ID = 'justybase.justybase-netezza';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const coreExtension = vscode.extensions.getExtension<JustyBaseLiteApi>(CORE_EXTENSION_ID);
    if (!coreExtension) {
        throw new Error(`Required extension dependency '${CORE_EXTENSION_ID}' is not installed.`);
    }

    const api = await coreExtension.activate();
    if (!api || typeof api.registerDatabaseDialect !== 'function') {
        throw new Error(`Extension '${CORE_EXTENSION_ID}' does not expose the JustyBase registration API.`);
    }

    api.registerDatabaseDialect(db2Dialect);

    // Register DB2 specific commands
    const connectionManager = new ConnectionManager(context);
    context.subscriptions.push(
        ...registerDb2PartitionCommands(context, connectionManager),
        ...registerDb2IndexCommands(context, connectionManager)
    );
}

export function deactivate(): void {}
