jest.unmock('chevrotain');

import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { SqlValidator } from '../../sqlParser/validator';
import { db2SqlAuthoring } from '../../../extensions/db2/src/sql/authoring';
import { SqlLexer as oracleLexer } from '../../dialects/oracle/sql/lexer';

// Small, independent cases keep one unsupported clause from masking another.
// Sources: IBM Db2 11.5, PostgreSQL CREATE/ALTER TABLE, MySQL 8.4,
// SQL Server CREATE/ALTER TABLE, and Oracle SQL Language Reference.
const accepted: [string, string][] = [
  ['db2', 'CREATE TABLE DB2INST1.PRODUCTS (PRODUCT_ID INTEGER NOT NULL, PRODUCT_NAME VARCHAR(100), PRICE DECIMAL(10,2)) ORGANIZE BY ROW IN USERSPACE1 COMPRESS NO'],
  ['db2', 'CREATE TABLE t (id INTEGER) ORGANIZE BY COLUMN'],
  ['db2', 'CREATE TABLE t (id INTEGER) ORGANIZE BY DIMENSIONS (id) COMPRESS YES ADAPTIVE'],
  ['db2', 'CREATE TABLE t (id INTEGER) DATA CAPTURE CHANGES DISTRIBUTE BY HASH (id)'],
  ['db2', 'CREATE TABLE t (id INTEGER) DATA CAPTURE NONE DISTRIBUTE BY RANDOM'],
  ['db2', 'CREATE TABLE t (id INTEGER) PARTITION BY RANGE (YEAR("HIREDATE") NULLS LAST) (PARTITION p_1 STARTING FROM 1 INCLUSIVE ENDING AT 10 EXCLUSIVE)'],
  ['db2', 'ALTER TABLE t ADD CONSTRAINT ck_t CHECK (id > 0) NOT ENFORCED TRUSTED'],
  ['db2', "CREATE TABLE t (id INTEGER, event_at TIMESTAMP) PARTITION BY RANGE (event_at) (PARTITION p_old STARTING MINVALUE ENDING ('2027-01-01-00.00.00.000000'), PARTITION p_max STARTING ('2027-01-01-00.00.00.000000') ENDING MAXVALUE)"],
  ['db2', "CREATE TABLE t (event_at TIMESTAMP) PARTITION BY RANGE (event_at) (PARTITION p_1 STARTING FROM '2027-01-01-00.00.00.000000' INCLUSIVE ENDING AT '2028-01-01-00.00.00.000000' EXCLUSIVE IN userspace1)"],
  ['db2', 'ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (id) ENFORCED'],
  ['db2', 'ALTER TABLE t ADD CONSTRAINT ck_t CHECK (id > 0) NOT ENFORCED'],
  ['db2', 'CREATE TABLE t (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES p (id) ON DELETE CASCADE)'],
  ['postgresql', 'CREATE TABLE public.events (id integer, event_date date) PARTITION BY RANGE (event_date)'],
  ['postgresql', 'CREATE TABLE public.events (id integer) PARTITION BY HASH (id)'],
  ['postgresql', 'CREATE TABLE public.events (region text) PARTITION BY LIST (region)'],
  ['postgresql', 'CREATE TABLE public.events (id integer) TABLESPACE pg_default'],
  ['postgresql', 'CREATE TEMP TABLE events (id integer) ON COMMIT DROP'],
  ['postgresql', 'CREATE TEMP TABLE events (id integer) ON COMMIT PRESERVE ROWS'],
  ['postgresql', 'CREATE TEMP TABLE events (id integer) ON COMMIT DELETE ROWS'],
  ['postgresql', 'ALTER TABLE public.events ADD COLUMN IF NOT EXISTS note text'],
  ['postgresql', 'ALTER TABLE public.events DROP CONSTRAINT IF EXISTS fk_events'],
  ['postgresql', 'CREATE TABLE t (pid integer REFERENCES p (id) ON DELETE CASCADE ON UPDATE SET NULL)'],
  ['mysql', 'CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (a * 2) STORED, c INT AS (a + 1) VIRTUAL)'],
  ['mysql', 'CREATE TABLE t (id INT, created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB'],
  ['mysql', 'CREATE TABLE t (id INT, CHECK ((id > 0))) ENGINE=InnoDB'],
  ['mysql', 'CREATE TABLE t (pid INT, FOREIGN KEY (pid) REFERENCES p (id) ON DELETE CASCADE ON UPDATE RESTRICT) ENGINE=InnoDB'],
  ['mssql', 'ALTER TABLE [dbo].[T] ADD [Note] NVARCHAR(50) NULL CONSTRAINT [DF_T_Note] DEFAULT (N\'x\')'],
  ['mssql', 'ALTER TABLE [dbo].[T] ALTER COLUMN [Note] NVARCHAR(100) NOT NULL'],
  ['mssql', 'CREATE TABLE [dbo].[Child] ([Pid] INT NULL, FOREIGN KEY ([Pid]) REFERENCES [dbo].[Parent] ([Id]) ON DELETE CASCADE ON UPDATE NO ACTION)'],
  ['oracle', 'CREATE TABLE app.orders (id NUMBER(10) NOT NULL, code VARCHAR2(40))'],
  ['oracle', 'CREATE TABLE "App"."Orders" (id NUMBER(10) NOT NULL)'],
  ['oracle', 'CREATE TABLE app.child (pid NUMBER REFERENCES app.parent (id) ON DELETE CASCADE)'],
  ['oracle', 'CREATE TABLE app.child (pid NUMBER REFERENCES app.parent (id) ON DELETE SET NULL)'],
  ['oracle', 'SELECT app.pkg.calc_total(1) FROM app.orders'],
  ['oracle', 'SELECT app.orders.id FROM app.orders'],
];

