import * as vscode from 'vscode';
import {
  Db2MaintenanceApi,
  isTableItem,
  resolveOperationContext,
  SchemaItemData,
  getErrorMessage
} from './db2CommandContext';
import { Db2PartitionDesignerView } from './db2PartitionDesignerView';

export function registerDb2PartitionCommands(
  context: vscode.ExtensionContext,
  api: Db2MaintenanceApi
): vscode.Disposable[] {
  const detachPartitionDirectCommand = vscode.commands.registerCommand(
    'justybase.db2.detachPartition',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to detach a partition from.');
        return;
      }

      const resolved = await resolveOperationContext(
        context,
        api,
        item,
        'Detach partition'
      );
      if (!resolved) {
        return;
      }

      try {
        const partitions = await resolved.provider.listPartitions?.(
          resolved.target,
          resolved.services
        );

        if (!partitions || partitions.length === 0) {
          vscode.window.showInformationMessage('No partitions found for this table.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          partitions.map(p => ({
            label: p.name,
            description: p.partitionBound,
            detail: `Rows: ${p.rowCount?.toLocaleString() ?? 'N/A'}`,
            partition: p,
          })),
          { placeHolder: 'Select a partition to detach' }
        );

        if (!selected) {
          return;
        }

        await resolved.provider.detachPartition?.(
          resolved.target,
          selected.label,
          resolved.services,
          false,
          selected.partition.schema
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to detach partition: ${getErrorMessage(error)}`);
      }
    }
  );

  const dropPartitionDirectCommand = vscode.commands.registerCommand(
    'justybase.db2.dropPartition',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to drop a partition from.');
        return;
      }

      const resolved = await resolveOperationContext(
        context,
        api,
        item,
        'Drop partition'
      );
      if (!resolved) {
        return;
      }

      try {
        const partitions = await resolved.provider.listPartitions?.(
          resolved.target,
          resolved.services
        );

        if (!partitions || partitions.length === 0) {
          vscode.window.showInformationMessage('No partitions found for this table.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          partitions.map(p => ({
            label: p.name,
            description: p.partitionBound,
            detail: `Rows: ${p.rowCount?.toLocaleString() ?? 'N/A'}`,
            partition: p,
          })),
          { placeHolder: 'Select a partition to drop' }
        );

        if (!selected) {
          return;
        }

        await resolved.provider.dropPartition?.(
          resolved.target,
          selected.label,
          resolved.services,
          false,
          selected.partition.schema
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to drop partition: ${getErrorMessage(error)}`);
      }
    }
  );

  const listPartitionsCommand = vscode.commands.registerCommand(
    'justybase.db2.listPartitions',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a table to list partitions.');
        return;
      }

      const resolved = await resolveOperationContext(
        context,
        api,
        item,
        'List partitions'
      );
      if (!resolved) {
        return;
      }

      try {
        const partitions = await resolved.provider.listPartitions?.(
          resolved.target,
          resolved.services
        );

        if (!partitions || partitions.length === 0) {
          vscode.window.showInformationMessage('No partitions found for this table.');
          return;
        }

        const items = partitions.map(p => ({
          label: p.name,
          description: p.partitionBound,
          detail: `Rows: ${p.rowCount?.toLocaleString() ?? 'N/A'}`,
          partition: p,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a partition for actions',
        });

        if (selected) {
          const action = await vscode.window.showQuickPick(
            [
              { label: '$(trash) Drop Partition', action: 'drop' },
              { label: '$(debug-disconnect) Detach Partition', action: 'detach' },
              { label: '$(copy) Copy DDL', action: 'copy' },
            ],
            { placeHolder: `Actions for partition "${selected.label}"` }
          );

          if (action?.action === 'drop') {
            await resolved.provider.dropPartition?.(
              resolved.target,
              selected.label,
              resolved.services,
              false
            );
          } else if (action?.action === 'detach') {
            await resolved.provider.detachPartition?.(
              resolved.target,
              selected.label,
              resolved.services,
              false
            );
          } else if (action?.action === 'copy') {
            const ddl = `ALTER TABLE "${resolved.target.schemaName}"."${resolved.target.tableName}" ADD PARTITION ${selected.label} ${selected.partition.partitionBound};`;
            await vscode.env.clipboard.writeText(ddl);
            vscode.window.showInformationMessage('Partition DDL copied to clipboard.');
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to list partitions: ${getErrorMessage(error)}`);
      }
    }
  );

  const addPartitionCommand = vscode.commands.registerCommand(
    'justybase.db2.addPartition',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a partitioned table.');
        return;
      }

      const resolved = await resolveOperationContext(
        context,
        api,
        item,
        'Add partition'
      );
      if (!resolved) {
        return;
      }

      await Db2PartitionDesignerView.createOrShow(context, resolved);
    }
  );

  const attachPartitionCommand = vscode.commands.registerCommand(
    'justybase.db2.attachPartition',
    async (item: SchemaItemData) => {
      if (!isTableItem(item)) {
        vscode.window.showErrorMessage('Please select a partitioned table.');
        return;
      }

      const resolved = await resolveOperationContext(
        context,
        api,
        item,
        'Attach partition'
      );
      if (!resolved) {
        return;
      }

      await Db2PartitionDesignerView.createOrShow(context, resolved);
    }
  );

  return [
    detachPartitionDirectCommand,
    dropPartitionDirectCommand,
    listPartitionsCommand,
    addPartitionCommand,
    attachPartitionCommand,
  ];
}
