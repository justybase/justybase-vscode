import { describe, expect, it } from '@jest/globals';
import {
  assertDesignerOperationSupported,
  assertDesignerPlanCurrent,
  assertDesignerPlanHasChanges,
  EmptyDesignerPlanError,
  hasDesignerOperation,
  StaleDesignerSnapshotError,
  UnsupportedDesignerOperationError,
} from '../src';
import { getDatabaseDesignerCapabilities } from '@justybase/contracts';

describe('designer core guards', () => {
  it('applies capability and alternative gating consistently', () => {
    const capabilities = getDatabaseDesignerCapabilities('netezza');

    expect(hasDesignerOperation(capabilities, 'indexes', 'create')).toBe(false);
    expect(hasDesignerOperation(capabilities, 'indexes', 'create', true)).toBe(true);
    expect(() => assertDesignerOperationSupported(capabilities, 'indexes', 'create')).toThrow(UnsupportedDesignerOperationError);
    expect(() => assertDesignerOperationSupported(capabilities, 'indexes', 'create', true)).not.toThrow();
  });

  it('rejects stale and empty plans', () => {
    const plan = {
      planVersion: 1 as const,
      planId: 'plan-1',
      target: { objectName: 'orders' },
      baseFingerprint: 'before',
      statements: [],
      warnings: [],
      requiresExplicitConfirmation: false,
      canRunInTransaction: true,
      postconditions: [],
    };

    expect(() => assertDesignerPlanCurrent(plan, 'after')).toThrow(StaleDesignerSnapshotError);
    expect(() => assertDesignerPlanHasChanges(plan)).toThrow(EmptyDesignerPlanError);
  });
});
