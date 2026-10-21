import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { schemaTreeMenuEntries } from './helpers/schemaTreeMenu';

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

const contextMenu = schemaTreeMenuEntries(manifest.contributes.menus);
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
    'netezza.reindexConcurrently',
    'netezza.duckdb.listIndexes',
    'netezza.duckdb.dropIndex',
    'netezza.sqlite.rebuildTable',
    'netezza.exportTableData',
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
    'netezza.reindexConcurrently',
    'netezza.duckdb.listIndexes',
    'netezza.duckdb.dropIndex',
    'netezza.sqlite.rebuildTable',
    'netezza.exportTableData',
  ])('hides %s from the command palette', (command) => {
    expect(palette).toContainEqual({ command, when: 'false' });
  });

  it('shows row actions on tables and views without a kind gate', () => {
    for (const command of ['netezza.countRows', 'netezza.findDuplicateRows']) {
      const entries = menuEntries(command);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.when).toContain('netezza:(TABLE|VIEW|MATERIALIZED VIEW|FOREIGN TABLE|EXTERNAL TABLE|MQT');
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

  it('offers table export on tables and views without a kind gate', () => {
    const entries = menuEntries('netezza.exportTableData');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.when).toContain('netezza:(TABLE|VIEW|MATERIALIZED VIEW|FOREIGN TABLE|EXTERNAL TABLE|MQT|NICKNAME|ALIAS|SYNONYM|DYNAMIC TABLE|PROJECTION)');
    expect(entries[0]?.when).not.toContain('schemaDatabaseKind');
  });

  it('gates the rebuild, DuckDB index and concurrent reindex actions', () => {
    expect(menuEntries('netezza.sqlite.rebuildTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsSqliteDatabaseMaintenance',
    );
    expect(menuEntries('netezza.duckdb.listIndexes')[0]?.when).toContain(
      'justybase.schemaDatabaseKind == duckdb',
    );
    expect(menuEntries('netezza.duckdb.dropIndex')[0]?.when).toContain(
      'justybase.schemaDatabaseKind == duckdb',
    );
    expect(menuEntries('netezza.reindexConcurrently')[0]?.when).toContain(
      'justybase.schemaDatabaseKind == postgresql',
    );
  });
});
