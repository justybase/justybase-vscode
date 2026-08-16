import type { ConnectionDetails } from '../../types';
import type { ExecutionContext } from '../interfaces';

/**
 * Resolves the connection selected on a task.
 *
 * `default` was used by the first ETL configuration shape and means the
 * active/run fallback. Keeping that interpretation makes existing projects
 * continue to execute while new tasks can store a real connection name.
 */
export async function resolveTaskConnection(
    context: ExecutionContext,
    connectionName?: string,
): Promise<ConnectionDetails | undefined> {
    const normalizedName = connectionName?.trim();
    if (!normalizedName || normalizedName === 'default') {
        if (context.resolveConnection) {
            return context.resolveConnection(undefined);
        }
        return context.connectionDetails;
    }

    if (context.resolveConnection) {
        return context.resolveConnection(normalizedName);
    }

    // Backward-compatible execution contexts used by integrations/tests can
    // still provide only one connection object.
    if (context.connectionDetails?.name === normalizedName || !context.connectionDetails?.name) {
        return context.connectionDetails;
    }

    return undefined;
}