describe('Dialect DDL conformance regressions', () => {
  it.each(accepted)('%s accepts %s', (databaseKind, sql) => {
    const result = parseSqlStatements({ databaseKind, sql });
    expect(result.lexResult.errors).toEqual([]);
    expect(result.actionableParserErrors.map(error => error.message)).toEqual([]);
    expect(result.cst).toBeDefined();
  });

  it('keeps Oracle qualified names as separate offset-stable tokens', () => {
    const result = oracleLexer.tokenize('CREATE TABLE app.orders (id NUMBER)');
    expect(result.tokens.slice(2, 5).map(token => token.image)).toEqual(['app', '.', 'orders']);
  });

  it('validates the original DB2 script, including its enforced primary key', () => {
    const sql = `${accepted[0][1]}; ALTER TABLE DB2INST1.PRODUCTS ADD CONSTRAINT pk_products PRIMARY KEY (PRODUCT_ID) ENFORCED;`;
    const result = new SqlValidator(undefined, db2SqlAuthoring.validation).validate(sql);
    expect(result.errors.filter(error => error.code.startsWith('PAR'))).toEqual([]);
  });

  it.each([
    ['db2', 'CREATE TABLE t (id INTEGER) ORGANIZE BY BANANA'],
    ['db2', 'CREATE TABLE t (id INTEGER) COMPRESS MAYBE'],
    ['db2', 'CREATE TABLE t (id INTEGER) DISTRIBUTE ON (id)'],
    ['db2', 'CREATE TABLE t (id INTEGER) DATA CAPTURE'],
    ['db2', 'CREATE TABLE t (pid INTEGER REFERENCES p (id) ON UPDATE NO ACTION)'],
    ['mysql', 'CREATE TABLE t (id INTEGER) DISTRIBUTE ON (id)'],
    ['mysql', 'CREATE TABLE t (id INTEGER) ORGANIZE BY ROW'],
    ['postgresql', 'CREATE TABLE t (id integer) PARTITION BY RANGE ()'],
    ['postgresql', 'CREATE TABLE t (id integer) ON COMMIT BANANA'],
    ['postgresql', 'CREATE TABLE t (id integer) DISTRIBUTE ON (id)'],
    ['postgresql', 'ALTER TABLE t ADD IF NOT EXISTS CONSTRAINT pk_t PRIMARY KEY (id)'],
    ['mysql', 'CREATE TABLE t (a INT AS ((1 + 2) STORED)'],
    ['mysql', 'CREATE TABLE t (a INT DEFAULT f(1)'],
    ['mssql', 'CREATE TABLE t (pid INT REFERENCES p (id) ON DELETE RESTRICT)'],
    ['oracle', 'CREATE TABLE t (pid NUMBER REFERENCES p (id) ON UPDATE CASCADE)'],
    ['oracle', 'CREATE TABLE t (id NUMBER) DISTRIBUTE ON (id)'],
    ['netezza', 'CREATE TABLE t (id INTEGER) ORGANIZE BY ROW IN USERSPACE1 COMPRESS NO'],
    ['netezza', 'CREATE TABLE t (id INTEGER) PARTITION BY RANGE (id)'],
  ])('%s rejects %s', (databaseKind, sql) => {
    expect(parseSqlStatements({ databaseKind, sql }).actionableParserErrors.length).toBeGreaterThan(0);
  });
});
