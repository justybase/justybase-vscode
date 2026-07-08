/**
 * Unit tests for commands/schema barrel exports.
 */

import * as schemaCommands from '../commands/schema';

describe('commands/schema barrel exports', () => {
    it('exports the main registration API and helpers', () => {
        expect(typeof schemaCommands.registerSchemaCommands).toBe('function');
        expect(typeof schemaCommands.registerCopyCommands).toBe('function');
        expect(typeof schemaCommands.registerTableCommands).toBe('function');
        expect(typeof schemaCommands.registerDDLCommands).toBe('function');
        expect(typeof schemaCommands.getFullName).toBe('function');
        expect(typeof schemaCommands.escapeSqlString).toBe('function');
        expect(typeof schemaCommands.isValidIdentifier).toBe('function');
    });
});
