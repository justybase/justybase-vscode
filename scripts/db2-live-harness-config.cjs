'use strict';

/**
 * Pure helpers for the ephemeral Db2 live-test harness.
 *
 * Kept CommonJS so both the Node runner (`db2-live-harness.mjs`) and the Jest
 * unit tests can consume the same logic without a build step. Nothing here
 * touches Docker or the network; the runner owns side effects.
 */

const crypto = require('node:crypto');

const DEFAULT_IMAGE_CANDIDATES = Object.freeze([
    'icr.io/db2_community/db2:11.5.8.0',
    'ibmcom/db2:11.5.8.0',
]);
const DEFAULT_IMAGE = DEFAULT_IMAGE_CANDIDATES[0];
const DEFAULT_DATABASE = 'JBLTEST';
const DEFAULT_USER = 'db2inst1';
const DEFAULT_FIXTURE_SCHEMA = 'JBL_LIVE';
const DEFAULT_CONTAINER_PREFIX = 'jb-db2-live';
const DEFAULT_READY_TIMEOUT_MS = 900000;
const DEFAULT_POLL_INTERVAL_MS = 10000;
const EXPLAIN_DDL_PATH = '/opt/ibm/db2/V11.5/misc/EXPLAIN.DDL';

const LIVE_TEST_FILES = Object.freeze([
    'src/__tests__/integration/db2.integration.test.ts',
    'src/__tests__/integration/db2Runstats.live.integration.test.ts',
]);

function readEnv(env, name) {
    const raw = env[name];
    if (raw === undefined) {
        return undefined;
    }
    const value = String(raw).trim();
    return value.length > 0 ? value : undefined;
}

function readPositiveInt(raw, fallback) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function generatePassword() {
    // Db2 enforces mixed case + digit + special character. Hex keeps the value
    // shell-safe; the surrounding literals supply the rest of the policy.
    return `Jb${crypto.randomBytes(12).toString('hex')}9!`;
}

function generateToken(byteLength = 4) {
    return crypto.randomBytes(byteLength).toString('hex');
}

function buildContainerName(prefix, token) {
    const raw = `${prefix || DEFAULT_CONTAINER_PREFIX}-${token || generateToken()}`;
    const sanitized = raw
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '-')
        .replace(/^[^a-z0-9]+/, '');
    return sanitized.slice(0, 63);
}

function readHarnessOptions(env = process.env) {
    const image = readEnv(env, 'DB2_HARNESS_IMAGE') || DEFAULT_IMAGE;
    const database = (readEnv(env, 'DB2_HARNESS_DATABASE') || DEFAULT_DATABASE).toUpperCase();
    const user = readEnv(env, 'DB2_HARNESS_USER') || DEFAULT_USER;
    const password = readEnv(env, 'DB2_HARNESS_PASSWORD') || generatePassword();
    const fixtureSchema = (
        readEnv(env, 'DB2_LIVE_FIXTURE_SCHEMA') || DEFAULT_FIXTURE_SCHEMA
    ).toUpperCase();
    const containerPrefix = readEnv(env, 'DB2_HARNESS_CONTAINER_PREFIX') || DEFAULT_CONTAINER_PREFIX;

    return {
        image,
        imageCandidates: image === DEFAULT_IMAGE
            ? DEFAULT_IMAGE_CANDIDATES
            : Object.freeze([image]),
        database,
        user,
        password,
        fixtureSchema,
        containerPrefix,
        containerName: buildContainerName(containerPrefix, readEnv(env, 'DB2_HARNESS_CONTAINER_TOKEN')),
        readyTimeoutMs: readPositiveInt(readEnv(env, 'DB2_HARNESS_READY_TIMEOUT_MS'), DEFAULT_READY_TIMEOUT_MS),
        pollIntervalMs: readPositiveInt(readEnv(env, 'DB2_HARNESS_POLL_INTERVAL_MS'), DEFAULT_POLL_INTERVAL_MS),
        keepContainer: readEnv(env, 'DB2_HARNESS_KEEP') === '1',
        wslDistro: readEnv(env, 'JUSTYBASE_WSL_DISTRO') || 'Ubuntu',
        explainDdlPath: readEnv(env, 'DB2_HARNESS_EXPLAIN_DDL') || EXPLAIN_DDL_PATH,
    };
}

