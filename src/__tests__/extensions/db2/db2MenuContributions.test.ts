import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../..', 'extensions', 'db2', 'package.json'), 'utf8'),
) as {
  contributes: {
    commands: Array<{ command: string }>;
    menus: Record<string, MenuEntry[]>;
  };
};

const REGISTERED_COMMANDS = [
  'justybase.db2.createIndexWizard',
  'justybase.db2.managePartitions',
  'justybase.db2.reorgIndexes',
  'justybase.db2.listIndexes',
  'justybase.db2.createIndex',
  'justybase.db2.dropIndex',
  'justybase.db2.listPartitions',
  'justybase.db2.addPartition',
  'justybase.db2.attachPartition',
  'justybase.db2.detachPartition',
  'justybase.db2.dropPartition',
];

describe('Db2 extension menu contributions', () => {
  it.each(REGISTERED_COMMANDS)('declares registered command %s in the manifest', (command) => {
    expect(manifest.contributes.commands.map((entry) => entry.command)).toContain(command);
  });

  it('exposes the quick index and partition flows in the table submenus', () => {
    const submenuEntries = [
      ...(manifest.contributes.menus['justybase.db2.tableStructures'] ?? []),
      ...(manifest.contributes.menus['justybase.db2.maintenance'] ?? []),
    ];
    for (const command of [
      'justybase.db2.listIndexes',
      'justybase.db2.listPartitions',
      'justybase.db2.dropIndex',
      'justybase.db2.detachPartition',
      'justybase.db2.dropPartition',
    ]) {
      expect(submenuEntries.map((entry) => entry.command)).toContain(command);
    }
  });

  it('keeps tree-only quick flows out of the command palette', () => {
    const paletteEntries = manifest.contributes.menus.commandPalette ?? [];
    for (const command of [
      'justybase.db2.listIndexes',
      'justybase.db2.dropIndex',
      'justybase.db2.listPartitions',
      'justybase.db2.detachPartition',
      'justybase.db2.dropPartition',
    ]) {
      expect(paletteEntries).toContainEqual({ command, when: 'false' });
    }
  });
});
