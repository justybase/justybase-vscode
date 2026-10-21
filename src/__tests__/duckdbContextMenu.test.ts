import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { schemaTreeMenuEntries, type MenuContribution } from './helpers/schemaTreeMenu';

interface ContextMenuItem {
  command: string;
  when: string;
}

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
) as { contributes: { menus: Record<string, MenuContribution[]> } };
const contextMenu = schemaTreeMenuEntries(manifest.contributes.menus) as ContextMenuItem[];

function getItems(command: string): ContextMenuItem[] {
  return contextMenu.filter((item) => item.command === command);
}

describe('DuckDB schema context menu', () => {
  it.each([
    'netezza.grantPermissions',
    'netezza.addPrimaryKey',
    'netezza.addForeignKey',
    'netezza.addUniqueConstraint',
    'netezza.changeOwner',
  ])('gates %s on a capability flag instead of a DuckDB kind exclusion', (command) => {
    const items = getItems(command);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.when).not.toContain('schemaDatabaseKind');
      expect(item.when).toMatch(/justybase\.schema\.capabilities\.supports\w+/);
    }
  });

  it('keeps Analyze available for DuckDB while VACUUM stays hidden', () => {
    expect(getItems('netezza.analyzeTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsAnalyzeTable',
    );
    expect(getItems('netezza.vacuumTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsVacuumTable',
    );
  });

  it('gates maintenance actions on fine-grained capability flags', () => {
    expect(getItems('netezza.generateStatistics')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsTableStatistics',
    );
    expect(getItems('netezza.reindexTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsReindexTable',
    );
    expect(getItems('netezza.truncateTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsTruncateTable',
    );
    expect(getItems('netezza.renameTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsTableRename',
    );
    expect(getItems('netezza.addTableComment')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsTableComments',
    );
    expect(getItems('netezza.addColumnComment')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsColumnComments',
    );
    expect(getItems('netezza.groomTable')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsGroomTable',
    );
    expect(getItems('netezza.checkSkew')[0]?.when).toContain(
      'justybase.schema.capabilities.supportsTableSkewCheck',
    );
  });

  it('gates SQLite actions on the SQLite maintenance flag', () => {
    for (const command of [
      'netezza.sqlite.viewIndexes',
      'netezza.sqlite.addIndex',
      'netezza.sqlite.vacuum',
      'netezza.sqlite.integrityCheck',
    ]) {
      expect(getItems(command)[0]?.when).toContain(
        'justybase.schema.capabilities.supportsSqliteDatabaseMaintenance',
      );
    }
  });

  it('does not use kind allow-lists for the converted maintenance actions', () => {
    for (const command of [
      'netezza.generateStatistics',
      'netezza.vacuumTable',
      'netezza.analyzeTable',
      'netezza.reindexTable',
      'netezza.truncateTable',
      'netezza.addPrimaryKey',
      'netezza.addForeignKey',
      'netezza.addUniqueConstraint',
      'netezza.changeOwner',
      'netezza.renameTable',
      'netezza.grantPermissions',
      'netezza.addTableComment',
      'netezza.addColumnComment',
    ]) {
      for (const item of getItems(command)) {
        expect(item.when).not.toContain('schemaDatabaseKind ==');
        expect(item.when).not.toContain('schemaDatabaseKind !=');
      }
    }
  });
});
