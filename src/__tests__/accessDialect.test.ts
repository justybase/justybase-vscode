import { accessDialectTraits } from '../dialects/access/traits';
import { accessSqlAuthoring } from '../dialects/access/sql/authoring';
import { accessDialect } from '../../extensions/access/src/accessDialect';

describe('Access dialect authoring contract', () => {
    it('models Access as a flat, file-backed catalog without three-part names or indexes', () => {
        expect(accessDialectTraits.qualification.supportsThreePartName).toBe(false);
        expect(accessDialectTraits.qualification.twoPartNameStyle).toBe('database-object');
        expect(accessDialectTraits.completion.singleDotPathNamespace).toBe('none');
        expect(accessDialectTraits.objects.supportsIndexes).toBe(false);
    });

    it('exposes Access SQL keywords, functions, and validation type aliases', () => {
        expect(accessSqlAuthoring.completionKeywords).toEqual(expect.arrayContaining([
            'SELECT', 'FROM', 'TOP', 'DISTINCTROW', 'LEFT JOIN',
        ]));
        expect(accessSqlAuthoring.signatures.get('IIF')?.[0]?.parameters)
            .toEqual(['condition', 'valueIfTrue', 'valueIfFalse']);
        expect([...accessSqlAuthoring.validation.builtinFunctions]).toEqual(
            expect.arrayContaining(['IIF', 'NZ', 'DATEDIFF', 'UCASE']),
        );
        expect(accessSqlAuthoring.validation.getTypeSpec('VARCHAR(255)')?.canonical).toBe('TEXT');
        expect(accessSqlAuthoring.validation.getTypeSpec('TIMESTAMP')?.canonical).toBe('DATETIME');
        expect(accessSqlAuthoring.validation.getTypeSpec('UNKNOWN')).toBeUndefined();
    });

    it('exposes a read-only-by-default Access connection field', () => {
        const field = accessDialect.connectionForm?.fields.find(item => item.key === 'readOnly');
        expect(field).toMatchObject({
            type: 'checkbox',
            storage: 'options',
            defaultValue: true,
        });
    });
});
