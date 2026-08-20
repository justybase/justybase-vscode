import { activateCoreExtension } from '../../../src/api/companionActivation';
import { accessDialect } from './accessDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(accessDialect);
}

export function deactivate(): void {}
