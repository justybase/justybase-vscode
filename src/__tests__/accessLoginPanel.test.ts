import { LoginPanel } from '../views/loginPanel';
import { accessDialectStub } from '../dialects/access';
import type { ConnectionDetails } from '../core/connectionManager';

interface LoginPanelHarness {
    _getDialectDefinition: (kind?: string) => typeof accessDialectStub;
    _normalizeOptions: (options: ConnectionDetails['options'] | undefined) => ConnectionDetails['options'] | undefined;
    _normalizeIncomingConnection: (data: Partial<ConnectionDetails>) => ConnectionDetails;
    _validateConnectionData: (data: Partial<ConnectionDetails>, requireName: boolean) => string | undefined;
}

describe('Access login form', () => {
    it('does not require host or user and defaults to read-only', () => {
        const panel = Object.create(LoginPanel.prototype) as LoginPanelHarness;
        panel._getDialectDefinition = () => accessDialectStub;
        panel._normalizeOptions = options => options;

        const input = {
            dbType: 'access',
            filePath: '/data/example.accdb',
        } as unknown as Partial<ConnectionDetails>;
        const normalized = panel._normalizeIncomingConnection(input);

        expect(panel._validateConnectionData(normalized, false)).toBeUndefined();
        expect(accessDialectStub.connectionForm.fields.find(field => field.key === 'readOnly')?.defaultValue).toBe(true);
    });
});
