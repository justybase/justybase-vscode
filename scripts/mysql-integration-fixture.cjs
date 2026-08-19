#!/usr/bin/env node

const path = require("node:path");
const { createRequire } = require("node:module");

const extensionRequire = createRequire(
  path.join(__dirname, "..", "extensions", "mysql", "package.json"),
);
const mysql = extensionRequire("mysql2/promise");

const action = process.argv[2];
const databaseName = process.env.MYSQL_LIVE_TEST_DATABASE;
const tableName = "departments";

if (action !== "create" && action !== "drop") {
  throw new Error("Usage: mysql-integration-fixture.cjs <create|drop>");
}

if (!databaseName || !/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error(
    "MYSQL_LIVE_TEST_DATABASE must contain only letters, numbers, and underscores.",
  );
}

const host = process.env.MYSQL_LIVE_TEST_HOST;
const user = process.env.MYSQL_LIVE_TEST_USER;
const password = process.env.MYSQL_LIVE_TEST_PASSWORD;
if (!host || !user || password === undefined) {
  throw new Error(
    "MYSQL_LIVE_TEST_HOST, MYSQL_LIVE_TEST_USER, and MYSQL_LIVE_TEST_PASSWORD are required.",
  );
}

const port = Number(process.env.MYSQL_LIVE_TEST_PORT ?? 3306);
const quotedTableName = `\`${tableName}\``;

async function main() {
  const connection = await mysql.createConnection({
    host,
    port: Number.isFinite(port) ? port : 3306,
    database: databaseName,
    user,
    password,
  });

  try {
    if (action === "create") {
      await connection.query(`DROP TABLE IF EXISTS ${quotedTableName}`);
      await connection.query(`
        CREATE TABLE ${quotedTableName} (
          \`department_name\` VARCHAR(100) NOT NULL,
          \`manager_id\` INT NOT NULL,
          \`budget\` DECIMAL(12, 2) NOT NULL
        ) ENGINE=InnoDB
      `);
      process.stdout.write(
        `MySQL integration fixture ready: ${databaseName}.${tableName}\n`,
      );
      return;
    }

    await connection.query(`DROP TABLE IF EXISTS ${quotedTableName}`);
    process.stdout.write(
      `MySQL integration fixture removed: ${databaseName}.${tableName}\n`,
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
