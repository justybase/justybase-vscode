import { resolveDatabasePicker } from '../src/databasePicker';

describe('resolveDatabasePicker', () => {
  it('keeps the profile database visible before the catalog request completes', () => {
    expect(resolveDatabasePicker([], 'SYSTEM')).toEqual({ value: 'SYSTEM', options: [{ name: 'SYSTEM' }] });
  });

  it('adds an unlisted current database without changing the catalog order', () => {
    expect(resolveDatabasePicker([{ name: 'REPORTING' }], 'SYSTEM')).toEqual({
      value: 'SYSTEM',
      options: [{ name: 'SYSTEM' }, { name: 'REPORTING' }],
    });
  });

  it('uses the catalog spelling when only the database name casing differs', () => {
    expect(resolveDatabasePicker([{ name: 'SYSTEM' }, { name: 'REPORTING' }], 'system')).toEqual({
      value: 'SYSTEM',
      options: [{ name: 'SYSTEM' }, { name: 'REPORTING' }],
    });
  });

  it('prefers an exact database identity before case-insensitive matching', () => {
    expect(resolveDatabasePicker([{ name: 'just_data' }, { name: 'JUST_DATA' }], 'JUST_DATA')).toEqual({
      value: 'JUST_DATA',
      options: [{ name: 'just_data' }, { name: 'JUST_DATA' }],
    });
  });
});
