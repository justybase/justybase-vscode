import type {
  NzConnection,
  NzCommand,
  NzConnectionConfig,
  NzDataReader,
} from '@justybase/netezza-driver';

export type NetezzaDriverConnection = NzConnection;
export type NetezzaDriverCommand = NzCommand;
export type NetezzaDriverReader = NzDataReader;
export type NetezzaDriverConfig = NzConnectionConfig;

export interface NetezzaDriverOptions {
  connectionTimeout?: number;
  clientType?: number;
}

/** The only production module boundary that imports the Netezza driver. */
export function getNetezzaConnectionConstructor(): typeof NzConnection {
  // Keep driver initialization deferred until a Netezza connection is needed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const driver = require('@justybase/netezza-driver') as typeof import('@justybase/netezza-driver');
  return driver.NzConnection;
}

export function createNetezzaConnection(
  details: NetezzaDriverConfig,
  options: NetezzaDriverOptions = {},
): NetezzaDriverConnection {
  const Connection = getNetezzaConnectionConstructor();
  return new Connection({
    ...details,
    clientType: options.clientType ?? details.clientType ?? 11, // Driver ClientTypeId.SqlDotnet.
    ...(options.connectionTimeout === undefined ? {} : { connectionTimeout: options.connectionTimeout }),
  });
}

export async function createConnectedNetezzaConnection(
  details: NetezzaDriverConfig,
  options: NetezzaDriverOptions = {},
): Promise<NetezzaDriverConnection> {
  const connection = createNetezzaConnection(details, options);
  try {
    await connection.connect();
    return connection;
  } catch (error: unknown) {
    try {
      await connection.close();
    } catch {
      // Preserve the original connection failure.
    }
    throw error;
  }
}
