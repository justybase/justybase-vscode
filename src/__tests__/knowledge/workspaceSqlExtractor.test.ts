jest.unmock("chevrotain");

import {
  canonicalizeRelation,
} from "@justybase/sql-core/joinKnowledge";
import {
  extractWorkspaceSql,
  __TEST_ONLY_parseQualifiedTableName,
} from "../../knowledge/workspaceSqlExtractor";

const fingerprint = (normalized: string): string => normalized;

function extract(sql: string) {
  return extractWorkspaceSql(sql, {
    databaseKind: "netezza",
    fingerprint,
  });
}

function relationKey(
  left: string,
  right: string,
  columns: Array<[string, string]>,
): string {
  const relation = canonicalizeRelation(
    {
      left: { database: "BAZA", schema: "ADMIN", table: left },
      right: { database: "BAZA", schema: "ADMIN", table: right },
      columns: columns.map(([leftColumn, rightColumn]) => ({
        left: leftColumn,
        right: rightColumn,
      })),
    },
    "netezza",
  );
  if (!relation) {
    throw new Error("invalid test relation");
  }
  return relation.key;
}

describe("workspace SQL extractor", () => {
  it("extracts a qualified composite join and normalizes both directions", () => {
    const forward = extract(
      "SELECT * FROM BAZA.ADMIN.USERS U "
      + "JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID AND U.TENANT_ID = O.TENANT_ID;",
    );
    const reverse = extract(
      "SELECT * FROM BAZA.ADMIN.ORDERS O "
      + "JOIN BAZA.ADMIN.USERS U ON O.OWNER_ID = U.USER_ID AND O.TENANT_ID = U.TENANT_ID;",
    );
    const expected = relationKey("USERS", "ORDERS", [
      ["USER_ID", "OWNER_ID"],
      ["TENANT_ID", "TENANT_ID"],
    ]);
    expect(forward.relations).toHaveLength(1);
    expect(reverse.relations).toHaveLength(1);
    expect(forward.relations[0].relation.key).toBe(expected);
    expect(reverse.relations[0].relation.key).toBe(expected);
    // Only the FROM source is object usage; the JOIN target ranks as a relation.
    expect(forward.objects).toEqual([
      expect.objectContaining({
        object: { database: "BAZA", schema: "ADMIN", name: "USERS" },
        kind: "select",
      }),
    ]);
    expect(reverse.objects.map((entry) => entry.object.name)).toEqual(["ORDERS"]);
  });

  it("keeps DB.. and DB.SCHEMA. identities distinct while resolving the same table name", () => {
    const doubleDot = extract(
      "SELECT * FROM BAZA..USERS U JOIN BAZA..ORDERS O ON U.ID = O.OWNER_ID;",
    );
    expect(doubleDot.relations[0].relation.display.left.database).toBe("BAZA");
    expect(doubleDot.relations[0].relation.display.left.schema).toBeUndefined();
    expect(__TEST_ONLY_parseQualifiedTableName("BAZA..USERS")?.ref).toEqual({
      database: "BAZA",
      table: "USERS",
    });
    expect(__TEST_ONLY_parseQualifiedTableName("BAZA.ADMIN.USERS")?.ref).toEqual({
      database: "BAZA",
      schema: "ADMIN",
      table: "USERS",
    });
  });

  it("preserves quoted identifier bytes in the canonical relation", () => {
    const result = extract(
      'SELECT * FROM "MySchema"."Users" "u" '
      + 'JOIN "MySchema"."Orders" "o" ON "u"."UserId" = "o"."OwnerId";',
    );
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].relation.key).toContain("Users");
    expect(result.relations[0].relation.key).toContain("Orders");
    expect(result.relations[0].relation.key).toContain("UserId");
    expect(result.relations[0].relation.key).not.toContain("USERS");
    expect(result.objects.map((entry) => entry.object.name).sort()).toEqual([
      "Users",
    ].sort());
  });

  it("skips ambiguous and unprovable clauses instead of guessing", () => {
    const cases = [
      ["SELECT * FROM A a JOIN B b ON a.x = b.x OR a.y = b.y", "or"],
      ["SELECT * FROM A a JOIN B b USING (ID)", "using"],
      ["SELECT * FROM A a JOIN B b ON a.x > b.x", "non-equality"],
      ["SELECT * FROM A a JOIN B b ON a.x = b.x AND a.y = b.y + 1", "unresolved"],
      ["SELECT * FROM A a JOIN (SELECT * FROM B) b ON a.x = b.x", "subquery"],
      ["SELECT * FROM A a JOIN B b ON x = b.x", "unresolved"],
      ["SELECT * FROM A a JOIN B b ON a.x = c.x", "unresolved"],
    ] as const;
    for (const [sql, reason] of cases) {
      const result = extract(sql);
      expect(result.relations).toHaveLength(0);
      expect(result.skipped[reason]).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not turn CTE names or derived aliases into objects or relations", () => {
    const result = extract(
      "WITH c AS (SELECT * FROM A) "
      + "SELECT * FROM c JOIN B b ON c.ID = b.ID;",
    );
    expect(result.relations).toHaveLength(0);
    // `B` is a JOIN target, not a FROM source.
    expect(result.objects.map((entry) => entry.object.name).sort()).toEqual(["A"]);
  });

  it("counts SELECT, INSERT, UPDATE and DELETE usage separately", () => {
    const result = extract([
      "SELECT * FROM S;",
      "INSERT INTO T SELECT * FROM S;",
      "UPDATE T SET X = 1 FROM S WHERE S.ID = T.ID;",
      "DELETE FROM T WHERE EXISTS (SELECT 1 FROM S WHERE S.ID = T.ID);",
    ].join("\n"));
    const usage = new Map<string, string[]>();
    for (const entry of result.objects) {
      const kinds = usage.get(entry.object.name) ?? [];
      kinds.push(entry.kind);
      usage.set(entry.object.name, kinds);
    }
    expect(usage.get("S")).toEqual(expect.arrayContaining(["select"]));
    expect(usage.get("T")).toEqual(expect.arrayContaining([
      "insert",
      "update",
      "delete",
    ]));
    expect(result.relations).toHaveLength(0);
  });

  it("skips DDL and keeps valid statements when one statement fails", () => {
    const result = extract([
      "CREATE TABLE T (ID INT);",
      "SELECT * FROM A a JOIN B b ON ;",
      "SELECT * FROM A a JOIN B b ON a.id = b.id;",
    ].join("\n"));
    expect(result.relations).toHaveLength(1);
    expect(result.skipped.ddl).toBe(1);
    expect(result.skipped["parse-error"]).toBe(1);
  });

  it("deduplicates whitespace/comment/literal variants but not alias renames", () => {
    const first = extract(
      "SELECT * FROM A a JOIN B b ON a.id = b.a_id WHERE a.note = 'one';",
    );
    const second = extract(
      "select *\nfrom A a join B b on a.id = b.a_id where a.note = 'two'; -- note",
    );
    expect(first.fingerprints).toEqual(second.fingerprints);

    const renamed = extract(
      "SELECT * FROM A x JOIN B y ON x.id = y.a_id WHERE x.note = 'one';",
    );
    expect(first.fingerprints).not.toEqual(renamed.fingerprints);
  });
});
