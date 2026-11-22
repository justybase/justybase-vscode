/**
 * Manifest contract for the Run As context menu contributions.
 */

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
    submenus: { id: string; label?: string }[];
    menus: Record<string, MenuEntry[]>;
  };
};

const RUN_AS_COMMANDS = [
  'netezza.runAsSelection',
  'netezza.runAsStatement',
  'netezza.runAsWholeFile',
] as const;

function entries(menuId: string): MenuEntry[] {
  return manifest.contributes.menus[menuId] ?? [];
}

/** Every command reachable from a menu id, following submenus once. */
function reachableCommands(menuId: string): string[] {
  const reachable: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const entry of entries(id)) {
      if (entry.command) reachable.push(entry.command);
      if (entry.submenu) visit(entry.submenu);
    }
  };
  visit(menuId);
  return reachable;
}

describe('Run As menu contributions', () => {
  it.each(RUN_AS_COMMANDS)('declares the %s command', (command) => {
    expect(manifest.contributes.commands.map((entry) => entry.command)).toContain(command);
  });

  it('declares the Run As submenu', () => {
    expect(manifest.contributes.submenus.map((entry) => entry.id)).toContain('netezza.runAs');
  });

  it('lists every Run As scope inside its submenu', () => {
    const submenuCommands = entries('netezza.runAs').map((entry) => entry.command);
    expect(submenuCommands).toEqual(expect.arrayContaining([...RUN_AS_COMMANDS]));
  });

  it('requires an editor selection for the selection scope', () => {
    const selection = entries('netezza.runAs').find((entry) => entry.command === 'netezza.runAsSelection');
    expect(selection?.when).toContain('editorHasSelection');
  });

  it('exposes the submenu in the SQL editor context menu', () => {
    const contextEntry = entries('editor/context').find((entry) => entry.submenu === 'netezza.runAs');
    expect(contextEntry).toBeDefined();
    expect(contextEntry?.when).toContain('editorLangId == sql');
  });

  it('reaches every context-menu command at most once', () => {
    const reachable = reachableCommands('editor/context');
    const duplicates = [...new Set(reachable.filter((command, index) => reachable.indexOf(command) !== index))];
    expect(duplicates).toEqual([]);
  });

  it('keeps Validate SQL in the context menu only once', () => {
    // The editor/context entry and the SQL Tools submenu both used to expose it.
    expect(reachableCommands('editor/context').filter((command) => command === 'netezza.validateSelectedSql')).toHaveLength(1);
  });

  it('also exposes the scopes from the Run Query submenu', () => {
    const runSubmenuCommands = entries('netezza.sqlRun').map((entry) => entry.command);
    expect(runSubmenuCommands).toEqual(expect.arrayContaining([...RUN_AS_COMMANDS]));
  });
});