function buildDockerRunArgs(options) {
    return [
        'run',
        '--detach',
        '--name',
        options.containerName,
        '--label',
        'justybase.db2-live-harness=1',
        '--privileged=true',
        // Random loopback port: never collide with an existing Db2 container.
        '--publish',
        '127.0.0.1::50000',
        '--env',
        'LICENSE=accept',
        '--env',
        `DB2INST1_PASSWORD=${options.password}`,
        '--env',
        `DBNAME=${options.database}`,
        '--env',
        'DBPORT=50000',
        options.image,
    ];
}

function buildJestArgs() {
    return [
        './node_modules/jest/bin/jest.js',
        '--config',
        'jest.live.config.js',
        '--runInBand',
        ...LIVE_TEST_FILES,
    ];
}

function buildJestEnv(options, hostPort) {
    return {
        DB2_LIVE_TEST_HOST: '127.0.0.1',
        DB2_LIVE_TEST_PORT: String(hostPort),
        DB2_LIVE_TEST_DATABASE: options.database,
        DB2_LIVE_TEST_USER: options.user,
        DB2_LIVE_TEST_PASSWORD: options.password,
        DB2_LIVE_FIXTURE_SCHEMA: options.fixtureSchema,
        DB2_LIVE_TEST_REQUIRED: 'true',
        JUSTYBASE_DB2_EPHEMERAL: '1',
    };
}

function parseHostPort(dockerPortOutput) {
    const text = String(dockerPortOutput || '').trim();
    if (!text) {
        return undefined;
    }

    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    const match = /(?:\[[^\]]+\]|[0-9.]+):(\d+)$/.exec(last);
    if (!match) {
        return undefined;
    }

    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function redactSecret(text, secret) {
    const value = String(text || '');
    if (!secret) {
        return value;
    }

    return value.split(secret).join('<redacted>');
}

function isStrictEphemeral(env = process.env) {
    return env.JUSTYBASE_DB2_EPHEMERAL === '1';
}

function assertSchemaName(schema) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(schema)) {
        throw new Error(`Invalid Db2 fixture schema: ${schema}`);
    }
    return schema;
}

/**
 * Seeds the persistent `JBL_LIVE` fixture expected by the live suite.
 *
 * `--#SET TERMINATOR @` is required because the SQL PL procedure body contains
 * semicolons; the DB2 CLP understands the directive for `-tf` scripts.
 */
