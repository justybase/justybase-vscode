import * as fs from 'fs';
import * as path from 'path';
import { renderEditDataShell } from '../views/editDataProvider';

/**
 * test-harness/edit-data.html embeds the production panel markup so the
 * Playwright spec exercises the real DOM. Regenerate the block between the
 * EDIT_DATA_SHELL markers if this fails.
 */
describe('Edit Data panel browser harness', () => {
    it('embeds the current renderEditDataShell markup', () => {
        const harness = fs.readFileSync(path.join(__dirname, '../../test-harness/edit-data.html'), 'utf8');
        const shell = renderEditDataShell({
            database: 'JUST_DATA',
            schema: 'ADMIN',
            table: 'CUSTOMER_ORDERS',
            connectionName: 'NZ_DEV',
        });
        expect(harness).toContain(shell);
    });
});
