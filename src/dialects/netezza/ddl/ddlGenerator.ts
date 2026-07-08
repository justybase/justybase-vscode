/**
 * DDL Generator - Main Entry Point
 * Orchestrates DDL generation for different object types
 */

import { DDLResult } from './types';
import { createConnectionFromDetails } from './helpers';
import { generateTableDDL } from './tableDDL';
import { generateViewDDL } from './viewDDL';
import { generateProcedureDDL } from './procedureDDL';
import { generateExternalTableDDL } from './externalTableDDL';
import { generateSynonymDDL } from './synonymDDL';
import { NzConnection, ConnectionDetails } from '../../../types';

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
        } else {
            // For other object types, return placeholder
            const ddlCode = `-- DDL generation for ${objectType} not yet implemented
-- Object: ${database}.${schema}.${objectName}
-- Type: ${objectType}
--
-- This feature can be extended to support:
-- - FUNCTION: Query _V_FUNCTION system table
-- - AGGREGATE: Query _V_AGGREGATE system table
`;
            return {
                success: true,
                ddlCode,
                objectInfo: { database, schema, objectName, objectType },
                note: `${objectType} DDL generation not yet implemented`
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

