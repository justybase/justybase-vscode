import { createStubDialect } from '../stubDialectFactory';

/**
 * Stub for the 'access' dialect (Microsoft Access .mdb/.accdb via UCanAccess).
 * Registered so the login panel shows the option with an install hint;
 * the real dialect is registered by the Access companion extension.
 */
const accessDialectBase = createStubDialect(
    'access',
    'Microsoft Access',
    undefined,
    {
        traitsOverrides: {
            identifiers: {
                generatedNameCase: 'preserve',
            },
            qualification: {
                twoPartNameStyle: 'database-object',
                twoPartContainerPreference: 'schema-over-database',
                supportsThreePartName: false,
                threePartNamePrefix: 'none',
                databaseOnlyReferenceStyle: 'single-dot',
            },
            completion: {
                singleDotPathNamespace: 'none',
            },
        },
        extensionDisplayName: 'JustyBase SQL Editor (Microsoft Access)',
    },
);

/**
 * Keep the core login form aligned with the optional Access extension. The
 * real dialect may not be registered yet when the login panel is created,
 * but Access still must not fall back to host/user validation.
 */
export const accessDialectStub = {
    ...accessDialectBase,
    connectionForm: {
        fields: [
            {
                key: 'filePath',
                label: 'Access Database File',
                type: 'file' as const,
                storage: 'topLevel' as const,
                required: true,
                placeholder: 'Select a .mdb or .accdb file',
                description: 'Microsoft Access database queried through the optional Java/UCanAccess bridge.',
                layout: 'full' as const,
            },
            {
                key: 'password',
                label: 'Database Password',
                type: 'password' as const,
                storage: 'topLevel' as const,
                placeholder: 'Optional Access database password',
                description: 'Password for the Access database file, if it is protected.',
                layout: 'full' as const,
            },
            {
                key: 'readOnly',
                label: 'Open database as read-only',
                type: 'checkbox' as const,
                storage: 'options' as const,
                defaultValue: true,
                description: 'Disable only when INSERT, UPDATE, DELETE, or DDL is required. Reconnect open SQL tabs after changing this option.',
                layout: 'full' as const,
            },
        ],
    },
};
