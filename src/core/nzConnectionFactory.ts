/**
 * Compatibility wrapper around the database-agnostic connection factory.
 * Existing Netezza call sites can continue to import this module while
 * the runtime moves to dialect-based connection registration.
 */

import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionConstructor,
    DatabaseDataReader
} from '../contracts/database';
import { createDatabaseConnection } from './connectionFactory';

export type NzConnectionConfig = DatabaseConnectionConfig;
export type NzDataReader = DatabaseDataReader;
export type NzCommand = DatabaseCommand;
export type NzConnection = DatabaseConnection;
export type NzConnectionConstructor = DatabaseConnectionConstructor;

/**
 * Helper function to create NzConnection instance
 * Provides proper typing for the dynamically loaded driver
 */
export function createNzConnection(config: NzConnectionConfig): NzConnection {
    return createDatabaseConnection(config, 'netezza');
}
