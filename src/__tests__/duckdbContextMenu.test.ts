import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface ContextMenuItem {
  command: string;
  when: string;
}

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../..', 'package.json'), 'utf8'),
) as { contributes: { menus: { 'view/item/context': ContextMenuItem[] } } };
const contextMenu = manifest.contributes.menus['view/item/context'];

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
    'netezza.vacuumTable',
    'netezza.batchExportDDL',
  ])('hides unsupported %s actions for DuckDB and File SQL', (command) => {
    const items = getItems(command);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.when).not.toContain('justybase.schemaDatabaseKind == duckdb');
      expect(item.when).not.toContain('justybase.schemaDatabaseKind == file');
      if (command !== 'netezza.vacuumTable') {
        expect(item.when).toContain('justybase.schemaDatabaseKind != duckdb');
        expect(item.when).toContain('justybase.schemaDatabaseKind != file');
      }
    }
  });

  it('keeps Analyze available for DuckDB while hiding VACUUM', () => {
    expect(getItems('netezza.analyzeTable')[0]?.when).toContain(
      'justybase.schemaDatabaseKind == duckdb',
    );
    expect(getItems('netezza.vacuumTable')[0]?.when).not.toContain(
      'justybase.schemaDatabaseKind == duckdb',
    );
  });
});
