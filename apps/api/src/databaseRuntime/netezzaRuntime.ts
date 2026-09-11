import {
  NetezzaRuntime,
  isReadOnlySql,
  type NetezzaConnectionDetails,
} from '@justybase/netezza-runtime';
import { decryptSecret } from '../security';
import type { StoredConnection } from '../store';
import type {
  ApiDatabaseRuntime,
  ApiQueryOptions,
  ApiQueryResult,
  QueryCallbacks,
} from './contracts';

export class NetezzaApiDatabaseRuntime implements ApiDatabaseRuntime {
  public readonly kind = 'netezza' as const;
  private readonly runtime = new NetezzaRuntime({ isReadOnlySql });

  public constructor(private readonly masterKey: string) {}

  public isReadOnlySql(sql: string): boolean {
    return isReadOnlySql(sql);
  }

  public isAvailable(): boolean {
    return this.runtime.isAvailable();
  }

  public normalizeDatabase(database: string): string {
    return database.trim();
  }

  public execute(
    profile: StoredConnection,
    sql: string,
    options: ApiQueryOptions,
    callbacks: QueryCallbacks,
  ): Promise<ApiQueryResult> {
    return this.runtime.execute(this.targetFor(profile), sql, options, callbacks);
  }

  public listDatabases(profile: StoredConnection) {
    return this.runtime.listDatabases(this.targetFor(profile));
  }

  public listSchemas(profile: StoredConnection, database: string) {
    return this.runtime.listSchemas(this.targetFor(profile), database);
  }

  public listObjects(profile: StoredConnection, database: string, schema?: string) {
    return this.runtime.listObjects(this.targetFor(profile), database, schema);
  }

  public listColumns(profile: StoredConnection, database: string, schema: string, table: string) {
    return this.runtime.listColumns(this.targetFor(profile), database, schema, table);
  }

  public getTableDdlMetadata(profile: StoredConnection, database: string, schema: string, table: string) {
    return this.runtime.getTableDdlMetadata(this.targetFor(profile), database, schema, table);
  }

  public getViewDefinition(profile: StoredConnection, database: string, schema: string, view: string) {
    return this.runtime.getViewDefinition(this.targetFor(profile), database, schema, view);
  }

  public async closeConnection(connectionId: string): Promise<void> {
    await this.runtime.closeConnection(connectionId);
  }

  public async closeAll(): Promise<void> {
    await this.runtime.closeAll();
  }

  private targetFor(profile: StoredConnection): { connectionId: string; details: NetezzaConnectionDetails } {
    return {
      connectionId: profile.id,
      details: {
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: decryptSecret({
          ciphertext: profile.passwordCiphertext,
          iv: profile.passwordIv,
          authTag: profile.passwordAuthTag,
        }, this.masterKey),
      },
    };
  }
}
