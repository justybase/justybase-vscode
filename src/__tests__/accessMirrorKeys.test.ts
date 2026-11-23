import {
    accessMirrorKeyConstraintSql,
    accessMirrorKeyIndexSql,
    planAccessMirrorKeys,
} from '../../extensions/access/src/accessMirrorKeys';
import {
    accessMirrorReferenceSql,
    orderTablesForMirror,
    planAccessMirrorReferences,
} from '../../extensions/access/src/accessMirrorReferences';
import { buildAccessMirrorTableSql } from '../../extensions/access/src/accessDuckDbMirror';
import type {
    AccessColumnDefinition,
    AccessIndexDefinition,
    AccessRelationshipDefinition,
    AccessTableDefinition,
} from '../../packages/access-file/src/types';

function column(
    name: string,
    accessType: AccessColumnDefinition['accessType'],
    nullable = true,
): AccessColumnDefinition {
    return {
        name,
        accessType,
        nullable,
        fixedLength: false,
        size: 50,
        autoLong: false,
        autoUuid: false,
        isPrimaryKey: false,
    };
}

function table(
    name: string,
    columns: readonly AccessColumnDefinition[],
): AccessTableDefinition {
    return { name, columns, rowCount: 0, isSystem: false };
}

function index(
    name: string,
    columns: readonly string[],
    overrides: Partial<AccessIndexDefinition> = {},
): AccessIndexDefinition {
    return {
        name,
        columns,
        primaryKey: false,
        unique: true,
        ignoreNulls: false,
        required: false,
        ...overrides,
    };
}

function relationship(
    overrides: Partial<AccessRelationshipDefinition> = {},
): AccessRelationshipDefinition {
    return {
        name: 'FK_child_parent',
        table: 'child',
        columns: ['pid'],
        foreignTable: 'parent',
        foreignColumns: ['id'],
        enforced: true,
        updateCascade: false,
        deleteCascade: false,
        ...overrides,
    };
}

/** DuckDB types used by the mirror; only equality between paired columns matters. */
function typeOf(definition: AccessColumnDefinition): string {
    switch (definition.accessType) {
        case 'long': return 'INTEGER';
        case 'integer': return 'SMALLINT';
        case 'text':
        case 'memo':
        case 'repid': return 'VARCHAR';
        case 'datetime':
        case 'datetimextended': return 'TIMESTAMP';
        default: return 'VARCHAR';
    }
}

const parent = table('parent', [
    column('id', 'long', false),
    column('code', 'text'),
]);
const child = table('child', [
    column('id', 'long', false),
    column('pid', 'long'),
    column('code', 'text'),
]);

describe('planAccessMirrorKeys', () => {
    it('reproduces a text primary key with NOT NULL plus an expression index', () => {
        const plan = planAccessMirrorKeys(parent, [
            index('PrimaryKey', ['code'], { primaryKey: true, required: true }),
        ]);

        // Access compares text keys ignoring case and trailing spaces, which a
        // DuckDB PRIMARY KEY (binary comparison) would not reproduce.
        expect(plan.requiredColumns).toEqual(['code']);
        expect(plan.keys).toHaveLength(1);
        const key = plan.keys[0]!;
        expect(key.kind).toBe('primary-key');
        expect(key.asConstraint).toBe(false);
        expect(key.expressions).toEqual(['lower(rtrim("code", \' \'))']);
        expect(accessMirrorKeyIndexSql('parent', key))
            .toBe(`CREATE UNIQUE INDEX "${key.name}" ON "parent" (lower(rtrim("code", ' ')))`);
    });

    it('emits a real constraint for keys made only of non-text columns', () => {
        const plan = planAccessMirrorKeys(parent, [
            index('PrimaryKey', ['id'], { primaryKey: true, required: true }),
        ]);

        const key = plan.keys[0]!;
        expect(key.asConstraint).toBe(true);
        expect(accessMirrorKeyConstraintSql(key))
            .toBe(`CONSTRAINT "${key.name}" PRIMARY KEY ("id")`);
    });

    it('mixes expression and plain columns in a composite unique index', () => {
        const plan = planAccessMirrorKeys(child, [index('UX_child', ['pid', 'code'])]);

        const key = plan.keys[0]!;
        expect(key.asConstraint).toBe(false);
        expect(key.expressions).toEqual(['"pid"', 'lower(rtrim("code", \' \'))']);
    });

    it('marks columns required for an index with DISALLOW NULL even when not unique', () => {
        const plan = planAccessMirrorKeys(parent, [index('IX_code', ['code'], {
            unique: false,
            required: true,
        })]);

        // A non-unique `WITH DISALLOW NULL` index rejects NULL but says nothing
        // about duplicates, so it must not become a unique key.
        expect(plan.keys).toEqual([]);
        expect(plan.requiredColumns).toEqual(['code']);
    });

    it('names mirror indexes uniquely because Access index names are per table', () => {
        const first = planAccessMirrorKeys(parent, [index('PrimaryKey', ['code'])]);
        const second = planAccessMirrorKeys(child, [index('PrimaryKey', ['code'])]);

        expect(first.keys[0]!.name).not.toBe(second.keys[0]!.name);
    });

    it('skips keys on complex and MEMO/OLE columns and records why', () => {
        const complex = table('docs', [column('Tags', 'complex'), column('Body', 'memo')]);
        const plan = planAccessMirrorKeys(complex, [
            index('Tags', ['Tags']),
            index('Body', ['Body']),
        ]);

        expect(plan.keys).toEqual([]);
        expect(plan.warnings.join('\n')).toContain('MEMO/OLE');
    });

    it('reports an index that names a column the table does not expose', () => {
        const plan = planAccessMirrorKeys(parent, [index('Broken', ['missing'])]);

        expect(plan.keys).toEqual([]);
        expect(plan.warnings.join('\n')).toContain('missing');
    });
});

