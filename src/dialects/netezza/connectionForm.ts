import type { DatabaseConnectionFormSchema } from '../../contracts/database';
import { createStandardConnectionForm } from '../../core/connectionFormBuilder';

const standardForm = createStandardConnectionForm({
    defaultPort: 5480,
    databaseDefaultValue: 'system'
});

export const netezzaConnectionForm: DatabaseConnectionFormSchema = {
    fields: [
        ...standardForm.fields,
        {
            key: 'netezzaSslMode',
            label: 'SSL mode',
            type: 'select',
            storage: 'options',
            defaultValue: 'default',
            layout: 'full',
            description:
                'Default keeps the existing negotiate behavior, which may be unencrypted. Require forces TLS without checking ' +
                'the server certificate. Verify full forces TLS and checks the certificate chain and host name; select the ' +
                'appliance or CA certificate below for a self-signed or private CA.',
            options: [
                { value: 'default', label: 'Default (negotiate)' },
                { value: 'disable', label: 'Disable' },
                { value: 'require', label: 'Require (encrypt, no certificate check)' },
                { value: 'verify-full', label: 'Verify full (CA + hostname)' }
            ]
        },
        {
            key: 'netezzaSslRootCert',
            label: 'CA certificate (PEM)',
            type: 'file',
            storage: 'options',
            layout: 'full',
            description: 'Optional PEM certificate or CA bundle used by Verify full (and by Default when TLS is negotiated).'
        }
    ]
};
