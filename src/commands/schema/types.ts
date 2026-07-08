/**
 * Schema Commands - Types and Interfaces
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';
import { SchemaProvider, SchemaItem } from '../../providers/schemaProvider';

/**
 * Dependencies required by schema commands
 */
export interface SchemaCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    schemaProvider: SchemaProvider;
    schemaTreeView: vscode.TreeView<SchemaItem>;
}

/**
 * Common schema item properties used in commands
 */
export interface SchemaItemData {
    label?: string;
    rawLabel?: string;
    dbName?: string;
    schema?: string;
    objType?: string;
    connectionName?: string;
    contextValue?: string;
    parentName?: string;
    objectDescription?: string;
    objId?: number;
}
