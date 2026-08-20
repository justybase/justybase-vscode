import { activateCoreExtension } from '../../../src/api/companionActivation';
import { snowflakeDialect } from './snowflakeDialect';

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(snowflakeDialect);
}

export function deactivate(): void {}
