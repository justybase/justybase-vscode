/**
 * DDL Generator - Main Entry Point
 * Orchestrates DDL generation for different object types
 */

import type { DDLResult } from './types';
import { createConnectionFromDetails } from './helpers';
import { generateTableDDL } from './tableDDL';
import { generateViewDDL } from './viewDDL';
import { generateProcedureDDL } from './procedureDDL';
import { generateExternalTableDDL } from './externalTableDDL';
import { generateSynonymDDL } from './synonymDDL';
import { generateMaterializedViewDDL, generateRoutineDDL, generateSequenceDDL } from './catalogObjectDDL';
import type { NzConnection, ConnectionDetails } from '../../../types';

/**
 * Generate DDL code for a database object
 */
export async function generateDDL(
    connectionDetails: ConnectionDetails,
    database: string,
    schema: string,
    objectName: string,
    objectType: string
): Promise<DDLResult> {
    let connection: NzConnection | null = null;

    try {
        // Connect to the specific database where the object resides.
        // This is necessary for retrieving view definitions and procedure source correctly.
        connection = await createConnectionFromDetails(connectionDetails, database);

        const upperType = objectType.toUpperCase();

        if (upperType === 'TABLE') {
            const ddlCode = await generateTableDDL(connection, database, schema, objectName);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else if (upperType === 'VIEW') {
            const ddlCode = await generateViewDDL(connection, database, schema, objectName);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else if (upperType === 'PROCEDURE') {
            const ddlCode = await generateProcedureDDL(connection, database, schema, objectName);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else if (upperType === 'EXTERNAL TABLE') {
            const ddlCode = await generateExternalTableDDL(connection, database, schema, objectName);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else if (upperType === 'SYNONYM') {
            const ddlCode = await generateSynonymDDL(connection, database, schema, objectName);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else if (upperType === 'SEQUENCE' || upperType === 'MATERIALIZED VIEW' || upperType === 'FUNCTION' || upperType === 'AGGREGATE') {
            const ddlCode = upperType === 'SEQUENCE'
                ? await generateSequenceDDL(connection, database, schema, objectName)
                : upperType === 'MATERIALIZED VIEW'
                    ? await generateMaterializedViewDDL(connection, database, schema, objectName)
                    : await generateRoutineDDL(connection, database, schema, objectName, upperType);
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType }
            };
        } else {
            return {
                success: false,
                error: `DDL generation is not available for ${objectType} objects.`
            };
        }
    } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        return {
            success: false,
            error: `DDL generation error: ${errorMsg}`
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors
            }
        }
    }
}

