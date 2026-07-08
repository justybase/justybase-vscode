import { DatabaseCapabilities, DatabaseDialect, DatabaseKind } from '../../contracts/database';
import { validateDialectTraits } from '../dialectTraitsValidator';
import { registerDatabaseSqlAuthoring } from '../sqlAuthoringRegistry';

class DatabaseDialectRegistry {
    private readonly _dialects = new Map<DatabaseKind, DatabaseDialect>();

    register(dialect: DatabaseDialect): DatabaseDialect {
        const validationErrors = validateDialectTraits(dialect.traits);
        if (validationErrors.length > 0) {
            throw new Error(
                `Invalid traits for dialect '${dialect.kind}':\n${validationErrors.map(error => `  - ${error}`).join('\n')}`
            );
        }

        const existing = this._dialects.get(dialect.kind);
        if (existing) {
            return existing;
        }

        this._dialects.set(dialect.kind, dialect);
        registerDatabaseSqlAuthoring(dialect.kind, dialect.sqlAuthoring);
        return dialect;
    }

    get(kind: DatabaseKind): DatabaseDialect | undefined {
        return this._dialects.get(kind);
    }

    getRequired(kind: DatabaseKind): DatabaseDialect {
        const dialect = this.get(kind);
        if (!dialect) {
            throw new Error(`No database dialect registered for '${kind}'`);
        }
        return dialect;
    }

    list(): readonly DatabaseDialect[] {
        return Array.from(this._dialects.values());
    }

    clear(): void {
        this._dialects.clear();
    }
}

const registry = new DatabaseDialectRegistry();

export function registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect {
    return registry.register(dialect);
}

export function getDatabaseDialectByKind(kind: DatabaseKind): DatabaseDialect | undefined {
    return registry.get(kind);
}

export function getRequiredDatabaseDialect(kind: DatabaseKind): DatabaseDialect {
    return registry.getRequired(kind);
}

export function getDatabaseCapabilitiesByKind(kind: DatabaseKind): DatabaseCapabilities {
    return getRequiredDatabaseDialect(kind).capabilities;
}

export function listRegisteredDatabaseDialects(): readonly DatabaseDialect[] {
    return registry.list();
}

export function __TEST_ONLY_resetDatabaseDialectRegistry(): void {
    registry.clear();
}
