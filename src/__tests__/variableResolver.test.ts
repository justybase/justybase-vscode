/**
 * Variable Resolver Tests
 */

import { VariableResolver } from '../etl/utils/variableResolver';

describe('VariableResolver', () => {
    let resolver: VariableResolver;

    beforeEach(() => {
        resolver = new VariableResolver();
    });

    describe('resolve', () => {
        it('should replace single variable', () => {
            const result = resolver.resolve('Hello ${name}!', { name: 'World' });
            expect(result).toBe('Hello World!');
        });

        it('should replace multiple variables', () => {
            const result = resolver.resolve(
                '${greeting}, ${name}!',
                { greeting: 'Hello', name: 'World' }
            );
            expect(result).toBe('Hello, World!');
        });

        it('should replace same variable multiple times', () => {
            const result = resolver.resolve(
                '${x} + ${x} = ${y}',
                { x: '2', y: '4' }
            );
            expect(result).toBe('2 + 2 = 4');
        });

        it('should handle empty template', () => {
            const result = resolver.resolve('', { name: 'World' });
            expect(result).toBe('');
        });

        it('should handle empty variables', () => {
            const result = resolver.resolve('Hello ${name}!', {});
            expect(result).toBe('Hello ${name}!');
        });

        it('should handle null/undefined template', () => {
            expect(resolver.resolve(null as unknown as string, {})).toBe(null);
            expect(resolver.resolve(undefined as unknown as string, {})).toBe(undefined);
        });

        it('should handle special regex characters in variable names', () => {
            const result = resolver.resolve('Value: ${a.b}', { 'a.b': '123' });
            expect(result).toBe('Value: 123');
        });

        it('should not replace partial matches', () => {
            const result = resolver.resolve('${name}s are great', { name: 'Cat' });
            expect(result).toBe('Cats are great');
        });

        it('should handle nested braces', () => {
            const result = resolver.resolve('{ ${value} }', { value: 'test' });
            expect(result).toBe('{ test }');
        });

        it('should replace variable with braces only (no dollar sign)', () => {
            const result = resolver.resolve('SELECT * FROM {table}', { table: 'users' });
            expect(result).toBe('SELECT * FROM users');
        });

        it('should replace multiple variables with braces only', () => {
            const result = resolver.resolve(
                'SELECT {col1}, {col2} FROM {table}',
                { col1: 'id', col2: 'name', table: 'users' }
            );
            expect(result).toBe('SELECT id, name FROM users');
        });

        it('should handle both braces formats in one template', () => {
            const result = resolver.resolve(
                '{greeting}, ${name}!',
                { greeting: 'Hello', name: 'World' }
            );
            expect(result).toBe('Hello, World!');
        });
    });

    describe('resolveAll', () => {
        it('should resolve multiple templates', () => {
            const results = resolver.resolveAll(
                ['${x}', '${y}', '${x}${y}'],
                { x: 'A', y: 'B' }
            );
            expect(results).toEqual(['A', 'B', 'AB']);
        });

        it('should handle empty array', () => {
            const results = resolver.resolveAll([], { x: 'A' });
            expect(results).toEqual([]);
        });
    });
});
