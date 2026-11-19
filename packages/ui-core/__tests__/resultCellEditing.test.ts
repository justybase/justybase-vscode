import { describe, expect, it } from '@jest/globals';
import {
  editValuesEqual,
  parseTypedEditValue,
  resolveGridCellEditKind,
  toEditableCellText,
} from '../src';

describe('renderer-neutral typed cell editing', () => {
  it('validates integers, decimals, booleans, dates and JSON', () => {
    expect(parseTypedEditValue('900719925474099312345.67', 'DECIMAL(30,2)', false)).toEqual({
      valid: true,
      value: '900719925474099312345.67',
    });
    expect(parseTypedEditValue('1.5', 'INTEGER', false).valid).toBe(false);
    expect(parseTypedEditValue('true', 'BOOLEAN', false)).toEqual({ valid: true, value: true });
    expect(parseTypedEditValue('false', 'BIT(1)', false)).toEqual({ valid: true, value: false });
    expect(parseTypedEditValue('1', 'BIT(8)', false)).toEqual({ valid: true, value: '1' });
    expect(parseTypedEditValue('maybe', 'BOOLEAN', false).valid).toBe(false);
    expect(parseTypedEditValue('2024-02-29', 'DATE', false).valid).toBe(true);
    expect(parseTypedEditValue('2023-02-29', 'DATE', false).valid).toBe(false);
    expect(parseTypedEditValue('{"id":1}', 'JSON', false).valid).toBe(true);
    expect(parseTypedEditValue('{bad}', 'JSON', false).valid).toBe(false);
    expect(parseTypedEditValue('', 'VARCHAR', true)).toEqual({ valid: true, value: null });
    expect(parseTypedEditValue('', 'VARCHAR', false)).toEqual({ valid: true, value: '' });
  });

  it('chooses the editor shape from the column type and value width', () => {
    expect(resolveGridCellEditKind('BOOLEAN', null)).toBe('boolean');
    expect(resolveGridCellEditKind('DATE', '2024-01-01')).toBe('date');
    expect(resolveGridCellEditKind('DECIMAL(18,2)', '1.25')).toBe('number');
    expect(resolveGridCellEditKind('VARCHAR(20)', 'short')).toBe('text');
    expect(resolveGridCellEditKind('TEXT', 'short')).toBe('textarea');
    expect(resolveGridCellEditKind('VARCHAR(20)', 'x'.repeat(3001))).toBe('textarea');
  });

  it('compares edits without coercing null and formats editable text', () => {
    expect(editValuesEqual(42, '42')).toBe(true);
    expect(editValuesEqual('', null)).toBe(false);
    expect(editValuesEqual(new Date(0), new Date(0))).toBe(true);
    expect(editValuesEqual(new Date(0), new Date(1))).toBe(false);
    expect(toEditableCellText(new Date('2024-06-15T14:30:45.000Z'), 'DATE')).toBe('2024-06-15');
    expect(toEditableCellText(new Date('2024-06-15T14:30:45.000Z'), 'TIMESTAMP'))
      .toBe('2024-06-15T14:30:45.000Z');
    expect(toEditableCellText(null, 'VARCHAR')).toBe('');
  });
});
