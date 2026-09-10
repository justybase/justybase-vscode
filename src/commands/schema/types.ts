/**
 * Schema Commands - Types and Interfaces
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';
import { SchemaProvider, SchemaItem } from '../../providers/schemaProvider';
import type { TableDdlSynchronizer } from '../../metadata/tableDdlSynchronizer';
export type { SchemaItemData } from './itemTypes';

/**
 * Dependencies required by schema commands
 */
export interface SchemaCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    schemaProvider: SchemaProvider;
    schemaTreeView: vscode.TreeView<SchemaItem>;
    tableDdlSynchronizer?: TableDdlSynchronizer;
}
