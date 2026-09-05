import { getDesignerCapabilitiesResponse } from '../src/designerService';
import {
  assertDesignerOperationSupported,
  assertDesignerPlanCurrent,
  assertDesignerPlanHasChanges,
  EmptyDesignerPlanError,
  hasDesignerOperation,
  StaleDesignerSnapshotError,
  UnsupportedDesignerOperationError,
} from '@justybase/database-runtime';
import { getDatabaseDesignerCapabilities } from '@justybase/contracts';
import type { StoredConnection } from '../src/store';

function profile(overrides: Partial<StoredConnection> = {}): StoredConnection {
  return {
    id: 'connection-1',
    name: 'Local test connection',
    host: 'localhost',
    port: 5480,
    database: 'SYSTEM',
    user: 'ADMIN',
    dbType: 'netezza',
    passwordCiphertext: 'ciphertext',
    passwordIv: 'iv',
    passwordAuthTag: 'tag',
    readOnly: false,
    ...overrides,
  };
}

describe('designerService', () => {
  it('returns the registered API runtime as available and preserves the target', () => {
    const response = getDesignerCapabilitiesResponse(profile(), {
      connectionId: 'connection-1',
      database: 'SYSTEM',
      schema: 'ADMIN',
      objectName: 'FACT_SALES',
      objectType: 'TABLE',
    });

    expect(response.runtimeAvailable).toBe(true);
    expect(response.readOnly).toBe(false);
    expect(response.target).toEqual({
      connectionId: 'connection-1',
      connectionName: 'Local test connection',
      database: 'SYSTEM',
      schema: 'ADMIN',
      objectName: 'FACT_SALES',
      objectType: 'TABLE',
    });
    expect(response.capabilities.constructs.indexes.level).toBe('alternative');
  });

  it('does not expose an unregistered database profile as executable', () => {
    const response = getDesignerCapabilitiesResponse(
      profile({ dbType: 'mysql' }),
      { connectionId: 'connection-1' },
    );

    expect(response.runtimeAvailable).toBe(false);
    expect(response.capabilities.constructs.table.level).toBe('runtime-unavailable');
    expect(response.capabilities.constructs.table.operations).toEqual(['read']);
  });

  it('turns mutation capabilities into read-only states for a read-only profile', () => {
    const response = getDesignerCapabilitiesResponse(
      profile({ readOnly: true }),
      { connectionId: 'connection-1' },
    );

    expect(response.capabilities.constructs.table.level).toBe('privilege-blocked');
    expect(response.capabilities.constructs.table.operations).toEqual(['read']);
    expect(response.capabilities.constructs.views.level).toBe('privilege-blocked');
  });

  it('keeps the execution boundary guarded when a caller bypasses the UI', () => {
    const capabilities = getDatabaseDesignerCapabilities('netezza');
    expect(hasDesignerOperation(capabilities, 'foreignKeys', 'read')).toBe(false);
    expect(hasDesignerOperation(capabilities, 'indexes', 'create')).toBe(false);
    expect(hasDesignerOperation(capabilities, 'indexes', 'create', true)).toBe(true);
    expect(() => assertDesignerOperationSupported(capabilities, 'checks', 'create')).toThrow(UnsupportedDesignerOperationError);
    expect(() => assertDesignerOperationSupported(capabilities, 'indexes', 'create')).toThrow(UnsupportedDesignerOperationError);
    expect(() => assertDesignerOperationSupported(capabilities, 'indexes', 'create', true)).not.toThrow();

    const plan = {
      planVersion: 1 as const,
      planId: 'plan-1',
      target: { objectName: 'FACT_SALES' },
      baseFingerprint: 'before',
      statements: [],
      warnings: [],
      requiresExplicitConfirmation: true,
      canRunInTransaction: false,
      postconditions: [],
    };
    expect(() => assertDesignerPlanCurrent(plan, 'after')).toThrow(StaleDesignerSnapshotError);
    expect(() => assertDesignerPlanHasChanges(plan)).toThrow(EmptyDesignerPlanError);
  });
});
