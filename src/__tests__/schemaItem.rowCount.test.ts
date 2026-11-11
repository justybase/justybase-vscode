import * as vscode from 'vscode';
import { SchemaItem } from '../providers/schemaProvider';

describe('SchemaItem estimated row count', () => {
    it('appends the reltuples estimate to the description and tooltip', () => {
        const item = new SchemaItem(
            'FACT200K',
            vscode.TreeItemCollapsibleState.None,
            'netezza:TABLE',
            'JUST_DATA',
            'TABLE',
            'CONFORMANCE',
            1,
            'fact table',
            'NZ',
        );

        item.applyRowCount(18484);

        expect(item.description).toBe('(CONFORMANCE) - fact table · ~18k');
        expect(item.rowCount).toBe(18484);
        expect(String(item.tooltip)).toContain('Estimated rows: ~18k (reltuples)');
    });

    it('ignores missing and negative estimates', () => {
        const item = new SchemaItem('T', vscode.TreeItemCollapsibleState.None, 'netezza:TABLE');
        const before = item.description;

        item.applyRowCount(undefined);
        expect(item.description).toBe(before);

        item.applyRowCount(-1);
        expect(item.description).toBe(before);
        expect(item.rowCount).toBeUndefined();
    });
});
