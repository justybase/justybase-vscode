import { activateCoreExtension } from '../../../src/api/companionActivation';
import { oracleDialect } from './oracleDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(oracleDialect);
}

export function deactivate(): void {}
