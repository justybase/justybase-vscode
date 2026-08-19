import * as vscode from 'vscode';
import { createConnectionScopedMetadataQueryRunner } from '../../metadata/connectionScopedMetadataQueryRunner';
import { supportsLegacyMetadataPrefetch } from '../../metadata/prefetchSupport';
import { METADATA_QUERY_TIMEOUT_SECONDS } from '../../metadata/metadataQueryLimiter';
import type { SchemaItem } from '../../providers/schemaProvider';
import type { SchemaCommandsDependencies } from './types';

const NETEZZA_SINGLE_OBJECT_REFRESH_TYPES = new Set(['TABLE', 'GLOBAL TEMP TABLE']);

function resolveItemName(item: SchemaItem): string | undefined {
	const raw = item.rawLabel || item.label;
	if (typeof raw === 'string') {
		return raw;
	}
	if (raw && typeof raw === 'object' && 'label' in raw) {
		return String((raw as { label: string }).label);
	}
	return undefined;
}

export function registerRefreshMetadataCommands(
	deps: SchemaCommandsDependencies,
): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(
			'netezza.refreshSchemaSelection',
			async (item?: SchemaItem) => {
				const synchronizer = deps.tableDdlSynchronizer;
				const connectionName = item?.connectionName;
				if (!item || !connectionName) {
					vscode.window.showWarningMessage(
						'Select a connection, database, object group, or object in the schema tree to refresh.',
					);
					return;
				}

				const contextValue = item.contextValue || '';
				const database = item.dbName;
				const objectType = item.objType?.toUpperCase();
				const databaseKind = deps.connectionManager.getConnectionDatabaseKind(connectionName);

				try {
					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Window,
							title: 'Refreshing selected metadata...',
							cancellable: false,
						},
						async () => {
							if (contextValue === 'serverInstance') {
								deps.metadataCache.clearConnectionMetadata(connectionName);
								deps.schemaProvider.clearConnectionError(connectionName);
								deps.schemaProvider.refresh();
								if (supportsLegacyMetadataPrefetch(databaseKind)) {
                                    deps.metadataCache.triggerConnectionPrefetch(
                                        connectionName,
                                        createConnectionScopedMetadataQueryRunner({
                                            context: deps.context,
                                            connectionManager: deps.connectionManager,
                                            connectionName,
                                            maxRows: 1000000,
                                            timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                                        }),
                                    );
								}
								return;
							}

							if (contextValue === 'database') {
								if (!database) {
									throw new Error('The selected database node has no database name.');
								}
								deps.metadataCache.invalidateSchema(connectionName, database);
								await deps.schemaProvider.reloadTypeGroups(connectionName, database);
								return;
							}

							if (!synchronizer) {
								throw new Error('Metadata refresh is not available in this session.');
							}

							if (contextValue.startsWith('typeGroup')) {
								if (!database || !objectType) {
									throw new Error('The selected object group has no database or type.');
								}
								await synchronizer.refreshObjectType(connectionName, database, objectType);
								return;
							}

							if (contextValue.startsWith('netezza:') || contextValue.startsWith('favoritesObject:')) {
								if (!database || !objectType) {
									throw new Error('The selected object has no database or type.');
								}
								if (
									databaseKind === 'netezza'
									&& NETEZZA_SINGLE_OBJECT_REFRESH_TYPES.has(objectType)
								) {
									const schema = item.schema;
									const table = resolveItemName(item);
									if (!schema || !table) {
										throw new Error('The selected object has no resolved schema or name.');
									}
									await synchronizer.refreshObject(connectionName, {
										database,
										schema,
										table,
									});
									return;
								}
								await synchronizer.refreshObjectType(connectionName, database, objectType);
								return;
							}

							throw new Error(
								'Select a connection, database, object group, or catalog object to refresh.',
							);
						},
					);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(`Failed to refresh metadata: ${message}`);
				}
			},
		),
	];
}
