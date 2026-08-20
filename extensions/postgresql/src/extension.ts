import { activateCoreExtension } from '../../../src/api/companionActivation';
import { postgresqlDialect } from './postgresqlDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(postgresqlDialect);
}

export function deactivate(): void {}
