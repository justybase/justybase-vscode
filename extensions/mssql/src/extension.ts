import { activateCoreExtension } from '../../../src/api/companionActivation';
import { mssqlDialect } from './mssqlDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(mssqlDialect);
}

export function deactivate(): void {}
