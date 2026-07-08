/**
 * Unit tests for completion provider barrel exports.
 */

import * as providersBarrel from '../providers';
import * as parsersBarrel from '../providers/parsers';
import * as matchersBarrel from '../providers/matchers';
import * as providersModuleBarrel from '../providers/providers';

describe('providers barrel exports', () => {
    it('exports parser utilities', () => {
        expect(typeof parsersBarrel.stripComments).toBe('function');
        expect(typeof parsersBarrel.parseVariables).toBe('function');
        expect(typeof parsersBarrel.parseLocalDefinitions).toBe('function');
    });

    it('exports matcher utilities', () => {
        expect(typeof matchersBarrel.matchJoinOn).toBe('function');
        expect(typeof matchersBarrel.matchSchema).toBe('function');
        expect(typeof matchersBarrel.findAlias).toBe('function');
    });

    it('exports providers and root barrel members', () => {
        expect(providersModuleBarrel.MetadataProvider).toBeDefined();
        expect(typeof providersModuleBarrel.getKeywords).toBe('function');

        expect(providersBarrel.MetadataProvider).toBeDefined();
        expect(typeof providersBarrel.stripComments).toBe('function');
    });
});
