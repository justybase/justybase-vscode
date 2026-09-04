import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect,
    DatabaseDialectTraitsOverrides,
    DatabaseKind,
} from '../contracts/database';
import { createDatabaseCapabilities, createDatabaseDialectTraits } from '../contracts/database';
import {
    createStandardConnectionForm,
    type StandardConnectionFieldOptions,
} from '../core/connectionFormBuilder';

export interface StubDialectOptions {
    traitsOverrides?: DatabaseDialectTraitsOverrides;
    connectionFormOptions?: StandardConnectionFieldOptions;
    extensionDisplayName?: string;
    supportsRawTcpTunnel?: boolean;
}

export function createStubDialect(
    kind: DatabaseKind,
    displayName: string,
    defaultPort?: number,
    options: StubDialectOptions = {},
): DatabaseDialect {
    const extensionName = options.extensionDisplayName ?? `JustyBase SQL Editor (${displayName})`;
    const installHint = `Install the optional "${extensionName}" extension to use ${displayName} connections.`;

    const connectionFormOptions: StandardConnectionFieldOptions = {
        ...(defaultPort !== undefined ? { defaultPort } : {}),
        ...options.connectionFormOptions,
    };

    return {
        kind,
        displayName,
        ...(defaultPort !== undefined ? { defaultPort } : {}),
        capabilities: createDatabaseCapabilities(),
        connectionForm: createStandardConnectionForm(connectionFormOptions),
        traits: createDatabaseDialectTraits(options.traitsOverrides),
        ...(options.supportsRawTcpTunnel ? { supportsRawTcpTunnel: true } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadataProvider: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sqlAuthoring: { dialects: { [kind]: {} } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        advancedFeatures: {} as any,
        getConnectionConstructor(): DatabaseConnectionStaticConstructor {
            throw new Error(installHint);
        },
        createConnection(_config: DatabaseConnectionConfig): DatabaseConnection {
            throw new Error(installHint);
        },
    };
}
