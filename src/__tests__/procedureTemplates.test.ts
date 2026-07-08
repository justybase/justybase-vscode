import { getTemplateById, getTemplatesByCategory, procedureTemplates } from '../providers/procedureTemplates';

describe('procedureTemplates', () => {
    it('groups templates by category', () => {
        const grouped = getTemplatesByCategory();

        expect(grouped.basic.length).toBeGreaterThan(0);
        expect(grouped.advanced.length).toBeGreaterThan(0);
        expect(grouped.basic.length + grouped.advanced.length).toBe(procedureTemplates.length);
        expect(grouped.basic.every(template => template.category === 'basic')).toBe(true);
        expect(grouped.advanced.every(template => template.category === 'advanced')).toBe(true);
    });

    it('gets templates by id and returns undefined for unknown', () => {
        expect(getTemplateById('basic-simple')?.name).toContain('Basic');
        expect(getTemplateById('unknown-id')).toBeUndefined();
    });

    it('generates SQL for every template', () => {
        for (const template of procedureTemplates) {
            const sql = template.template('proc_test', 'DB1');

            expect(sql).toContain('CREATE OR REPLACE PROCEDURE DB1.ADMIN.PROC_TEST');
            expect(sql).toContain('LANGUAGE NZPLSQL');
            expect(sql).toContain('BEGIN_PROC');
            expect(sql).toContain('END_PROC;');
            expect(sql).not.toContain('.SCHEMA.');
        }
    });

    it('normalizes identifiers and keeps Netezza positional parameter syntax', () => {
        const template = getTemplateById('basic-simple');

        expect(template).toBeDefined();
        const sql = template!.template('na"me', 'db"name', 'sc"hema');
        const firstLine = sql.split('\n')[0];

        expect(firstLine).toBe('CREATE OR REPLACE PROCEDURE DBNAME.SCHEMA.NAME(INTEGER)');
        expect(firstLine).not.toContain('"');
        expect(sql).not.toMatch(/\(\s*[a-z_][a-z0-9_]*\s+INTEGER\s*\)/i);
    });
});
