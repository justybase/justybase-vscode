/**
 * Live NZPLSQL procedure matrix.
 *
 * Proves each grammar rule in `procedureMatrixCases.ts` against a real Netezza
 * instance:
 *   1. CREATE PROCEDURE  -> header/registration verdict.
 *   2. CALL              -> NZPLSQL body is compiled lazily and executed.
 *   `RAISE NOTICE 'STEP_xx ...'` markers identify how far execution reached.
 *
 * Run (fixture DDL is required because the suite creates/drops procedures and a
 * temporary table):
 *
 *   NZ_DEV_PASSWORD=... NZ_DEV_ALLOW_FIXTURE_DDL=1 \
 *     npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/nzplsqlProcedureMatrix.live.integration.test.ts
 *
 * The suite is best effort: a mismatching row fails its own test and the
 * remaining rows still run. Every created object is dropped in `finally`.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { NzConnection } from "@justybase/netezza-driver";

import {
  buildNetezzaLiveDetails,
  netezzaFixtureEnabled,
  uniqueNetezzaName,
} from "./netezzaLiveTestHarness";
import {
  PROCEDURE_MATRIX_CASES,
  renderProcedureMatrixSql,
  type ProcedureMatrixPhase,
} from "../sqlParser/procedure/procedureMatrixCases";

const describeIfFixture = netezzaFixtureEnabled ? describe : describe.skip;

interface CallOutcome {
  status: "ok" | "error";
  message?: string;
  notices: string[];
  rows: unknown[][];
}

function classifyCallPhase(outcome: CallOutcome): ProcedureMatrixPhase | undefined {
  if (outcome.status !== "error") {
    return undefined;
  }
  const noticeText = outcome.notices.join("\n");
  if (
    /plpgsql: ERROR during compile of/.test(noticeText) ||
    /syntax error|unexpected/.test(outcome.message ?? "")
  ) {
    return "body-compile";
  }
  return "runtime";
}

function normalizeNotices(notices: string[]): string[] {
  return notices.map((notice) => notice.replace(/^NOTICE:\s*/i, "").trim());
}

/** Normalize driver values (bigint) so result-set assertions stay stable. */
function normalizeRows(rows: unknown[][]): unknown[][] {
  return JSON.parse(
    JSON.stringify(rows, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    ),
  ) as unknown[][];
}

/**
 * Netezza requires the argument-type list on DROP PROCEDURE. Derive it from the
 * rendered CREATE statement (stripping the optional IN mode).
 */
function deriveDropSignature(createSql: string, procName: string): string {
  const nameIndex = createSql.indexOf(procName);
  const open = nameIndex < 0 ? -1 : createSql.indexOf("(", nameIndex + procName.length);
  if (open < 0) {
    return "";
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < createSql.length; i += 1) {
    const ch = createSql[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    return "";
  }
  const inner = createSql.slice(open + 1, end).trim();
  if (inner.length === 0) {
    return "";
  }
  const parts: string[] = [];
  let segmentDepth = 0;
  let segmentStart = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(") {
      segmentDepth += 1;
    } else if (ch === ")") {
      segmentDepth -= 1;
    }
    if ((ch === "," && segmentDepth === 0) || i === inner.length) {
      const segment = inner
        .slice(segmentStart, i)
        .trim()
        .replace(/^IN\s+/i, "");
      if (segment.length > 0) {
        parts.push(segment);
      }
      segmentStart = i + 1;
    }
  }
  return parts.join(", ");
}

describeIfFixture("NZPLSQL procedure matrix (live)", () => {
  const details = buildNetezzaLiveDetails();
  const schema = (process.env.NZ_DEV_SCHEMA || "ADMIN").trim().toUpperCase();
  const tableName = uniqueNetezzaName("JBL_MATRIX_T");
  const qualifiedTable = `${schema}.${tableName}`;
  const createdProcedures = new Map<string, string>();
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
    await connection.execute(`CREATE TABLE ${qualifiedTable} (id INT, name VARCHAR(20))`);
    await connection.execute(`INSERT INTO ${qualifiedTable} VALUES (1, 'a')`);
    await connection.execute(`INSERT INTO ${qualifiedTable} VALUES (2, 'b')`);
  }, 120_000);

  afterAll(async () => {
    if (!connection) {
      return;
    }
    for (const [proc, signature] of createdProcedures) {
      try {
        await connection.execute(`DROP PROCEDURE ${proc}(${signature})`);
      } catch {
        // best effort cleanup
      }
    }
    try {
      await connection.execute(`DROP TABLE ${qualifiedTable}`);
    } catch {
      // best effort cleanup
    }
    await connection.close();
  }, 60_000);

  for (const testCase of PROCEDURE_MATRIX_CASES) {
    it(`${testCase.group}/${testCase.id}: create=${testCase.create} call=${testCase.call}`, async () => {
      const procName = `${schema}.${uniqueNetezzaName(`JBL_PR_${testCase.id}`)}`;
      const createSql = renderProcedureMatrixSql(testCase.sql, procName, qualifiedTable);

      let createError: string | undefined;
      const dropSignature = deriveDropSignature(createSql, procName);
      try {
        await connection.execute(createSql);
        createdProcedures.set(procName, dropSignature);
      } catch (error) {
        createError = error instanceof Error ? error.message : String(error);
      }

      try {
        if (testCase.create === "ok") {
          expect(createError).toBeUndefined();
        } else {
          expect(createError).toBeDefined();
        }

        if (createError || testCase.call === "skip") {
          return;
        }

        const callSql =
          testCase.callSql !== undefined
            ? renderProcedureMatrixSql(testCase.callSql, procName, qualifiedTable)
            : `CALL ${procName}(${testCase.callArgs ?? ""})`;

        let outcome: CallOutcome;
        try {
          const result = await connection.query(callSql);
          outcome = {
            status: "ok",
            notices: [...result.notices],
            rows: result.rows.map((row) => Object.values(row as Record<string, unknown>)),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outcome = { status: "error", message, notices: [], rows: [] };
        }

        if (testCase.call === "ok") {
          expect(outcome.status).toBe("ok");
          if (testCase.expectNotices) {
            const notices = normalizeNotices(outcome.notices);
            for (const fragment of testCase.expectNotices) {
              expect(notices.join("\n")).toContain(fragment);
            }
          }
          if (testCase.expectRows) {
            expect(normalizeRows(outcome.rows)).toEqual(testCase.expectRows);
          }
        } else {
          expect(outcome.status).toBe("error");
          if (testCase.callPhase) {
            expect(classifyCallPhase(outcome)).toBe(testCase.callPhase);
          }
          if (testCase.errorIncludes) {
            expect(outcome.message ?? "").toContain(testCase.errorIncludes);
          }
        }
      } finally {
        if (createdProcedures.has(procName)) {
          try {
            await connection.execute(
              `DROP PROCEDURE ${procName}(${createdProcedures.get(procName)})`,
            );
          } catch {
            // best effort cleanup
          } finally {
            createdProcedures.delete(procName);
          }
        }
      }
    }, 60_000);
  }
});
