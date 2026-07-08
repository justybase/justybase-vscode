/**
 * Unit tests for schema command aggregation entry points.
 */

jest.mock('../commands/schema/copyCommands', () => ({
    registerCopyCommands: jest.fn(() => [{ dispose: jest.fn() }])
}));
jest.mock('../commands/schema/tableCommands', () => ({
    registerTableCommands: jest.fn(() => [{ dispose: jest.fn() }, { dispose: jest.fn() }])
}));
jest.mock('../commands/schema/maintenanceCommands', () => ({
    registerMaintenanceCommands: jest.fn(() => [])
}));
jest.mock('../commands/schema/ddlCommands', () => ({
    registerDDLCommands: jest.fn(() => [{ dispose: jest.fn() }])
}));
jest.mock('../commands/schema/sqliteCommands', () => ({
    registerSqliteCommands: jest.fn(() => [{ dispose: jest.fn() }])
}));
jest.mock('../commands/schema/viewCommands', () => ({
    registerViewCommands: jest.fn(() => [{ dispose: jest.fn() }])
}));
jest.mock('../commands/schema/utilityCommands', () => ({
    registerUtilityCommands: jest.fn(() => [{ dispose: jest.fn() }, { dispose: jest.fn() }])
}));

import { registerSchemaCommands } from '../commands/schema/schemaCommands';
import { registerSchemaCommands as registerSchemaCommandsCompat } from '../commands/schemaCommands';

describe('schema command aggregation', () => {
    it('combines all command registration arrays in main entry point', () => {
        const deps = {} as Parameters<typeof registerSchemaCommands>[0];
        const result = registerSchemaCommands(deps);
        expect(result).toHaveLength(8);
        result.forEach(disposable => {
            expect(typeof disposable.dispose).toBe('function');
        });
    });

    it('exposes backward-compatible re-export entry point', () => {
        const deps = {} as Parameters<typeof registerSchemaCommandsCompat>[0];
        const result = registerSchemaCommandsCompat(deps);
        expect(result).toHaveLength(8);
    });
});
