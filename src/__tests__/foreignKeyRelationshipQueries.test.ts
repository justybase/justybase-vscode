import { netezzaMetadataProvider } from "../dialects/netezza/metadata/provider";
import { db2MetadataProvider } from "../../extensions/db2/src/db2SchemaProvider";
import { mssqlMetadataProvider } from "../../extensions/mssql/src/mssqlSchemaProvider";
import { mysqlMetadataProvider } from "../../extensions/mysql/src/mysqlSchemaProvider";
import { oracleMetadataProvider } from "../../extensions/oracle/src/oracleSchemaProvider";
import { postgresqlMetadataProvider } from "../../extensions/postgresql/src/postgresqlSchemaProvider";
import { verticaMetadataProvider } from "../../extensions/vertica/src/verticaSchemaProvider";
import type { DatabaseMetadataProvider } from "../contracts/database";

const providers: Array<[string, DatabaseMetadataProvider, string]> = [
  ["Netezza", netezzaMetadataProvider, "DB1"],
  ["Db2", db2MetadataProvider, "TESTDB"],
  ["MSSQL", mssqlMetadataProvider, "SalesDB"],
  ["MySQL", mysqlMetadataProvider, "shop"],
  ["Oracle", oracleMetadataProvider, "ORCL"],
  ["PostgreSQL", postgresqlMetadataProvider, "appdb"],
  ["Vertica", verticaMetadataProvider, "analytics"],
];

describe("exact FK metadata provider contract", () => {
  it.each(providers)("%s returns normalized FK endpoint aliases", (name, provider, database) => {
    const query = provider.buildForeignKeyRelationshipsQuery?.(database, {
      schema: "APP",
      tableName: "ORDER_LINE",
    });

    expect(query).toBeTruthy();
    for (const alias of [
      "FROM_SCHEMA",
      "FROM_TABLE",
      "FROM_COLUMN",
      "TO_SCHEMA",
      "TO_TABLE",
      "TO_COLUMN",
      "CONSTRAINT_NAME",
      "ORDINAL_POSITION",
    ]) {
      expect(query?.toUpperCase()).toContain(alias);
    }
    expect(query?.toUpperCase()).toContain("ORDER_LINE");
    expect(name).toBeTruthy();
  });
});
