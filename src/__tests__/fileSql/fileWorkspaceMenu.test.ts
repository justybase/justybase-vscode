import * as fs from 'fs';
import * as path from 'path';

interface MenuContribution {
    command?: string;
    when?: string;
    group?: string;
}

describe('File SQL workspace schema menu', () => {
    it('keeps the manager action on the File SQL connection node', () => {
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
            when: 'view == netezza.schema && viewItem == serverInstance && (justybase.schemaIsDataWorkspace || justybase.schemaDatabaseKind == file)',
        }));
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
