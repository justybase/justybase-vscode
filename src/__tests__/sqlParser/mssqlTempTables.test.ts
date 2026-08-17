jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import { mssqlSqlAuthoring } from '../../../extensions/mssql/src/sql/authoring';
import { analyzeSqlScriptFlow } from '../../sqlParser/flowAnalyzer';
import { analyzeSqlQueryStructures } from '../../sqlParser/queryStructureAnalyzer';
import { collectSqlSymbolUsages } from '../../sqlParser/symbols';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { buildStatementIndex } from '../../sqlParser/statementIndex';
import { SqlValidator } from '../../sqlParser/validator';

const validate = (sql: string) =>
  new SqlValidator(undefined, mssqlSqlAuthoring.validation).validate(sql);

describe('MSSQL temporary tables', () => {
  it('validates local and global temp table references across a script', () => {
    const result = validate(`
      CREATE TABLE #local_temp (ID INT, NAME VARCHAR(20));
      INSERT INTO #local_temp (ID, NAME) VALUES (1, 'one');
      UPDATE #local_temp SET NAME = 'updated' WHERE ID = 1;
      SELECT ID, NAME FROM #local_temp;
      SELECT #local_temp.* FROM #local_temp;
      SELECT [#local_temp].* FROM [#local_temp];
      DROP TABLE #local_temp;
      CREATE TABLE ##global_temp (ID INT);
      SELECT ID FROM ##global_temp;
      DROP TABLE IF EXISTS ##global_temp;
    `);

    expect(result.errors).toEqual([]);
  });

  it('registers SELECT INTO temp tables with inferred columns', () => {
    const result = validate(`
      SELECT ID, NAME INTO #selected_temp FROM dbo.SourceTable;
      SELECT ID, NAME FROM #selected_temp;
    `);

    expect(result.errors).toEqual([]);
    expect(result.scope.tables.get('#SELECTED_TEMP')).toMatchObject({
      name: '#selected_temp',
      isTempTable: true,
      columns: [{ name: 'ID' }, { name: 'NAME' }],
    });
  });

  it('keeps SELECT INTO temp tables created by a CTE query at script scope', () => {
    const result = validate(`
      WITH source_rows AS (SELECT 1 AS ID, 'one' AS NAME)
      SELECT ID, NAME INTO #cte_temp FROM source_rows;
      SELECT ID, NAME FROM #cte_temp;
    `);

    expect(result.errors).toEqual([]);
    expect(result.scope.tables.get('#CTE_TEMP')).toMatchObject({
      name: '#cte_temp',
      isTempTable: true,
      columns: [{ name: 'ID' }, { name: 'NAME' }],
    });
  });

  it('normalizes bracketed SELECT INTO temp targets', () => {
    const result = validate(`
      SELECT ID INTO [#bracketed_temp] FROM dbo.SourceTable;
      SELECT ID FROM [#bracketed_temp];
    `);

    expect(result.errors).toEqual([]);
    expect(result.scope.tables.get('#BRACKETED_TEMP')).toMatchObject({
      name: '#bracketed_temp',
      isTempTable: true,
    });
  });

  it('collects bracketed SELECT INTO temp definitions and references', () => {
    const usages = collectSqlSymbolUsages(
      'SELECT ID INTO [#symbol_temp] FROM dbo.SourceTable; SELECT ID FROM [#symbol_temp];',
      'mssql',
    );
    const temp = usages.find(
      (usage) => usage.kind === 'table' && usage.name === '#symbol_temp',
    );

    expect(temp?.occurrences.map((occurrence) => occurrence.role)).toEqual([
      'definition',
      'reference',
    ]);
  });

  it('rejects generic CREATE TEMP TABLE syntax for MSSQL', () => {
    const result = validate('CREATE GLOBAL TEMP TABLE not_tsql (ID INT);');

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('seeds SELECT INTO temp tables during incremental validation', () => {
    const sql = `SELECT ID INTO #incremental_temp FROM dbo.SourceTable;
                 SELECT ID FROM #incremental_temp;`;
    const index = buildStatementIndex(sql);
    const schemaProvider = new InMemorySchemaProvider(true);
    schemaProvider.createTable(undefined, 'dbo', 'SourceTable', ['ID']);
    const result = new SqlValidator(schemaProvider, mssqlSqlAuthoring.validation)
      .validateIncrementalFromStatements(
        sql,
        index.statements,
        [1],
        new Map([[0, []]]),
      );

    expect(result.errors).toEqual([]);
  });

  it('collects definitions and references for temp tables', () => {
    const usages = collectSqlSymbolUsages(
      `CREATE TABLE #temp_symbols (ID INT);
       INSERT INTO #temp_symbols (ID) VALUES (1);
       SELECT ID FROM #temp_symbols;
       DROP TABLE #temp_symbols;`,
      'mssql',
    );
    const temp = usages.find(
      (usage) => usage.kind === 'table' && usage.name === '#temp_symbols',
    );

    expect(temp?.occurrences.map((occurrence) => occurrence.role)).toEqual([
      'definition',
      'reference',
      'reference',
      'reference',
    ]);
  });

  it('tracks aliases used by qualified star expressions', () => {
    const usages = collectSqlSymbolUsages(
      'CREATE TABLE #star_temp (ID INT); SELECT t.* FROM #star_temp AS t;',
      'mssql',
    );
    const alias = usages.find(
      (usage) => usage.kind === 'table_alias' && usage.name === 't',
    );

    expect(alias?.occurrences.map((occurrence) => occurrence.role)).toEqual([
      'reference',
      'definition',
    ]);
  });

  it('tracks MSSQL temp tables in script flow analysis', () => {
    const analysis = analyzeSqlScriptFlow(
      `CREATE TABLE #flow_temp (ID INT);
       INSERT INTO #flow_temp (ID) VALUES (1);
       SELECT ID FROM #flow_temp;
       DROP TABLE #flow_temp;`,
      'mssql',
    );
    const tempEdges = analysis.lineage.filter(
      (edge) => edge.objectName === '#flow_temp',
    );

    expect(tempEdges.map((edge) => edge.action)).toEqual([
      'insert',
      'read',
      'drop',
    ]);
  });

  it('classifies multiline and CTE INSERT statements as inserts', () => {
    const analysis = analyzeSqlScriptFlow(
      `CREATE TABLE #formatted_flow (ID INT);
       INSERT
       INTO #formatted_flow (ID) VALUES (1);
       WITH source_rows AS (SELECT 2 AS ID)
       INSERT INTO #formatted_flow (ID)
       SELECT ID FROM source_rows;`,
      'mssql',
    );
    const tempEdges = analysis.lineage.filter(
      (edge) => edge.objectName === '#formatted_flow',
    );

    expect(tempEdges.map((edge) => edge.action)).toEqual(['insert', 'insert']);
  });

  it('removes bracketed temp tables from incremental scope', () => {
    const sql = `CREATE TABLE #incremental_drop (ID INT);
                 DROP TABLE [#incremental_drop];
                 SELECT ID FROM #incremental_drop;`;
    const index = buildStatementIndex(sql);
    const schemaProvider = new InMemorySchemaProvider(true);
    const result = new SqlValidator(schemaProvider, mssqlSqlAuthoring.validation)
      .validateIncrementalFromStatements(
        sql,
        index.statements,
        [2],
        new Map([[0, []], [1, []]]),
      );

    expect(result.errors.some((error) => error.code === 'SQL006')).toBe(true);
  });

  it('tracks CREATE TABLE and SELECT INTO temp relations in query structures', () => {
    const analysis = analyzeSqlQueryStructures(
      `CREATE TABLE #created_temp (ID INT);
       SELECT ID FROM #created_temp;
       SELECT ID INTO #selected_temp FROM #created_temp;
       SELECT ID FROM #selected_temp;`,
      'mssql',
    );
    const tempNodes = analysis.statementFlows
      .flatMap((flow) => flow.nodes)
      .filter((node) => node.kind === 'temp_table');

    expect(tempNodes.map((node) => node.label)).toEqual([
      '#created_temp',
      '#created_temp',
      '#selected_temp',
    ]);
  });
});
