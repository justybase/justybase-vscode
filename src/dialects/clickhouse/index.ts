import { createStubDialect } from '../stubDialectFactory';
import { clickhouseDialectTraits } from '../../shared/dialect-traits/clickhouse';

/** Core login-panel stub; the HTTP runtime is supplied by the companion extension. */
export const clickhouseDialect = createStubDialect('clickhouse', 'ClickHouse', 8123, {
    supportsRawTcpTunnel: true,
    connectionFormOptions: {
        databasePlaceholder: 'ClickHouse database (default: default)',
        userPlaceholder: 'ClickHouse user',
    },
    additionalConnectionFields: [
        {
            key: 'protocol',
            label: 'Protocol',
            type: 'select',
            storage: 'options',
            defaultValue: 'http',
            options: [
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS / TLS' },
            ],
            description: 'ClickHouse HTTP interface protocol.',
            layout: 'half',
        },
        {
            key: 'tlsMode',
            label: 'TLS certificate',
            type: 'select',
            storage: 'options',
            defaultValue: 'verify-full',
            options: [
                { value: 'verify-full', label: 'Verify certificate' },
                { value: 'require', label: 'Encrypt, skip validation' },
            ],
            description: 'Used for HTTPS connections.',
            layout: 'half',
        },
        {
            key: 'tlsServerName',
            label: 'TLS Server Name',
            type: 'text',
            storage: 'options',
            placeholder: 'Optional certificate DNS name',
            description: 'Optional TLS SNI/server name. Required when HTTPS is reached through a local TCP tunnel and the certificate is issued for the remote host.',
            layout: 'full',
        },
    ],
    traitsOverrides: clickhouseDialectTraits,
    extensionDisplayName: 'JustyBase SQL Editor (ClickHouse)',
});
