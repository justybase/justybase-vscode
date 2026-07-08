import * as vscode from 'vscode';
import { ConnectionManager } from '../../../src/core/connectionManager';
import {
  isTableItem,
  resolveOperationContext,
  SchemaItemData,
  getErrorMessage
} from './db2CommandContext';

export function registerDb2IndexCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager
): vscode.Disposable[] {
  const dropIndexDirectCommand = vscode.commands.registerCommand(
    'justybase.db2.dropIndex',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to drop an index from.');
        return;
      }

      const resolved = resolveOperationContext(
        context,
        connectionManager,
        item,
        'Drop index'
      );
      if (!resolved) {
        return;
      }

      try {
        const indexes = await resolved.provider.listIndexes?.(
          resolved.target,
          resolved.services
        );

        if (!indexes || indexes.length === 0) {
          vscode.window.showInformationMessage('No indexes found for this table.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          indexes.map(idx => ({
            label: idx.name,
            description: `${idx.indexType} on (${idx.columns.join(', ')})`,
            detail: idx.isPrimary ? 'PRIMARY KEY' : 'Index',
            index: idx,
          })),
          { placeHolder: 'Select an index to drop' }
        );

        if (!selected) {
          return;
        }

        await resolved.provider.dropIndex?.(
          resolved.target,
          selected.index.name,
          resolved.services,
          false,
          false
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to drop index: ${getErrorMessage(error)}`);
      }
    }
  );

  const listIndexesCommand = vscode.commands.registerCommand(
    'justybase.db2.listIndexes',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to list indexes.');
        return;
      }

      const resolved = resolveOperationContext(
        context,
        connectionManager,
        item,
        'List indexes'
      );
      if (!resolved) {
        return;
      }

      try {
        const indexes = await resolved.provider.listIndexes?.(
          resolved.target,
          resolved.services
        );

        if (!indexes || indexes.length === 0) {
          vscode.window.showInformationMessage('No indexes found for this table.');
          return;
        }

        const items = indexes.map(idx => ({
          label: `${idx.isUnique ? '🔑 ' : ''}${idx.name}`,
          description: `${idx.indexType} on (${idx.columns.join(', ')})`,
          detail: `${idx.isPrimary ? 'PRIMARY KEY • ' : ''}${idx.isValid === false ? '⚠️ INVALID' : 'Valid'}`,
          index: idx,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select an index for actions',
        });

        if (selected) {
          const action = await vscode.window.showQuickPick(
            [
              { label: '$(trash) Drop Index', action: 'drop' },
            ],
            { placeHolder: `Actions for index "${selected.index.name}"` }
          );

          if (action?.action === 'drop') {
            await resolved.provider.dropIndex?.(
              resolved.target,
              selected.index.name,
              resolved.services,
              false,
              false
            );
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to list indexes: ${getErrorMessage(error)}`);
      }
    }
  );

  const createIndexCommand = vscode.commands.registerCommand(
    'justybase.db2.createIndex',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to create an index.');
        return;
      }

      const resolved = resolveOperationContext(
        context,
        connectionManager,
        item,
        'Create index'
      );
      if (!resolved) {
        return;
      }

      // Get columns from user
      const columnsInput = await vscode.window.showInputBox({
        prompt: 'Enter column names (comma-separated)',
        placeHolder: 'e.g., COL1, COL2 DESC',
      });

      if (!columnsInput) {
        return;
      }

      const columns = columnsInput.split(',').map(c => c.trim()).filter(c => c.length > 0);

      const indexType = await vscode.window.showQuickPick(
        [
          { label: 'Regular', description: 'Standard B-tree index', value: 'btree' },
          { label: 'Unique', description: 'Unique B-tree index', value: 'unique' },
          { label: 'Clustering', description: 'Clustered B-tree index', value: 'cluster' },
        ],
        { placeHolder: 'Select index type' }
      );

      if (!indexType) {
        return;
      }

      await resolved.provider.createIndex?.(
        resolved.target,
        {
          columns,
          indexType: indexType.value === 'cluster' ? 'hash' : 'btree',
          isUnique: indexType.value === 'unique',
        },
        resolved.services
      );
    }
  );

  const reorgIndexesCommand = vscode.commands.registerCommand(
    'justybase.db2.reorgIndexes',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to reorganize indexes.');
        return;
      }

      const resolved = resolveOperationContext(
        context,
        connectionManager,
        item,
        'Reorg indexes'
      );
      if (!resolved) {
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          { label: 'REBUILD', description: 'Full index rebuild (most thorough)', verbose: false },
          { label: 'CLEANUP ONLY', description: 'Cleanup pseudo-deleted entries (lighter)', verbose: true },
        ],
        { placeHolder: 'Select reorg mode' }
      );
      if (!mode) return;

      const accessMode = await vscode.window.showQuickPick(
        [
          { label: 'ALLOW WRITE ACCESS', description: 'Readers and writers allowed (default)', concurrent: true },
          { label: 'ALLOW READ ACCESS', description: 'Only readers allowed', concurrent: false },
        ],
        { placeHolder: 'Select access mode during reorg' }
      );
      if (!accessMode) return;

      await resolved.provider.reindexWithOptions?.(
        resolved.target,
        {
          verbose: mode.verbose,
          concurrently: accessMode.concurrent,
        },
        resolved.services
      );
    }
  );

  return [
    dropIndexDirectCommand,
    listIndexesCommand,
    createIndexCommand,
    reorgIndexesCommand,
  ];
}