describe('planAccessMirrorReferences', () => {
    function plan(relationships: readonly AccessRelationshipDefinition[]) {
        return planAccessMirrorReferences({
            definitions: [parent, child],
            relationships,
            keysByTable: new Map([
                ['parent', planAccessMirrorKeys(parent, [
                    index('PrimaryKey', ['id'], { primaryKey: true, required: true }),
                ]).keys],
                ['child', []],
            ]),
            typeOf,
        });
    }

    it('references an enforced key that a real DuckDB constraint backs', () => {
        const result = plan([relationship()]);

        expect(result.references).toHaveLength(1);
        expect(accessMirrorReferenceSql(result.references[0]!))
            .toBe(`CONSTRAINT "${result.references[0]!.name}" FOREIGN KEY ("pid") REFERENCES "parent" ("id")`);
        expect(result.dependencies.get('child')?.has('parent')).toBe(true);
    });

    it('skips relationships Access does not enforce', () => {
        expect(plan([relationship({ enforced: false })]).references).toEqual([]);
    });

    it('enforces a cascading relationship without its cascade action', () => {
        const result = plan([relationship({ deleteCascade: true })]);

        // DuckDB cannot cascade and the staged writer changes one table at a
        // time, so a cascaded parent delete cannot reach the child rows.  The
        // key is kept so that operation is refused instead of leaving orphans
        // in the written file.
        expect(result.references).toHaveLength(1);
        expect(result.warnings.join('\n')).toContain('enforced without its cascade action');
    });

    it('skips text keys because DuckDB compares them binary', () => {
        const textParent = table('text_parent', [column('code', 'text', false)]);
        const textChild = table('text_child', [column('code', 'text')]);
        const result = planAccessMirrorReferences({
            definitions: [textParent, textChild],
            relationships: [relationship({
                table: 'text_child',
                columns: ['code'],
                foreignTable: 'text_parent',
                foreignColumns: ['code'],
            })],
            keysByTable: new Map([
                ['text_parent', planAccessMirrorKeys(textParent, [
                    index('PrimaryKey', ['code'], { primaryKey: true, required: true }),
                ]).keys],
                ['text_child', []],
            ]),
            typeOf,
        });

        expect(result.references).toEqual([]);
        expect(result.warnings.join('\n')).toContain('ignoring case');
    });

    it('skips a reference to columns without a DuckDB constraint to point at', () => {
        // A text key is enforced by an expression index, which DuckDB does not
        // accept as a foreign-key target.
        const numericParent = table('numeric_parent', [column('id', 'long', false)]);
        const numericChild = table('numeric_child', [column('id', 'long')]);
        const result = planAccessMirrorReferences({
            definitions: [numericParent, numericChild],
            relationships: [relationship({
                table: 'numeric_child',
                columns: ['id'],
                foreignTable: 'numeric_parent',
                foreignColumns: ['id'],
            })],
            keysByTable: new Map([['numeric_parent', []], ['numeric_child', []]]),
            typeOf,
        });

        expect(result.references).toEqual([]);
        expect(result.warnings.join('\n')).toContain('no DuckDB primary key or unique constraint');
    });

    it('adds all-or-nothing NULL guards for composite keys', () => {
        const compositeParent = table('composite_parent', [
            column('a', 'long', false),
            column('b', 'long', false),
        ]);
        const compositeChild = table('composite_child', [
            column('a', 'long'),
            column('b', 'long'),
        ]);
        const result = planAccessMirrorReferences({
            definitions: [compositeParent, compositeChild],
            relationships: [relationship({
                table: 'composite_child',
                columns: ['a', 'b'],
                foreignTable: 'composite_parent',
                foreignColumns: ['a', 'b'],
            })],
            keysByTable: new Map([
                ['composite_parent', planAccessMirrorKeys(compositeParent, [
                    index('PrimaryKey', ['a', 'b'], { primaryKey: true, required: true }),
                ]).keys],
                ['composite_child', []],
            ]),
            typeOf,
        });

        // Access rejects a row where only one key component is NULL; SQL would
        // skip the check entirely, so the mirror adds an explicit guard.
        expect(result.references[0]!.nullGuards).toEqual(['(("a" IS NULL) = ("b" IS NULL))']);
    });

    it('skips self-referencing keys because rows load in file order', () => {
        const selfParent = table('self_ref', [column('id', 'long', false), column('pid', 'long')]);
        const result = planAccessMirrorReferences({
            definitions: [selfParent],
            relationships: [relationship({
                table: 'self_ref',
                columns: ['pid'],
                foreignTable: 'self_ref',
                foreignColumns: ['id'],
            })],
            keysByTable: new Map([
                ['self_ref', planAccessMirrorKeys(selfParent, [
                    index('PrimaryKey', ['id'], { primaryKey: true, required: true }),
                ]).keys],
            ]),
            typeOf,
        });

        expect(result.references).toEqual([]);
        expect(result.warnings.join('\n')).toContain('self-referencing');
    });
});

