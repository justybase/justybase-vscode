jest.unmock('chevrotain');

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from '@jest/globals';
import { createSqlParserInstance } from '../../dialects/mssql/sql/parser';

describe('MsSqlSqlParser construction performance', () => {
	it('creates a parser within the 2000 ms initialization budget', () => {
		const startedAt = performance.now();
		const parser = createSqlParserInstance();
		const elapsedMs = performance.now() - startedAt;

		expect(parser).toBeDefined();
		expect(elapsedMs).toBeLessThan(2000);
	});
});
