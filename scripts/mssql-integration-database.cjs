#!/usr/bin/env node

const path = require("node:path");
const { createRequire } = require("node:module");

const extensionRequire = createRequire(
  path.join(__dirname, "..", "extensions", "mssql", "package.json"),
);
const sql = extensionRequire("mssql");

const action = process.argv[2];
const databaseName = process.env.MSSQL_LIVE_TEST_DATABASE;

if (action !== "create" && action !== "drop") {
  throw new Error("Usage: mssql-integration-database.cjs <create|drop>");
}

if (!databaseName || !/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error(
    "MSSQL_LIVE_TEST_DATABASE must contain only letters, numbers, and underscores.",
  );
}

const host = process.env.MSSQL_LIVE_TEST_HOST;
const user = process.env.MSSQL_LIVE_TEST_USER;
const password = process.env.MSSQL_LIVE_TEST_PASSWORD;
if (!host || !user || password === undefined) {
  throw new Error(
    "MSSQL_LIVE_TEST_HOST, MSSQL_LIVE_TEST_USER, and MSSQL_LIVE_TEST_PASSWORD are required.",
  );
}

const port = Number(process.env.MSSQL_LIVE_TEST_PORT ?? 1433);
const encrypt = process.env.MSSQL_LIVE_TEST_ENCRYPT !== "false";
const trustServerCertificate =
  process.env.MSSQL_LIVE_TEST_TRUST_SERVER_CERTIFICATE !== "false";
const quotedDatabaseName = `[${databaseName.replace(/]/g, "]]")}]`;

const connectionPool = new sql.ConnectionPool({
  server: host,
  port: Number.isFinite(port) ? port : 1433,
  database: "master",
  user,
  password,
  options: {
    encrypt,
    trustServerCertificate,
    connectTimeout: 30000,
  },
});

async function main() {
  await connectionPool.connect();
  try {
    const request = connectionPool.request();
    request.input("databaseName", sql.NVarChar(128), databaseName);

    if (action === "create") {
      await request.query(`
                IF DB_ID(@databaseName) IS NULL
                BEGIN
                    CREATE DATABASE ${quotedDatabaseName};
                END
            `);
      process.stdout.write(
        `MSSQL integration database ready: ${databaseName}\n`,
      );
      return;
    }

    await request.query(`
            IF DB_ID(@databaseName) IS NOT NULL
            BEGIN
                ALTER DATABASE ${quotedDatabaseName} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                DROP DATABASE ${quotedDatabaseName};
            END
        `);
    process.stdout.write(
      `MSSQL integration database removed: ${databaseName}\n`,
    );
  } finally {
    await connectionPool.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
