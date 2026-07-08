/**
 * Netezza External Table Templates
 * Provides templates for creating external tables with various options
 * Based on IBM Netezza documentation:
 * https://www.ibm.com/docs/en/netezza?topic=et-create-external-table-command-2
 */

export interface ExternalTableTemplate {
    id: string;
    name: string;
    description: string;
    category: 'basic' | 'advanced';
    generate: (params: ExternalTableParams) => string;
}

function quote(name: string): string {
    if (!name) return '""';
    return `"${name.replace(/"/g, '""')}"`;
}

export interface ExternalTableParams {
    database: string;
    schema: string;
    tableName: string;
    filePath: string;
    columns: string;
    recordDelimiter?: string;
    delimiter?: string;
    nullValueAs?: string;
    dateStyle?: string;
    timeStyle?: string;
    quotedValue?: string;
    skipRows?: string;
    headerRow?: boolean;
    batchSize?: string;
    compression?: string;
    format?: string;
    quoting?: string;
    escapeChar?: string;
    maxErrors?: string;
    recordSize?: string;
    logFile?: string;
    withHeader?: boolean;
    noTruncate?: boolean;
    skew?: string;
}

function isPositiveInteger(value: string): boolean {
    return /^\d+$/.test(value);
}

export function validateExternalTableParams(params: ExternalTableParams, mode: 'basic' | 'advanced'): string[] {
    const errors: string[] = [];

    if (!params.database || !params.schema || !params.tableName) {
        errors.push('Database, schema, and table name are required.');
    }
    if (!params.filePath || params.filePath.trim().length === 0) {
        errors.push('File path is required.');
    }
    if (!params.columns || params.columns.trim().length === 0) {
        errors.push('Column definitions are required.');
    }

    if (params.skipRows !== undefined && params.skipRows.trim().length > 0 && !isPositiveInteger(params.skipRows.trim())) {
        errors.push('SKIPROWS must be a non-negative integer.');
    }

    if (params.maxErrors !== undefined && params.maxErrors.trim().length > 0 && !isPositiveInteger(params.maxErrors.trim())) {
        errors.push('MAXERRORS must be a non-negative integer.');
    }

    if (params.recordSize !== undefined && params.recordSize.trim().length > 0 && !isPositiveInteger(params.recordSize.trim())) {
        errors.push('RECORDSIZE must be a positive integer.');
    }

    if (params.quotedValue && !['YES', 'NO'].includes(params.quotedValue.toUpperCase())) {
        errors.push('QUOTEDVALUE must be YES or NO.');
    }

    if (params.compression && !['AUTO', 'GZIP', 'BZIP2', 'NONE'].includes(params.compression.toUpperCase())) {
        errors.push('COMPRESSION must be one of: AUTO, GZIP, BZIP2, NONE.');
    }

    if (mode === 'advanced' && params.format && params.format.toUpperCase() === 'BCP' && params.delimiter) {
        errors.push('BCP format should not be combined with DELIMITER.');
    }

    return errors;
}

