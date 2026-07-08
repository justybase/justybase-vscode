import type { DatabaseDialect } from '../contracts/database';
import { ensureBuiltInDialectsRegistered } from '../dialects';
import {
    listRegisteredDatabaseDialects,
    registerDatabaseDialect
} from '../core/factories/databaseDialectRegistry';

export interface JustyBaseLiteApi {
    readonly version: 1;
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
    listRegisteredDatabaseDialects(): readonly DatabaseDialect[];
}

export function createJustyBaseLiteApi(): JustyBaseLiteApi {
    ensureBuiltInDialectsRegistered();

    return {
        version: 1,
        registerDatabaseDialect,
        listRegisteredDatabaseDialects
    };
}
