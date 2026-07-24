import { jest } from '@jest/globals';
import { describe, expect, it } from '@jest/globals';

jest.unmock('chevrotain');
import { oracleSqlAuthoring } from '../../../extensions/oracle/src/sql/authoring';
import { createMockSchemaProvider } from '../../sqlParser/schemaProvider';
import { SqlValidator } from '../../sqlParser/validator';

describe('Oracle SQL validator', () => {
  it('validates an anonymous PL/SQL block through the Oracle runtime', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(`
      DECLARE
        v_count NUMBER := 0;
      BEGIN
        NULL;
      END;
    `);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects Netezza-only statements in strict Oracle mode', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(
      'GROOM TABLE sales VERSIONS;',
    );

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('runs PL/SQL scope diagnostics for Oracle blocks', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(`
      DECLARE
        v_unused NUMBER;
      BEGIN
        SELECT employee_id FROM employees;
      END;
    `);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['SQL037', 'SQL039']),
    );
  });

  it('checks Oracle function returns and OUT parameter assignment', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(`
      CREATE OR REPLACE FUNCTION missing_return RETURN NUMBER IS
      BEGIN
        NULL;
      END;
      CREATE OR REPLACE PROCEDURE missing_out(p OUT NUMBER) IS
      BEGIN
        NULL;
      END;
    `);

    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['SQL038', 'SQL040']),
    );
  });

  it('analyzes trigger PL/SQL bodies while accepting package units', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(`
      CREATE OR REPLACE PACKAGE BODY pkg AS
        FUNCTION value RETURN NUMBER IS BEGIN RETURN 1; END value;
      END pkg;
      CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON employees FOR EACH ROW
      BEGIN
        SELECT employee_id FROM employees;
      END;
    `);

    expect(result.warnings.map((warning) => warning.code)).toContain('SQL037');
  });

  it('validates nested package-body routines as procedure scopes', () => {
    const result = new SqlValidator(undefined, oracleSqlAuthoring.validation).validate(`
      CREATE OR REPLACE PACKAGE BODY pkg AS
        FUNCTION missing RETURN NUMBER IS
          v_unused NUMBER;
        BEGIN
          NULL;
        END missing;
      END pkg;
    `);

    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['SQL038', 'SQL039']),
    );
  });

  it('validates SQL statements embedded in Oracle PL/SQL blocks', () => {
    const schema = createMockSchemaProvider([
      {
        database: 'ORCL',
        schema: 'HR',
        name: 'EMPLOYEES',
        columns: ['EMPLOYEE_ID', 'MANAGER_ID'],
      },
    ]);
    const result = new SqlValidator(schema, oracleSqlAuthoring.validation).validate(`
      BEGIN
        SELECT missing_column INTO v_result FROM ORCL.HR.EMPLOYEES;
      END;
    `);

    expect(result.errors.map((error) => error.code)).toContain('SQL004');
  });
});