export const externalTableTemplates: ExternalTableTemplate[] = [
    // ============ BASIC TEMPLATES ============
    {
        id: 'basic-csv-simple',
        name: 'Basic - CSV File',
        description: 'Simple external table for CSV files with default options',
        category: 'basic',
        generate: (params: ExternalTableParams) => {
            return `-- External table for CSV file
CREATE EXTERNAL TABLE ${quote(params.database)}.${quote(params.schema)}.${quote(params.tableName)}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    SKIPROWS ${params.skipRows || '0'}
    ${params.withHeader ? 'HEADER' : ''}
);
`;
        }
    },
    {
        id: 'basic-delimited',
        name: 'Basic - Delimited File',
        description: 'External table for delimited text files (tab, pipe, etc.)',
        category: 'basic',
        generate: (params: ExternalTableParams) => {
            const delimiter = params.delimiter || '\t';
            return `-- External table for delimited file
CREATE EXTERNAL TABLE ${quote(params.database)}.${quote(params.schema)}.${quote(params.tableName)}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${delimiter}'
    ${params.withHeader ? 'HEADER' : ''}
);
`;
        }
    },
    {
        id: 'basic-fixed-width',
        name: 'Basic - Fixed Width File',
        description: 'External table for fixed-width text files',
        category: 'basic',
        generate: (params: ExternalTableParams) => {
            return `-- External table for fixed-width file
CREATE EXTERNAL TABLE ${quote(params.database)}.${quote(params.schema)}.${quote(params.tableName)}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    FIXEDWIDTH
);
`;
        }
    },

    // ============ ADVANCED TEMPLATES ============
    {
        id: 'advanced-full-options',
        name: 'Advanced - Full Options',
        description: 'Complete external table with all available options',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table with full options
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    ${params.recordDelimiter ? `RECORDDELIMITER '${params.recordDelimiter}'` : ''}
    DELIMITER '${params.delimiter || ','}'
    ${params.nullValueAs ? `NULLVALUEAS '${params.nullValueAs}'` : ''}
    ${params.dateStyle ? `DATESTYLE '${params.dateStyle}'` : ''}
    ${params.timeStyle ? `TIMESTYLE '${params.timeStyle}'` : ''}
    ${params.quotedValue ? `QUOTEDVALUE ${params.quotedValue}` : ''}
    SKIPROWS ${params.skipRows || '0'}
    ${params.withHeader ? 'HEADER' : ''}
    ${params.batchSize ? `BATCHSIZE ${params.batchSize}` : ''}
    ${params.compression ? `COMPRESSION ${params.compression}` : ''}
    ${params.format ? `FORMAT ${params.format}` : ''}
    ${params.quoting ? `QUOTING ${params.quoting}` : ''}
    ${params.escapeChar ? `ESCAPECHAR '${params.escapeChar}'` : ''}
    ${params.maxErrors ? `MAXERRORS ${params.maxErrors}` : ''}
    ${params.recordSize ? `RECORDSIZE ${params.recordSize}` : ''}
    ${params.logFile ? `LOG '${params.logFile}'` : ''}
);
`;
        }
    },
    {
        id: 'advanced-skip-header',
        name: 'Advanced - Skip Header Rows',
        description: 'External table that skips header rows in the file',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            const skipRows = params.skipRows || '1';
            return `-- External table skipping header rows
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    SKIPROWS ${skipRows}
    HEADER
);
`;
        }
    },
    {
        id: 'advanced-error-handling',
        name: 'Advanced - Error Handling',
        description: 'External table with max errors and logging configuration',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table with error handling
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    ${params.maxErrors ? `MAXERRORS ${params.maxErrors}` : 'MAXERRORS 10'}
    ${params.logFile ? `LOG '${params.logFile}'` : "LOG '${params.filePath}.log'"}
);
`;
        }
    },
    {
        id: 'advanced-compressed',
        name: 'Advanced - Compressed File',
        description: 'External table for compressed files (gzip, bzip2)',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table for compressed file
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    ${params.compression || 'COMPRESSION GZIP'}
);
`;
        }
    },
    {
        id: 'advanced-null-handling',
        name: 'Advanced - Null Value Handling',
        description: 'External table with custom null value representation',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            const nullValue = params.nullValueAs || 'NULL';
            return `-- External table with custom null handling
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    NULLVALUEAS '${nullValue}'
);
`;
        }
    },
    {
        id: 'advanced-quoted-values',
        name: 'Advanced - Quoted Values',
        description: 'External table handling quoted string values',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table with quoted value handling
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    QUOTEDVALUE ${params.quotedValue || 'YES'}
);
`;
        }
    },
    {
        id: 'advanced-date-time',
        name: 'Advanced - Date/Time Style',
        description: 'External table with specific date and time format styles',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table with date/time style configuration
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    ${params.dateStyle ? `DATESTYLE '${params.dateStyle}'` : "DATESTYLE 'MDY'"}
    ${params.timeStyle ? `TIMESTYLE '${params.timeStyle}'` : "TIMESTYLE '24HR'"}
);
`;
        }
    },
    {
        id: 'advanced-record-delimiter',
        name: 'Advanced - Custom Record Delimiter',
        description: 'External table with custom record (line) delimiter',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            const recordDelim = params.recordDelimiter || '\\n';
            return `-- External table with custom record delimiter
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    RECORDDELIMITER '${recordDelim}'
    DELIMITER '${params.delimiter || ','}'
);
`;
        }
    },
    {
        id: 'advanced-fixed-width-detailed',
        name: 'Advanced - Fixed Width Detailed',
        description: 'External table for fixed-width files with record size',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table for fixed-width file with detailed options
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    FIXEDWIDTH
    ${params.recordSize ? `RECORDSIZE ${params.recordSize}` : ''}
    ${params.maxErrors ? `MAXERRORS ${params.maxErrors}` : ''}
    ${params.logFile ? `LOG '${params.logFile}'` : ''}
);
`;
        }
    },
    {
        id: 'advanced-bcp-format',
        name: 'Advanced - BCP Format',
        description: 'External table using BCP (SQL Server) format',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table in BCP format
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    FORMAT 'BCP'
    ${params.quoting ? `QUOTING ${params.quoting}` : ''}
);
`;
        }
    },
    {
        id: 'advanced-s3',
        name: 'Advanced - S3 Location',
        description: 'External table pointing to S3 location',
        category: 'advanced',
        generate: (params: ExternalTableParams) => {
            return `-- External table for S3 location
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${params.delimiter || ','}'
    ${params.maxErrors ? `MAXERRORS ${params.maxErrors}` : ''}
);
`;
        }
    }
];

/**
 * Get templates grouped by category
 */
export function getExternalTableTemplatesByCategory(): { basic: ExternalTableTemplate[]; advanced: ExternalTableTemplate[] } {
    return {
        basic: externalTableTemplates.filter(t => t.category === 'basic'),
        advanced: externalTableTemplates.filter(t => t.category === 'advanced')
    };
}

/**
 * Get template by ID
 */
export function getExternalTableTemplateById(id: string): ExternalTableTemplate | undefined {
    return externalTableTemplates.find(t => t.id === id);
}

/**
 * Generate external table SQL with Basic wizard inputs
 */
export function generateBasicExternalTableSQL(params: ExternalTableParams): string {
    const errors = validateExternalTableParams(params, 'basic');
    if (errors.length > 0) {
        throw new Error(errors.join(' '));
    }

    const delimiter = params.delimiter || ',';
    const skipRows = params.skipRows || '0';

    return `-- External table for ${params.filePath}
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    DATAOBJECT ('${params.filePath}')
    DELIMITER '${delimiter}'
    SKIPROWS ${skipRows}
    ${params.withHeader ? 'HEADER' : ''}
);
`;
}

/**
 * Generate external table SQL with Advanced wizard inputs
 */
export function generateAdvancedExternalTableSQL(params: ExternalTableParams): string {
    const errors = validateExternalTableParams(params, 'advanced');
    if (errors.length > 0) {
        throw new Error(errors.join(' '));
    }

    const parts: string[] = [];

    parts.push(`DATAOBJECT ('${params.filePath}')`);

    if (params.recordDelimiter) {
        parts.push(`RECORDDELIMITER '${params.recordDelimiter}'`);
    }
    if (params.delimiter) {
        parts.push(`DELIMITER '${params.delimiter}'`);
    }
    if (params.nullValueAs) {
        parts.push(`NULLVALUEAS '${params.nullValueAs}'`);
    }
    if (params.dateStyle) {
        parts.push(`DATESTYLE '${params.dateStyle}'`);
    }
    if (params.timeStyle) {
        parts.push(`TIMESTYLE '${params.timeStyle}'`);
    }
    if (params.quotedValue) {
        parts.push(`QUOTEDVALUE ${params.quotedValue}`);
    }
    if (params.skipRows) {
        parts.push(`SKIPROWS ${params.skipRows}`);
    }
    if (params.withHeader) {
        parts.push('HEADER');
    }
    if (params.batchSize) {
        parts.push(`BATCHSIZE ${params.batchSize}`);
    }
    if (params.compression) {
        parts.push(`COMPRESSION ${params.compression}`);
    }
    if (params.format) {
        parts.push(`FORMAT ${params.format}`);
    }
    if (params.quoting) {
        parts.push(`QUOTING ${params.quoting}`);
    }
    if (params.escapeChar) {
        parts.push(`ESCAPECHAR '${params.escapeChar}'`);
    }
    if (params.maxErrors) {
        parts.push(`MAXERRORS ${params.maxErrors}`);
    }
    if (params.recordSize) {
        parts.push(`RECORDSIZE ${params.recordSize}`);
    }
    if (params.logFile) {
        parts.push(`LOG '${params.logFile}'`);
    }
    if (params.noTruncate) {
        parts.push('NOTRUNCATE');
    }

    return `-- External table with advanced options
CREATE EXTERNAL TABLE ${params.database}.${params.schema}.${params.tableName}
(
    ${params.columns}
)
USING (
    ${parts.join('\n    ')}
);
`;
}
