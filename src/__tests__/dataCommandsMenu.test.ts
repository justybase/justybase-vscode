import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface CommandContribution {
  command: string;
  title?: string;
}

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
) as {
  contributes: {
    commands: CommandContribution[];
    menus: Record<string, MenuEntry[]>;
  };
};

const contextMenu = manifest.contributes.menus['view/item/context'] ?? [];
const palette = manifest.contributes.menus.commandPalette ?? [];

function menuEntries(command: string): MenuEntry[] {
  return contextMenu.filter((entry) => entry.command === command);
}

describe('data exploration context menu', () => {
  it.each([
    'netezza.countRows',
    'netezza.findDuplicateRows',
    'netezza.createTableFromTable',
    'netezza.callRoutine',
    'netezza.setTableStorage',
    'netezza.searchSchemaValues',
    'netezza.createIndex',
    'netezza.alterColumnQuick',
  ])('declares the %s command', (command) => {
    expect(manifest.contributes.commands.map((entry) => entry.command)).toContain(command);
  });

  it.each([
    'netezza.countRows',
    'netezza.findDuplicateRows',
    'netezza.createTableFromTable',
    'netezza.callRoutine',
    'netezza.setTableStorage',
    'netezza.searchSchemaValues',
    'netezza.createIndex',
    'netezza.alterColumnQuick',
  ])('hides %s from the command palette', (command) => {
    expect(palette).toContainEqual({ command, when: 'false' });
  });

  it('shows row actions on tables and views without a kind gate', () => {
    for (const command of ['netezza.countRows', 'netezza.findDuplicateRows']) {
      const entries = menuEntries(command);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.when).toContain('netezza:(TABLE|VIEW|MATERIALIZED VIEW|FOREIGN TABLE)');
        expect(entry.when).not.toContain('schemaDatabaseKind');
        expect(entry.when).not.toContain('capabilities');
      }
    }
  });

  it('gates routine, storage, search and index actions on capabilities or kinds', () => {
    expect(menuEntries('netezza.callRoutine')[0]?.when).toContain('supportsCallRoutine');
    expect(menuEntries('netezza.setTableStorage')[0]?.when).toContain('supportsTableStorageOptions');
    expect(menuEntries('netezza.searchSchemaValues')[0]?.when).toContain('supportsSchemaValueSearch');
    expect(menuEntries('netezza.createIndex')[0]?.when).toContain('schemaDatabaseKind == oracle');
    const alterWhen = menuEntries('netezza.alterColumnQuick')[0]?.when ?? '';
    expect(alterWhen).toContain('schemaDatabaseKind == postgresql');
    expect(alterWhen).toContain('schemaDatabaseKind == db2');
    expect(alterWhen).toContain('schemaDatabaseKind == duckdb');
  });

  it('scopes createTableFromTable to tables', () => {
    const entries = menuEntries('netezza.createTableFromTable');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.when).toContain('viewItem == netezza:TABLE');
  });
});