function buildFixtureSql(schema = DEFAULT_FIXTURE_SCHEMA) {
    const s = assertSchemaName(schema);

    return `--#SET TERMINATOR @
CREATE SCHEMA ${s}@
CREATE TABLE ${s}.JBL_CUSTOMERS (
    CUSTOMER_ID INTEGER NOT NULL PRIMARY KEY,
    CUSTOMER_NAME VARCHAR(80) NOT NULL
)@
CREATE TABLE ${s}.JBL_EMPLOYEES (
    EMP_ID INTEGER NOT NULL PRIMARY KEY,
    MANAGER_ID INTEGER,
    EMAIL VARCHAR(120) NOT NULL,
    DEPT_ID INTEGER
)@
INSERT INTO ${s}.JBL_EMPLOYEES (EMP_ID, MANAGER_ID, EMAIL, DEPT_ID) VALUES
    (1, NULL, 'jan.kowalski@fixture.local', 10),
    (2, 1, 'anna.nowak@fixture.local', 10),
    (3, 1, 'piotr.wisniewski@fixture.local', 20),
    (4, 3, 'maria.lewandowska@fixture.local', 20),
    (5, 1, 'tomasz.zielinski@fixture.local', 30),
    (6, 5, 'katarzyna.szymanska@fixture.local', 30),
    (7, 3, 'michal.wojcik@fixture.local', 20),
    (8, 5, 'agnieszka.kaminska@fixture.local', 30),
    (9, 1, 'pawel.kowalczyk@fixture.local', 10),
    (10, 9, 'ewa.nawrocka@fixture.local', 10),
    (11, 9, 'krzysztof.zimmerman@fixture.local', 40),
    (12, 1, 'beata.duda@fixture.local', 40)@
CREATE TABLE ${s}.JBL_ORDERS (
    ORDER_ID INTEGER NOT NULL PRIMARY KEY,
    CUSTOMER_ID INTEGER NOT NULL,
    AMOUNT DECIMAL(10, 2) NOT NULL,
    ORDER_DATE DATE NOT NULL
)@
INSERT INTO ${s}.JBL_ORDERS (ORDER_ID, CUSTOMER_ID, AMOUNT, ORDER_DATE) VALUES
    (1, 1, 120.50, '2024-01-10'),
    (2, 1, 80.00, '2024-02-11'),
    (3, 2, 45.25, '2024-02-12'),
    (4, 3, 300.00, '2024-03-01'),
    (5, 3, 12.75, '2024-03-05'),
    (6, 4, 99.99, '2024-04-01'),
    (7, 5, 10.00, '2024-04-02'),
    (8, 6, 250.00, '2024-05-01')@
CREATE ALIAS ${s}.JBL_ALIAS_CUSTOMERS FOR ${s}.JBL_CUSTOMERS@
CREATE VIEW ${s}.JBL_V_EMP_DEPT AS
    SELECT E.EMP_ID, E.EMAIL, E.DEPT_ID
    FROM ${s}.JBL_EMPLOYEES E@
CREATE VIEW ${s}.JBL_V_CUSTOMER_ORDER_SUM AS
    SELECT 'JBL_FIXTURE_ORDER_SUM_MARKER' AS MARKER,
           C.CUSTOMER_ID,
           SUM(O.AMOUNT) AS TOTAL_AMOUNT
    FROM ${s}.JBL_CUSTOMERS C
    JOIN ${s}.JBL_ORDERS O ON O.CUSTOMER_ID = C.CUSTOMER_ID
    GROUP BY C.CUSTOMER_ID@
CREATE TABLE ${s}.JBL_SALES_FACT (
    SALE_ID INTEGER NOT NULL,
    SALE_DATE DATE NOT NULL,
    AMOUNT DECIMAL(10, 2)
)
PARTITION BY RANGE (SALE_DATE) (
    PARTITION P_2024 STARTING FROM '2024-01-01' INCLUSIVE ENDING AT '2025-01-01' EXCLUSIVE,
    PARTITION P_2025 STARTING FROM '2025-01-01' INCLUSIVE ENDING AT '2026-01-01' EXCLUSIVE
)@
CREATE OR REPLACE PROCEDURE ${s}.JBL_GET_CUSTOMER_ORDER_COUNT (
    IN P_CUSTOMER_ID INTEGER,
    OUT P_ORDER_COUNT INTEGER
)
LANGUAGE SQL
BEGIN
    SELECT COUNT(*) INTO P_ORDER_COUNT
    FROM ${s}.JBL_ORDERS
    WHERE CUSTOMER_ID = P_CUSTOMER_ID;
END@
`;
}

module.exports = {
    DEFAULT_CONTAINER_PREFIX,
    DEFAULT_DATABASE,
    DEFAULT_FIXTURE_SCHEMA,
    DEFAULT_IMAGE,
    DEFAULT_IMAGE_CANDIDATES,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_READY_TIMEOUT_MS,
    DEFAULT_USER,
    EXPLAIN_DDL_PATH,
    LIVE_TEST_FILES,
    buildContainerName,
    buildDockerRunArgs,
    buildFixtureSql,
    buildJestArgs,
    buildJestEnv,
    generatePassword,
    generateToken,
    isStrictEphemeral,
    parseHostPort,
    readHarnessOptions,
    redactSecret,
};
