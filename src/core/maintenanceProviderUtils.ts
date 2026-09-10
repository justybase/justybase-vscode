import type {
    DatabaseKind,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '@justybase/contracts';
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
    return openSharedRecreateTableScript(target, services, kind);
}
