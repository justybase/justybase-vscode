/**
 * Structure tab rendering for tables, views and procedures.
 */
import type { EditDataMetadata } from '../hostContracts';
import { renderStructure } from '../structure';

function metadata(overrides: Partial<EditDataMetadata>): EditDataMetadata {
    return {
        tableComment: '',
        columns: [],
        ...overrides,
    };
}

const COLUMNS = [
    {
        ATTNAME: 'CUSTOMER_ID',
        FORMAT_TYPE: 'INTEGER',
        IS_NOT_NULL: 1,
        COLDEFAULT: null,
        DESCRIPTION: 'Business key',
        IS_PK: 1,
        IS_FK: 0,
    },
    {
        ATTNAME: 'NAME',
        FORMAT_TYPE: 'VARCHAR(100)',
        IS_NOT_NULL: 0,
        COLDEFAULT: null,
        DESCRIPTION: '',
        IS_PK: 0,
        IS_FK: 0,
    },
];

function render(data: EditDataMetadata, options = {}) {
    const container = document.createElement('div');
    renderStructure(container, data, jest.fn(), jest.fn(), options);
    return container;
}

describe('renderStructure', () => {
    it('keeps tables editable by default', () => {
        const container = render(metadata({ tableComment: 'Customer master', columns: COLUMNS }));

        const commentBox = container.querySelector<HTMLTextAreaElement>('#tableCommentBox');
        expect(commentBox?.readOnly).toBe(false);
        expect(container.querySelector('#saveTableCommentBtn')).not.toBeNull();
        expect(container.querySelector('#showAddColumnBtn')).not.toBeNull();
        expect(container.querySelectorAll('input.col-comment')).toHaveLength(2);
        expect(container.querySelectorAll('.drop-col-btn')).toHaveLength(2);
        expect(container.querySelector('#newColName')).not.toBeNull();
    });

    it('renders views read-only with comment text instead of editors', () => {
        const container = render(metadata({ tableComment: 'Reporting view', columns: COLUMNS }), {
            readOnly: true,
            objectKind: 'view',
        });

        const commentBox = container.querySelector<HTMLTextAreaElement>('#tableCommentBox');
        expect(commentBox?.readOnly).toBe(true);
        expect(container.querySelector('#saveTableCommentBtn')).toBeNull();
        expect(container.querySelector('#revertTableCommentBtn')).toBeNull();
        expect(container.querySelector('#showAddColumnBtn')).toBeNull();
        expect(container.querySelector('#addColumnRow')).toBeNull();
        expect(container.querySelectorAll('input.col-comment')).toHaveLength(0);
        expect(container.querySelectorAll('.drop-col-btn')).toHaveLength(0);
        expect(container.querySelectorAll('.col-comment-readonly')).toHaveLength(1);
        expect(container.textContent).toContain('Business key');
        expect(container.textContent).toContain('View comment');
    });

    it('renders procedure definition properties and positional arguments', () => {
        const container = render(metadata({
            objectKind: 'procedure',
            properties: [
                { label: 'Kind', value: 'PROCEDURE' },
                { label: 'Database', value: 'JUST_DATA' },
                { label: 'Schema', value: 'ADMIN' },
                { label: 'Signature', value: 'LOAD_CUSTOMERS(INT, VARCHAR(10))' },
                { label: 'Owner', value: 'ADMIN' },
            ],
            arguments: [
                { position: 1, type: 'INT' },
                { position: 2, type: 'VARCHAR(10)' },
            ],
        }), { readOnly: true });

        expect(container.querySelectorAll('.struct-property')).toHaveLength(5);
        expect(container.textContent).toContain('Signature');
        expect(container.textContent).toContain('LOAD_CUSTOMERS(INT, VARCHAR(10))');
        expect(container.querySelectorAll('tbody tr[data-name]')).toHaveLength(2);
        expect(container.querySelectorAll('#structFilter')).toHaveLength(1);
        expect(container.querySelector('#tableCommentBox')).toBeNull();
        expect(container.querySelector('#showAddColumnBtn')).toBeNull();
        expect(container.querySelector('#addColumnRow')).toBeNull();
    });

    it('shows an empty state for procedures without arguments', () => {
        const container = render(metadata({
            objectKind: 'procedure',
            properties: [{ label: 'Kind', value: 'PROCEDURE' }],
            arguments: [],
        }), { readOnly: true });

        expect(container.querySelector('.empty-state')?.textContent).toContain('no arguments');
        expect(container.querySelector('tbody tr[data-name]')).toBeNull();
    });
});
