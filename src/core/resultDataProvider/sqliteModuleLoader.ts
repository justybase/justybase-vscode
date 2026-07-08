import type { DatabaseSync } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | undefined;

export function loadNodeSqliteModule(): SqliteModule {
    if (sqliteModule) {
        return sqliteModule;
    }

     
    sqliteModule = require('node:sqlite') as SqliteModule;
    return sqliteModule;
}

export type { DatabaseSync };
