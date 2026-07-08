/**
 * Snowflake SQL Authoring Module
 * 
 * Exports all Snowflake SQL authoring components:
 * - Keywords and formatter profile
 * - Data types and type utilities
 * - Built-in functions, special values, and system columns
 * - SQL authoring profile
 * 
 * @module snowflake/sql
 */

export * from './keywords';
export * from './dataTypes';
export * from './builtins';
export * from './signatures';
export { snowflakeSqlAuthoring } from './authoring';
