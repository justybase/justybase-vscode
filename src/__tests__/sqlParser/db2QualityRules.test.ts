jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import { db2SqlAuthoring } from '../../../extensions/db2/src/sql/authoring';
import {
	ruleDB2001,
	ruleDB2002,
	ruleDB2003,
	ruleDB2004,
	ruleDB2005,
	ruleDB2006,
	ruleDB2007,
	ruleDB2008,
} from '../../../extensions/db2/src/sql/qualityRules';
import { SqlQualityEngine } from '../../providers/sqlQualityEngine';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { SqlValidator } from '../../sqlParser/validator';

describe('Db2 quality rules', () => {
	it('wires DB2001–DB2008 into authoring', () => {
		expect(db2SqlAuthoring.qualityRules.map((rule) => rule.id)).toEqual([
			'DB2001',
			'DB2002',
			'DB2003',
			'DB2004',
			'DB2005',
			'DB2006',
			'DB2007',
			'DB2008',
		]);
	});

	it('uses strict syntax validation and identifies as Db2', () => {
		expect(db2SqlAuthoring.validation.syntaxValidationMode).toBe('strict');
		expect(db2SqlAuthoring.validation.databaseKind).toBe('db2');
	});

	it('offers the SET CURRENT registers in completion', () => {
		expect(db2SqlAuthoring.completionKeywords).toEqual(
			expect.arrayContaining([
				'CURRENT SQLID',
				'CURRENT EXPLAIN MODE',
				'CURRENT LOCK TIMEOUT',
				'CURRENT MAINTAINED TABLE TYPES FOR OPTIMIZATION',
				'CURRENT TEMPORAL SYSTEM_TIME',
			]),
		);
	});

	it('flags SELECT * as DB2001', () => {
		const issues = ruleDB2001.check('SELECT * FROM T');
		expect(issues).toHaveLength(1);
		expect(issues[0].ruleId).toBe('DB2001');
	});

	it('flags DELETE/UPDATE without WHERE', () => {
		expect(ruleDB2002.check('DELETE FROM T').map((i) => i.ruleId)).toEqual(['DB2002']);
		expect(ruleDB2003.check('UPDATE T SET X = 1').map((i) => i.ruleId)).toEqual(['DB2003']);
	});

	it('rejects Netezza-only GROOM and DISTRIBUTE ON', () => {
		expect(ruleDB2004.check('GROOM TABLE T').map((i) => i.ruleId)).toEqual(['DB2004']);
		expect(ruleDB2005.check('CREATE TABLE T (A INT) DISTRIBUTE ON (A)').map((i) => i.ruleId)).toEqual([
			'DB2005',
		]);
	});

	it('flags FETCH FIRST / OPTIMIZE FOR without ORDER BY', () => {
		expect(ruleDB2006.check('SELECT * FROM T FETCH FIRST 5 ROWS ONLY').map((i) => i.ruleId)).toEqual([
			'DB2006',
		]);
		expect(
			ruleDB2006.check('SELECT * FROM T ORDER BY ID FETCH FIRST 5 ROWS ONLY').map((i) => i.ruleId),
		).toEqual([]);
	});

	it('rejects LIMIT and DB..TABLE notation', () => {
		expect(ruleDB2007.check('SELECT * FROM T LIMIT 10').map((i) => i.ruleId)).toEqual(['DB2007']);
		expect(ruleDB2008.check('SELECT * FROM DB..TABLE').map((i) => i.ruleId)).toEqual(['DB2008']);
	});

	it('runs through SqlQualityEngine with Db2 authoring', () => {
		const engine = new SqlQualityEngine(
			new SqlValidator(undefined, db2SqlAuthoring.validation),
			db2SqlAuthoring.qualityRules,
		);
		const result = engine.analyze('SELECT * FROM T; GROOM TABLE T');
		expect(result.issues.map((issue) => issue.ruleId)).toEqual(
			expect.arrayContaining(['DB2001', 'DB2004']),
		);
	});

	it('strict validator surfaces parser errors for Netezza LIMIT', () => {
		const engine = new SqlQualityEngine(
			new SqlValidator(undefined, db2SqlAuthoring.validation),
			db2SqlAuthoring.qualityRules,
		);
		const result = engine.analyze('SELECT * FROM T LIMIT 1');
		expect(result.parserResult.errors.length).toBeGreaterThan(0);
		expect(result.issues.map((issue) => issue.ruleId)).toContain('DB2007');
	});

	it('emits SQL037/SQL039/SQL040 for Db2 SQL PL units', () => {
		const validator = new SqlValidator(undefined, db2SqlAuthoring.validation);
		const procedure = [
			'CREATE PROCEDURE app.p (IN p_in INTEGER, OUT p_out INTEGER)',
			'LANGUAGE SQL',
			'BEGIN',
			'  DECLARE v_unused INTEGER;',
			'  DECLARE v_used INTEGER DEFAULT 0;',
			'  SET v_used = p_in;',
			'  SET p_out = v_used;',
			'  SELECT id INTO v_used FROM app.t WHERE id = p_in;',
			'  SELECT id FROM app.t;',
			'  RETURN;',
			'END',
		].join('\n');
		const warnings = validator.validate(procedure).warnings.map(warning => warning.code);
		expect(warnings).toContain('SQL037');
		expect(warnings).toContain('SQL039');
		expect(warnings).not.toContain('SQL040');
		expect(warnings).not.toContain('SQL038');

		const clean = [
			'CREATE PROCEDURE app.p (IN p_in INTEGER, OUT p_out INTEGER)',
			'LANGUAGE SQL',
			'BEGIN',
			'  DECLARE v_used INTEGER DEFAULT 0;',
			'  SET v_used = p_in;',
			'  SET p_out = v_used;',
			'  SELECT id INTO v_used FROM app.t;',
			'END',
		].join('\n');
		expect(validator.validate(clean).warnings.map(warning => warning.code)).toEqual([]);
	});

	it('does not flag Db2 INSERT…SELECT or nested SELECT as SQL037', () => {
		const validator = new SqlValidator(undefined, db2SqlAuthoring.validation);
		const sql = [
			'CREATE PROCEDURE app.p (IN p_in INTEGER)',
			'LANGUAGE SQL',
			'BEGIN',
			'  INSERT INTO app.t (id) SELECT p_in FROM SYSIBM.SYSDUMMY1;',
			'END',
		].join('\n');
		expect(validator.validate(sql).warnings.map(warning => warning.code)).toEqual([]);
	});

	it('reports SQL040 for an unassigned Db2 OUT parameter', () => {
		const validator = new SqlValidator(undefined, db2SqlAuthoring.validation);
		const sql = [
			'CREATE PROCEDURE app.p (OUT p_out INTEGER)',
			'LANGUAGE SQL',
			'BEGIN',
			'  DECLARE v INT DEFAULT 1;',
			'  SET v = 2;',
			'END',
		].join('\n');
		expect(validator.validate(sql).warnings.map(warning => warning.code)).toContain('SQL040');
	});

	it('reports SQL037 for a standalone SELECT in a Db2 trigger body', () => {
		const validator = new SqlValidator(undefined, db2SqlAuthoring.validation);
		const trigger = [
			'CREATE TRIGGER app.trg AFTER INSERT ON app.t',
			'REFERENCING NEW AS N FOR EACH ROW MODE DB2SQL',
			'BEGIN ATOMIC',
			'  SELECT id FROM app.t;',
			'  SET N.amount = 0;',
			'END',
		].join('\n');
		expect(validator.validate(trigger).warnings.map(warning => warning.code)).toContain('SQL037');

		const clean = trigger.replace('SELECT id FROM app.t;', 'SELECT id INTO v_id FROM app.t;');
		expect(validator.validate(clean).warnings.map(warning => warning.code)).toEqual([]);
	});

	it('treats Db2 special registers as registers, not columns', () => {
		const schemaProvider = new InMemorySchemaProvider(true);
		schemaProvider.addTable({
			name: 'SYSDUMMY1',
			database: 'TESTDB',
			schema: 'SYSIBM',
			isCte: false,
			isTempTable: false,
			columns: [{ name: 'IBMREQD', dataType: 'CHAR(1)' }],
		});
		const validator = new SqlValidator(schemaProvider, db2SqlAuthoring.validation);

		expect(
			validator.validate('SELECT CURRENT SQLID FROM SYSIBM.SYSDUMMY1').warnings.map(warning => warning.code),
		).toEqual([]);
		expect(
			validator
				.validate('SELECT CURRENT PATH, CURRENT LOCK TIMEOUT FROM SYSIBM.SYSDUMMY1')
				.warnings.map(warning => warning.code),
		).toEqual([]);
		expect(
			validator.validate(`SET CURRENT SQLID = 'DB2INST1'`).warnings.map(warning => warning.code),
		).toEqual([]);
	});

	it('emits SQL004 and SQL025 against an in-memory Db2 schema', () => {
		const schemaProvider = new InMemorySchemaProvider(true);
		schemaProvider.addTable({
			name: 'ORDERS',
			database: 'TESTDB',
			schema: 'APP',
			isCte: false,
			isTempTable: false,
			columns: [
				{ name: 'ID', dataType: 'INTEGER' },
				{ name: 'NOTE', dataType: 'VARCHAR(40)' },
			],
		});
		const engine = new SqlQualityEngine(
			new SqlValidator(schemaProvider, db2SqlAuthoring.validation),
			db2SqlAuthoring.qualityRules,
		);

		const unknown = engine.analyze('SELECT BAD_COL FROM APP.ORDERS');
		expect(unknown.parserResult.errors.some((error) => error.code === 'SQL004')).toBe(true);

		const typeMismatch = engine.analyze("SELECT ID FROM APP.ORDERS WHERE ID = 'x'");
		expect(
			typeMismatch.parserResult.warnings.some((warning) => warning.code === 'SQL025')
				|| typeMismatch.issues.some((issue) => issue.ruleId === 'SQL025'),
		).toBe(true);
	});
});
