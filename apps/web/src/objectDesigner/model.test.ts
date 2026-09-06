import type { SchemaTreeNode } from '@justybase/contracts';
import {
  getAvailableDesignerTabs,
  getDesignerTargetFlags,
  viewDefinitionFromMetadata,
} from './model';

function target(objectType?: string): SchemaTreeNode {
  return {
    id: 'object-1',
    kind: 'object',
    label: 'orders',
    objectName: 'orders',
    objectType,
    schema: 'public',
    hasChildren: false,
  };
}

describe('object designer model', () => {
  it('derives target flags and tabs without depending on React state', () => {
    expect(getDesignerTargetFlags(target())).toEqual({ isTableTarget: true, isViewTarget: false, isRoutineTarget: false });
    expect(getAvailableDesignerTabs(target('VIEW'))).toEqual(['overview', 'definition', 'triggers']);
    expect(getAvailableDesignerTabs(target('FUNCTION'))).toEqual(['overview', 'definition']);
  });

  it('extracts a SELECT body only from a CREATE VIEW definition', () => {
    expect(viewDefinitionFromMetadata('CREATE VIEW public.orders_view AS SELECT * FROM public.orders;')).toBe('SELECT * FROM public.orders');
    expect(viewDefinitionFromMetadata('SELECT * FROM public.orders')).toBe('');
  });
});
