import { activateCoreExtension } from '../../../src/api/companionActivation';
import { mysqlDialect } from './mysqlDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(mysqlDialect);
}

export function deactivate(): void {}
