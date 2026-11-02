/**
 * Live check of the NZPLSQL the product inserts: every NZPLSQL snippet and
 * every procedure wizard template is created and called on a real Netezza
 * (the body is compiled only at CALL, so CREATE alone proves little).
 *
 *   NZ_DEV_PASSWORD=... NZ_DEV_ALLOW_FIXTURE_DDL=1 \
 *     npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/nzplsqlArtifacts.live.integration.test.ts
 *
 * Fixture tables and procedures carry unique names and are dropped in
 * `finally`/`afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { NzConnection } from "@justybase/netezza-driver";

import {
  buildNetezzaLiveDetails,
  netezzaFixtureEnabled,
  uniqueNetezzaName,
} from "./netezzaLiveTestHarness";
import {
  buildNzplsqlArtifactCases,
  NZPLSQL_ARTIFACT_FIXTURES,
  NZPLSQL_ARTIFACT_SEED,
  renderNzplsqlArtifactSql,
  type NzplsqlArtifactNames,
} from "../sqlParser/procedure/nzplsqlArtifactCases";

const describeIfFixture = netezzaFixtureEnabled ? describe : describe.skip;

function normalize(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

describeIfFixture("NZPLSQL artifacts (live)", () => {
  const details = buildNetezzaLiveDetails();
  const schema = (process.env.NZ_DEV_SCHEMA || "ADMIN").trim().toUpperCase();
  const tables = Object.fromEntries(
    Object.keys(NZPLSQL_ARTIFACT_FIXTURES).map((key) => [key, uniqueNetezzaName(`JBL_ART_${key}`)]),
  );
  const baseNames: Omit<NzplsqlArtifactNames, "procName"> = {
    db: details.database.toUpperCase(),
    schema,
    tables,
  };
  let connection: NzConnection;

  beforeAll(async () => {
    connection = new NzConnection({
      host: details.host,
      port: details.port,
      database: details.database,
      user: details.user,
      password: details.password || "",
    });
    await connection.connect();
    const names = { ...baseNames, procName: "UNUSED" };
    for (const [key, columns] of Object.entries(NZPLSQL_ARTIFACT_FIXTURES)) {
      await connection.execute(`CREATE TABLE ${schema}.${tables[key]} (${columns})`);
    }
    for (const statement of NZPLSQL_ARTIFACT_SEED) {
      await connection.execute(renderNzplsqlArtifactSql(statement, names));
    }
  }, 120_000);

  afterAll(async () => {
    if (!connection) {
      return;
    }
    for (const table of Object.values(tables)) {
      try {
        await connection.execute(`DROP TABLE ${schema}.${table}`);
      } catch {
        // best effort cleanup
      }
    }
    await connection.close();
  }, 60_000);

  for (const testCase of buildNzplsqlArtifactCases()) {
    it(`${testCase.source}: CREATE ok, CALL ${testCase.call}`, async () => {
      const names = { ...baseNames, procName: uniqueNetezzaName(`JBL_ART_${testCase.id}`.slice(0, 40)) };
      const procedure = `${schema}.${names.procName}`;
      let created = false;
      try {
        await connection.execute(renderNzplsqlArtifactSql(testCase.sql, names));
        created = true;

        let rows: unknown[][] = [];
        let notices: string[] = [];
        let error: string | undefined;
        try {
          const result = await connection.query(`CALL ${procedure}(${testCase.callArgs})`);
          rows = result.rows.map((row) => Object.values(row as Record<string, unknown>));
          notices = result.notices.map((notice) => notice.replace(/^NOTICE:\s*/i, "").trim());
        } catch (callError) {
          error = callError instanceof Error ? callError.message : String(callError);
        }

        if (testCase.call === "error") {
          expect(error).toBeDefined();
          expect(error ?? "").toContain(testCase.errorIncludes ?? "");
          return;
        }
        expect(error).toBeUndefined();
        for (const fragment of testCase.expectNotices ?? []) {
          expect(notices).toContain(fragment);
        }
        if (testCase.expectValue !== undefined) {
          expect(normalize(rows[0]?.[0])).toEqual(testCase.expectValue);
        }
      } finally {
        if (created) {
          try {
            await connection.execute(`DROP PROCEDURE ${procedure}(${testCase.dropSignature})`);
          } catch {
            // best effort cleanup
          }
        }
      }
    }, 60_000);
  }
});
