import { EventEmitter } from 'node:events';
import { Db2DatabaseConnection } from '@justybase/db2/compat';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig
} from '@justybase/contracts';

type Db2DriverConnection = Pick<
    Db2DatabaseConnection,
    '_connected' | 'connect' | 'close' | 'createCommand' | 'on' | 'removeListener'
>;

type Db2DriverFactory = (config: DatabaseConnectionConfig) => Db2DriverConnection;

const createDefaultDriverConnection: Db2DriverFactory = config => new Db2DatabaseConnection(config);

function redactSecret(text: string, secret: string | undefined): string {
    return secret ? text.split(secret).join('[redacted]') : text;
}

/**
 * Wraps a driver connect failure with the same context the previous ibm_db runtime
 * reported (target and user, never the password). The original error is not kept as
 * `cause`: its message or stack may contain the credential this boundary must hide.
 */
function buildConnectError(error: unknown, config: DatabaseConnectionConfig): Error {
    const driverMessage = error instanceof Error ? error.message : String(error);
    const message = redactSecret(driverMessage, config.password);
    const details = [
        `database=${config.database || '<empty>'}`,
        `host=${config.host || '<empty>'}`,
        `port=${config.port ?? '<default>'}`,
        `user=${config.user || '<empty>'}`
    ].join(', ');

    return new Error(`Failed to connect to Db2: ${message}\nConnection details: ${redactSecret(details, config.password)}`);
}

/** JustyBase connection boundary backed by the pure TypeScript DRDA driver. */
export class Db2Connection extends EventEmitter implements DatabaseConnection {
    private readonly _driver: Db2DriverConnection;

    public constructor(
        public readonly config: DatabaseConnectionConfig,
        driverFactory: Db2DriverFactory = createDefaultDriverConnection
    ) {
        super();
        this._driver = driverFactory(config);
        this._driver.on('notice', event => this.emit('notice', event));
        this._driver.on('close', event => this.emit('close', event));
    }

    public get _connected(): boolean {
        return this._driver._connected;
    }

    public async connect(): Promise<void> {
        try {
            await this._driver.connect();
        } catch (error) {
            throw buildConnectError(error, this.config);
        }
    }

    public async close(): Promise<void> {
        await this._driver.close();
    }

    public createCommand(sql: string): DatabaseCommand {
        return this._driver.createCommand(sql);
    }
}
