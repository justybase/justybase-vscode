import { activateCoreExtension } from '../../../src/api/companionActivation';
import { verticaDialect } from './verticaDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(verticaDialect);
}

export function deactivate(): void {}
