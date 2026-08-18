import * as fs from 'fs';
import * as path from 'path';

interface MenuContribution {
    command?: string;
    when?: string;
    group?: string;
}

describe('File SQL workspace schema menu', () => {
    it('offers the Data Workspace Manager only on persistent Data Workspace connections', () => {
        const manifestPath = path.join(process.cwd(), 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            contributes?: {
                menus?: {
                    'view/item/context'?: MenuContribution[];
                };
            };
        };
        const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];

        expect(menu).toContainEqual(expect.objectContaining({
            command: 'netezza.openFileConnectionPanel',
            when: 'view == netezza.schema && viewItem == serverInstance && justybase.schemaIsDataWorkspace',
        }));
    });

    it('does not expose the Data Workspace Manager for legacy File SQL connections', () => {
        const manifestPath = path.join(process.cwd(), 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            contributes?: {
                menus?: {
                    'view/item/context'?: MenuContribution[];
                };
            };
        };
        const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
        const managerItems = menu.filter(item => item.command === 'netezza.openFileConnectionPanel');

        expect(managerItems).toHaveLength(1);
        expect(managerItems[0]?.when).not.toContain('schemaDatabaseKind == file');
    });

    it('offers adding files from a File SQL VIEW node', () => {
        const manifestPath = path.join(process.cwd(), 'extensions', 'duckdb', 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            contributes?: {
                menus?: {
                    'view/item/context'?: MenuContribution[];
                };
            };
        };
        const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];

        expect(menu).toContainEqual({
            command: 'justybase.duckdb.addFiles',
            when: 'view == netezza.schema && viewItem == netezza:VIEW && justybase.schemaDatabaseKind == file',
            group: 'JustyBase',
        });
    });
});
