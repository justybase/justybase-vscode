import type {
    DatabaseKind,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '@justybase/contracts';
import { getRequiredDatabaseDdlProvider } from './connectionFactory';
import {
    openRecreateTableScript as openSharedRecreateTableScript,
    quoteSqlLiteral,
} from '@justybase/database-utils/maintenanceProviderUtils';

export { quoteSqlLiteral };

export async function openRecreateTableScript(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
    kind: DatabaseKind
): Promise<void> {
    return openSharedRecreateTableScript(target, {
        ...services,
        getDdlProvider: services.getDdlProvider ?? (providerKind => getRequiredDatabaseDdlProvider(providerKind)),
    }, kind);
}