describe('orderTablesForMirror', () => {
    it('creates referenced tables before the tables that point at them', () => {
        const order = orderTablesForMirror(
            ['child', 'parent', 'standalone'],
            new Map([['child', new Set(['parent'])]]),
        );

        expect(order.indexOf('parent')).toBeLessThan(order.indexOf('child'));
        expect(order).toContain('standalone');
    });

    it('keeps a deterministic order for a cycle instead of dropping tables', () => {
        const order = orderTablesForMirror(
            ['a', 'b', 'c'],
            new Map([
                ['a', new Set(['c'])],
                ['c', new Set(['a'])],
            ]),
        );

        // Neither member of the cycle can be "first", so the depth-first walk
        // picks a deterministic one; every table still appears exactly once and
        // the caller drops the reference that points into the cycle.
        expect(order).toHaveLength(3);
        expect([...order].sort()).toEqual(['a', 'b', 'c']);
        expect(order).toEqual(orderTablesForMirror(
            ['a', 'b', 'c'],
            new Map([
                ['a', new Set(['c'])],
                ['c', new Set(['a'])],
            ]),
        ));
    });
});

describe('buildAccessMirrorTableSql', () => {
    const schema = {
        definition: parent,
        keys: planAccessMirrorKeys(parent, [
            index('PrimaryKey', ['id'], { primaryKey: true, required: true }),
        ]).keys,
        references: [],
        requiredColumns: new Set<string>(),
    };

    it('keeps defaults, collation and NOT NULL in the CREATE TABLE it emits', () => {
        const sql = buildAccessMirrorTableSql(schema, {
            includeValidation: true,
            includeKeys: true,
            includeReferences: false,
        });

        expect(sql).toContain('"id" INTEGER NOT NULL');
        expect(sql).toContain('"code" VARCHAR COLLATE NOCASE');
        expect(sql).toMatch(/CONSTRAINT "__access_key_[0-9a-f]+" PRIMARY KEY \("id"\)/);
    });

    it('drops the key layer without dropping the column NOT NULL flags', () => {
        const withoutKeys = buildAccessMirrorTableSql(schema, {
            includeValidation: false,
            includeKeys: false,
            includeReferences: false,
        });

        expect(withoutKeys).not.toContain('PRIMARY KEY');
        // `id` is Required in the file itself, so it stays NOT NULL even when
        // the key constraint had to be dropped.
        expect(withoutKeys).toContain('"id" INTEGER NOT NULL');
    });

    it('adds the all-or-nothing NULL guard next to a composite foreign key', () => {
        const compositeParent = table('composite_parent', [
            column('a', 'long', false),
            column('b', 'long', false),
        ]);
        const compositeChild = table('composite_child', [
            column('a', 'long'),
            column('b', 'long'),
        ]);
        const keysByTable = new Map([
            ['composite_parent', planAccessMirrorKeys(compositeParent, [
                index('PrimaryKey', ['a', 'b'], { primaryKey: true, required: true }),
            ]).keys],
            ['composite_child', []],
        ]);
        const references = planAccessMirrorReferences({
            definitions: [compositeParent, compositeChild],
            relationships: [relationship({
                table: 'composite_child',
                columns: ['a', 'b'],
                foreignTable: 'composite_parent',
                foreignColumns: ['a', 'b'],
            })],
            keysByTable,
            typeOf,
        });
        const sql = buildAccessMirrorTableSql({
            definition: compositeChild,
            keys: [],
            references: references.references,
            requiredColumns: new Set<string>(),
        }, {
            includeValidation: false,
            includeKeys: true,
            includeReferences: true,
        });

        expect(sql).toContain('FOREIGN KEY ("a", "b") REFERENCES "composite_parent" ("a", "b")');
        expect(sql).toContain('CHECK (("a" IS NULL) = ("b" IS NULL))');
    });
});
