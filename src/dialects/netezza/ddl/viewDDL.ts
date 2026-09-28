/**
 * DDL Generator - View DDL Generation
 */

import { executeQueryHelper } from './helpers';
import { buildNetezzaViewDdl } from '@justybase/designer-core';
import type { NzConnection } from '../../../types';
import { NZ_SYSTEM_VIEWS } from '../metadata/systemQueries';
import { getColumns, getViewComment } from './metadata';
import type { ColumnInfo } from './types';

/**
 * Build view DDL from definition string
 */
export function buildViewDDLFromCache(
    database: string,
    schema: string,
    viewName: string,
    definition: string,
    viewComment: string | null = null,
    columns: readonly ColumnInfo[] = [],
): string {
    return buildNetezzaViewDdl(database, schema, viewName, definition, viewComment, columns);
}

/**
 * Generate DDL code for creating a view in Netezza
 */
export async function generateViewDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    viewName: string
): Promise<string> {
    const sql = `
        SELECT 
            SCHEMA,
            VIEWNAME,
            DEFINITION,
            OBJID::INT
        FROM ${database.toUpperCase()}..${NZ_SYSTEM_VIEWS.VIEW}
        WHERE DATABASE = '${database.toUpperCase()}'
            AND SCHEMA = '${schema.toUpperCase()}'
            AND VIEWNAME = '${viewName.toUpperCase()}'
    `;

    interface ViewRow {
        SCHEMA: string;
        VIEWNAME: string;
        DEFINITION: string;
        OBJID: number;
    }
    const result = await executeQueryHelper<ViewRow>(connection, sql);
    const rows = result;

    if (rows.length === 0) {
        throw new Error(`View ${database}.${schema}.${viewName} not found`);
    }

    const row = rows[0];
    const columns = await getColumns(connection, database, schema, viewName);
    const viewComment = await getViewComment(connection, database, schema, viewName);
    return buildViewDDLFromCache(database, schema, viewName, row.DEFINITION, viewComment, columns);
}
