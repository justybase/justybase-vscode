import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { schemaTreeMenuEntries, type MenuContribution } from './helpers/schemaTreeMenu';

interface Manifest {
    contributes: {
        menus: Record<string, MenuContribution[]>;
        submenus?: Array<{ id: string; label: string }>;
    };
}

const repoRoot = path.resolve(__dirname, '../..');
const readManifest = (relativePath: string): Manifest =>
    JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Manifest;

const rootManifest = readManifest('package.json');
const rootMenus = rootManifest.contributes.menus;
const SHARED_SUBMENUS = [
    'justybase.schema.data',
    'justybase.schema.structure',
    'justybase.schema.maintenance',
    'justybase.schema.analysis',
];
const DESTRUCTIVE_COMMANDS = ['netezza.truncateTable', 'netezza.copyDrop', 'netezza.dropConstraint'];

describe('schema tree context menu structure', () => {
    it('orders every entry explicitly so VS Code does not sort it alphabetically', () => {
        const unordered = schemaTreeMenuEntries(rootMenus)
            .filter(entry => !/@\d+$/.test(entry.group ?? ''))
            .map(entry => entry.command ?? entry.submenu);

        expect(unordered).toEqual([]);
    });

    it('declares every shared submenu and opens it from object nodes', () => {
        const declared = (rootManifest.contributes.submenus ?? []).map(submenu => submenu.id);
        const main = rootMenus['view/item/context'];

        for (const id of SHARED_SUBMENUS) {
            expect(declared).toContain(id);
            expect(main).toContainEqual(expect.objectContaining({ submenu: id, group: expect.stringMatching(/^2_submenus@/) }));
            expect((rootMenus[id] ?? []).length).toBeGreaterThan(0);
        }
    });

    it('keeps destructive actions at the bottom of the main menu only', () => {
        const all = schemaTreeMenuEntries(rootMenus);
        for (const command of DESTRUCTIVE_COMMANDS) {
            const entries = all.filter(entry => entry.command === command);
            expect(entries.length).toBeGreaterThan(0);
            for (const entry of entries) {
                expect(entry.group).toMatch(/^9_danger@\d+$/);
                expect(rootMenus['view/item/context']).toContain(entry);
            }
        }
        const lastGroup = rootMenus['view/item/context']
            .map(entry => entry.group ?? '')
            .filter(group => !group.startsWith('inline'))
            .sort()
            .pop();
        expect(lastGroup).toMatch(/^9_danger@/);
    });

    it.each(['db2', 'postgresql', 'mysql'])('folds %s table actions into the shared submenus', (dialect) => {
        const manifest = readManifest(path.join('extensions', dialect, 'package.json'));
        const menus = manifest.contributes.menus;

        expect(manifest.contributes.submenus ?? []).toEqual([]);
        expect(menus['view/item/context'] ?? []).toEqual([]);
        const targets = Object.keys(menus).filter(key => key !== 'commandPalette');
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
            expect(SHARED_SUBMENUS).toContain(target);
            for (const entry of menus[target]) {
                expect(entry.group).toMatch(/@\d+$/);
                expect(entry.when).toContain(`justybase.schemaDatabaseKind == ${dialect}`);
            }
        }
    });
});
