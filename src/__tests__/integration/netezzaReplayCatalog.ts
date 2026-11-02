import type { NzConnection } from '@justybase/netezza-driver';
import type { DatabaseForeignKeyColumnReference } from '../../contracts/database';
import type { ReplayCatalog, ReplayCatalogColumn, ReplayCatalogTable } from '../../knowledge/replayCatalog';
import { quoteNetezzaLiteral, readRows } from './netezzaLiveTestHarness';

/**
 * Read an identifier-only replay catalog (tables, columns and their types, PK
 * flags, declared FKs) for one schema of the live development Netezza database.
 */
export async function loadNetezzaReplayCatalog(
    connection: NzConnection,
    database: string,
    schema: string,
): Promise<ReplayCatalog> {
    const schemaLiteral = quoteNetezzaLiteral(schema.toUpperCase());
    const tables = new Map<string, ReplayCatalogTable>();
    const columns = new Map<string, ReplayCatalogColumn>();
    const columnRows = await readRows(connection, `
        SELECT C.NAME, C.ATTNAME, C.FORMAT_TYPE
        FROM _V_RELATION_COLUMN C
        JOIN _V_TABLE T ON T.OBJID = C.OBJID
        WHERE C.SCHEMA = ${schemaLiteral}
        ORDER BY C.NAME, C.ATTNUM`);
    for (const [tableName, columnName, formatType] of columnRows) {
        const name = String(tableName);
        let table = tables.get(name);
        if (!table) {
            table = { schema: schema.toUpperCase(), name, columns: [] };
            tables.set(name, table);
        }
        const column: ReplayCatalogColumn = {
            name: String(columnName),
            ...(formatType ? { type: String(formatType) } : {}),
        };
        table.columns.push(column);
        columns.set(`${name}|${column.name}`, column);
    }

    const keyRows = await readRows(connection, `
        SELECT RELATION, CONSTRAINTNAME, CONTYPE, CONSEQ, ATTNAME, PKSCHEMA, PKRELATION, PKATTNAME
        FROM _V_RELATION_KEYDATA
        WHERE SCHEMA = ${schemaLiteral} AND CONTYPE IN ('p', 'f')
        ORDER BY RELATION, CONSTRAINTNAME, CONSEQ`);
    for (const [relation, constraint, type, sequence, attribute, pkSchema, pkRelation, pkAttribute] of keyRows) {
        const column = columns.get(`${String(relation)}|${String(attribute)}`);
        if (!column) {
            continue;
        }
        if (type === 'p') {
            column.isPk = true;
            continue;
        }
        column.isFk = true;
        const reference: DatabaseForeignKeyColumnReference = {
            fromDatabase: database,
            fromSchema: schema.toUpperCase(),
            fromTable: String(relation),
            fromColumn: column.name,
            toDatabase: database,
            toSchema: String(pkSchema),
            toTable: String(pkRelation),
            toColumn: String(pkAttribute),
            constraintName: String(constraint),
            ordinalPosition: Number(sequence),
        };
        (column.references ??= []).push(reference);
    }
    return {
        database,
        defaultSchema: schema.toUpperCase(),
        tables: [...tables.values()],
    };
}
