import { createStubDialect } from '../stubDialectFactory';
import { clickhouseDialectTraits } from '../../shared/dialect-traits/clickhouse';

/** Core login-panel stub; the HTTP runtime is supplied by the companion extension. */
export const clickhouseDialect = createStubDialect('clickhouse', 'ClickHouse', 8123, {
    connectionFormOptions: {
        databasePlaceholder: 'ClickHouse database (default: default)',
        userPlaceholder: 'ClickHouse user',
    },
    traitsOverrides: clickhouseDialectTraits,
    extensionDisplayName: 'JustyBase SQL Editor (ClickHouse)',
});
