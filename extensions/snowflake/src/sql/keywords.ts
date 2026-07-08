import {
  BASE_SQL_COMPLETION_KEYWORDS,
  BASE_SQL_FORMATTER_PROFILE,
  extendFormatterProfile,
  mergeUniqueStrings
} from '../../../../src/sql/authoring/baseProfiles';

/**
 * Snowflake-specific SQL completion keyword overlays
 * These are keywords unique to Snowflake that extend the base SQL keywords
 */
export const SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS = [
  // DDL keywords
  'CLONE',
  'CLUSTER',
  'COPY',
  'STAGE',
  'FILE_FORMAT',
  'PIPE',
  'STREAM',
  'TASK',
  
  // DML keywords
  'MERGE',
  'INSERT OVERWRITE',
  'UPSERT',
  
  // Query keywords
  'QUALIFY',
  'PIVOT',
  'UNPIVOT',
  'LATERAL',
  
  // Time travel
  'AT',
  'BEFORE',
  'TIMESTAMP',
  'OFFSET',
  
  // Session keywords
  'WAREHOUSE',
  'DATABASE',
  'SCHEMA',
  'ROLE',
  
  // Snowflake-specific clauses
  'CLUSTER BY',
  'COPY INTO',
  'TARGET_LAG',
  'SCHEDULE',
  'API_INTEGRATION',
  'DATA_RETENTION_TIME_IN_DAYS',
  'MAX_DATA_EXTENSION_TIME_IN_DAYS',
  'CHANGE_TRACKING',
  'DEFAULT_DDL_COLLATION',
  'COMMENT',
  'AUTOINCREMENT',
  'IDENTITY',
  'ORDER',
  'NOCACHE',
  'NOCYCLE',
  'NOORDER',
  'SALT',
  'ENCRYPT',
  'NOEXPIRE',
  'PURGE',
  'FORCE',
  'PATTERN',
  'VALIDATION_MODE',
  'MATCH_BY_COLUMN_NAME',
  'TRANSFORM',
  'USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE',
  'ALLOW_WRITES',
  'SHOW_INITIAL_ROWS',
  'ORC_COMPRESS',
  'PARQUET_COMPRESS',
  'AVRO_COMPRESS',
  'JSON_COMPRESS',
  'CSV_COMPRESS',
  'XML_COMPRESS',
  'BINARY_COMPRESS',
  'BINARY_AS_TEXT',
  'PRESERVE_SPACE',
  'TRIM_SPACE',
  'SKIP_BLANK_LINES',
  'RECORD_DELIMITER',
  'FIELD_DELIMITER',
  'ESCAPE_CHAR',
  'ESCAPE_UNENCLOSED_FIELD',
  'DATE_FORMAT',
  'TIME_FORMAT',
  'TIMESTAMP_FORMAT',
  'BINARY_FORMAT',
  'FIELD_OPTIONALLY_ENCLOSED_BY',
  'NULL_IF',
  'EMPTY_FIELD_AS_NULL',
  'SKIP_HEADER',
  'ENCODING',
  'COMPRESSION',
  'TRUNCATECOLUMNS',
  'SIZE_LIMIT',
  'RETURN_FAILED_ONLY',
  'CREDENTIALS',
  'STORAGE_INTEGRATION',
  'ENCRYPTION',
  'MASTER_KEY',
  'NOTIFICATION_INTEGRATION',
  'AUTO_INGEST',
  'AWS_SNS_TOPIC',
  'AZURE_STORAGE_QUEUE_PRIMARY_URI',
  'AZURE_TENANT_ID',
  'GCP_PUBSUB_SUBSCRIPTION_NAME'
] as const;

/**
 * Complete list of Snowflake SQL completion keywords
 * Combines base SQL keywords with Snowflake-specific extensions
 */
export const SNOWFLAKE_COMPLETION_KEYWORDS = mergeUniqueStrings(
  BASE_SQL_COMPLETION_KEYWORDS,
  SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS
);

/**
 * Snowflake SQL formatter profile
 * Extends the base formatter with Snowflake-specific formatting rules
 */
export const snowflakeFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
  keywords: SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS as unknown as string[],
  // Snowflake-specific clause keywords that should trigger newlines
  newlineBeforeKeywords: [
    'QUALIFY',
    'PIVOT',
    'UNPIVOT',
    'CLUSTER BY',
    'COPY INTO'
  ]
});
