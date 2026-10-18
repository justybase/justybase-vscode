import {
    buildSqliteTableRebuildScript,
    retargetSqliteCreateTableDdl,
} from '../commands/schema/sqliteRebuild';

describe('SQLite table rebuild SQL', () => {
    it('retargets the edited CREATE TABLE while retaining the original table name for validation', () => {
        const original = 'CREATE TABLE "REPORTING"."orders" ("id" INTEGER PRIMARY KEY, "note" TEXT);';
        const edited = 'CREATE TABLE "REPORTING"."orders" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL DEFAULT \'\');';
        expect(retargetSqliteCreateTableDdl(original, edited, '"REPORTING"."__JB_REBUILD_1"'))
            .toBe('CREATE TABLE "REPORTING"."__JB_REBUILD_1" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL DEFAULT \'\');');
        expect(() => retargetSqliteCreateTableDdl(original, edited.replace('"orders"', '"other"'), '"REPORTING"."temp"'))
            .toThrow('Keep the original table name');
        expect(() => retargetSqliteCreateTableDdl(original, `${edited} DROP TABLE "REPORTING"."orders";`, '"REPORTING"."temp"'))
            .toThrow('one CREATE TABLE statement');
        expect(() => retargetSqliteCreateTableDdl('CREATE VIRTUAL TABLE "orders" USING fts5(note);', 'CREATE VIRTUAL TABLE "orders" USING fts5(note);', '"temp"'))
            .toThrow('one CREATE TABLE statement');
    });

    it('prepares a checked rebuild transaction and preserves autoincrement state and dependent DDL', () => {
        const script = buildSqliteTableRebuildScript({
            schemaName: 'REPORTING', tableName: 'orders', qualifiedTableName: '"REPORTING"."orders"',
            qualifiedTemporaryName: '"REPORTING"."__JB_REBUILD_1"', sequenceBackupName: '__JB_SEQ_1',
            columns: ['id', 'note'], dependentDdl: ['CREATE INDEX "REPORTING"."ix_orders_note" ON "REPORTING"."orders" ("note")'],
            createTableDdl: 'CREATE TABLE "REPORTING"."__JB_REBUILD_1" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "note" TEXT NOT NULL);',
            preserveAutoincrement: true,
        });
        expect(script).toContain('PRAGMA foreign_keys = OFF;\nBEGIN IMMEDIATE;');
        expect(script).toContain('CREATE TEMP TABLE "__JB_SEQ_1" (seq INTEGER);');
        expect(script).toContain('INSERT INTO "REPORTING"."__JB_REBUILD_1" ("id", "note") SELECT "id", "note" FROM "REPORTING"."orders";');
        expect(script).toContain('ALTER TABLE "REPORTING"."__JB_REBUILD_1" RENAME TO "orders";');
        expect(script).toContain('CREATE INDEX "REPORTING"."ix_orders_note" ON "REPORTING"."orders" ("note");');
        expect(script).toContain('PRAGMA "REPORTING".foreign_key_check;');
        expect(script).toContain('-- COMMIT;');
    });

    it('copies all columns when no explicit mapping is available', () => {
        const script = buildSqliteTableRebuildScript({
            schemaName: 'main', tableName: 't', qualifiedTableName: '"main"."t"',
            qualifiedTemporaryName: '"main"."__JB_REBUILD_X"', sequenceBackupName: '__JB_SEQ_X',
            columns: [], dependentDdl: [],
            createTableDdl: 'CREATE TABLE "main"."__JB_REBUILD_X" ("id" INTEGER);',
            preserveAutoincrement: false,
        });
        expect(script).toContain('INSERT INTO "main"."__JB_REBUILD_X" SELECT * FROM "main"."t";');
        expect(script).not.toContain('sqlite_sequence');
    });
});
