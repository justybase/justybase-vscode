import { renderEditDataShell } from '../views/editDataProvider';

function shellFor(objectType: string, objectKind: 'table' | 'view' | 'procedure', readOnly: boolean): string {
    return renderEditDataShell({
        database: 'JUST_DATA',
        schema: 'ADMIN',
        table: objectType === 'PROCEDURE' ? 'LOAD_CUSTOMERS(INT)' : 'CUSTOMER_ORDERS',
        connectionName: 'NZ_DEV',
        objectType,
        objectKind,
        readOnly,
        initialTab: 'structure',
    });
}

describe('renderEditDataShell object details', () => {
    it('opens tables on the Structure tab but keeps editing enabled', () => {
        const shell = shellFor('TABLE', 'table', false);

        expect(shell).toContain('<button class="tab active" role="tab" data-target="tab-metadata">Structure</button>');
        expect(shell).toContain('<section id="tab-metadata" class="tab-content active" role="tabpanel">');
        expect(shell).toContain('id="saveBtn"');
        expect(shell).toContain('id="addRowBtn"');
        expect(shell).toContain('id="tab-data"');
    });

    it('opens views read-only with the data toolbar stripped of mutations', () => {
        const shell = shellFor('VIEW', 'view', true);

        expect(shell).toContain('<button class="tab active" role="tab" data-target="tab-metadata">Structure</button>');
        expect(shell).toContain('id="tab-data"');
        expect(shell).not.toContain('id="saveBtn"');
        expect(shell).not.toContain('id="addRowBtn"');
        expect(shell).not.toContain('id="deleteRowBtn"');
        expect(shell).toContain('placeholder="optional"');
    });

    it('opens procedures on Structure without a Data tab', () => {
        const shell = shellFor('PROCEDURE', 'procedure', true);

        expect(shell).not.toContain('id="tab-data"');
        expect(shell).toContain('<button class="tab active" role="tab" data-target="tab-metadata">Structure</button>');
        expect(shell).toContain('data-target="tab-ddl"');
        expect(shell).toContain('<section id="tab-metadata" class="tab-content active" role="tabpanel">');
    });
});
