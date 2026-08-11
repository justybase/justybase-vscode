import type { ERDData, TableNode } from '../../src/schema/erdProvider';
import {
    buildTableAliases,
    computeInitialLayout,
    restorePositions
} from '../../media/erdView/layout';

function table(name: string): TableNode {
    return {
        database: 'TESTDB',
        schema: 'PUBLIC',
        tableName: name,
        fullName: `PUBLIC.${name}`,
        primaryKeyColumns: ['ID'],
        columns: [
            { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false }
        ]
    };
}

const layoutData: ERDData = {
    database: 'TESTDB',
    schema: 'PUBLIC',
    tables: [table('USERS'), table('ORDERS'), table('PRODUCTS')],
    relationships: [
        {
            constraintName: 'FK_ORDERS_USER',
            fromTable: 'PUBLIC.ORDERS',
            toTable: 'PUBLIC.USERS',
            fromColumns: ['USER_ID'],
            toColumns: ['ID'],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION'
        }
    ]
};

describe('ERD layout helpers', () => {
    it('resolves full, schema-qualified and short table aliases', () => {
        const aliases = buildTableAliases(layoutData.tables);

        expect(aliases.get('PUBLIC.USERS')).toBe('PUBLIC.USERS');
        expect(aliases.get('USERS')).toBe('PUBLIC.USERS');
        expect(aliases.get('PUBLIC.ORDERS')).toBe('PUBLIC.ORDERS');
    });

    it('creates a stable layout for connected and orphan tables', () => {
        const aliases = buildTableAliases(layoutData.tables);
        const first = computeInitialLayout(layoutData, aliases);
        const second = computeInitialLayout(layoutData, aliases);

        expect(first).toEqual(second);
        expect(first.size).toBe(3);
        expect(first.get('PUBLIC.ORDERS')).toBeDefined();
        expect(first.get('PUBLIC.USERS')).toBeDefined();
        expect(first.get('PUBLIC.PRODUCTS')).toBeDefined();
        expect(first.get('PUBLIC.ORDERS')!.x).not.toBe(first.get('PUBLIC.USERS')!.x);
    });

    it('restores only valid positions for tables in the current schema', () => {
        const initial = new Map([
            ['PUBLIC.USERS', { x: 80, y: 80 }],
            ['PUBLIC.ORDERS', { x: 470, y: 80 }]
        ]);
        const restored = restorePositions(
            initial,
            JSON.stringify({
                version: 1,
                positions: {
                    'PUBLIC.USERS': { x: 900, y: 700 },
                    'PUBLIC.ORDERS': { x: 'bad', y: 40 },
                    'PUBLIC.MISSING': { x: 20, y: 20 }
                }
            }),
            1
        );

        expect(restored.get('PUBLIC.USERS')).toEqual({ x: 900, y: 700 });
        expect(restored.get('PUBLIC.ORDERS')).toEqual({ x: 470, y: 80 });
        expect(restored.has('PUBLIC.MISSING')).toBe(false);
    });

    it('ignores layouts from an incompatible version or malformed JSON', () => {
        const initial = new Map([['PUBLIC.USERS', { x: 80, y: 80 }]]);

        expect(restorePositions(initial, JSON.stringify({ version: 2, positions: {} }), 1)).toEqual(initial);
        expect(() => restorePositions(initial, '{not-json', 1)).toThrow();
    });
});
