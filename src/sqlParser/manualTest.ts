/**
 * Manual test script for SQL Parser validation
 * Run with: npx ts-node packages/extension/src/sqlParser/manualTest.ts
 */

import { SqlValidator } from './validator'
import { createMockSchemaProvider } from './schemaProvider'
import type { ValidationError } from './types'

// Define mock tables
const mockTableDefinitions = [
    {
        database: 'JUST_DATA',
        schema: 'ADMIN',
        name: 'DIMEMPLOYEE',
        columns: [
            'EMPLOYEEKEY', 'PARENTEMPLOYEEKEY', 'FIRSTNAME', 'LASTNAME', 
            'MIDDLENAME', 'TITLE', 'HIREDATE', 'BIRTHDATE', 'LOGINID',
            'EMAILADDRESS', 'PHONE', 'MARITALSTATUS', 'GENDER'
        ]
    },
    {
        database: 'JUST_DATA',
        schema: 'ADMIN',
        name: 'DIMACCOUNT',
        columns: [
            'ACCOUNTKEY', 'PARENTACCOUNTKEY', 'ACCOUNTCODEALTERNATEKEY',
            'ACCOUNTDESCRIPTION', 'ACCOUNTTYPE', 'OPERATOR', 'CUSTOMMEMBERS'
        ]
    },
    {
        database: 'JUST_DATA',
        schema: 'ADMIN',
        name: 'FACTSALES',
        columns: [
            'SALEKEY', 'PRODUCTKEY', 'CUSTOMERKEY', 'SALEDATE', 
            'SALEAMOUNT', 'QUANTITY', 'DISCOUNT'
        ]
    }
]

const schemaProvider = createMockSchemaProvider(mockTableDefinitions)
const validator = new SqlValidator(schemaProvider)

console.log('=== SQL Parser Manual Test (ANSI SQL Cases) ===\n')

let testNum = 0
let passed = 0
let failed = 0

function test(name: string, sql: string, expectErrors: boolean, errorCheck?: (errors: ValidationError[]) => boolean) {
    testNum++
    console.log(`Test ${testNum}: ${name}`)
    const result = validator.validate(sql)
    console.log('SQL:', sql.substring(0, 100) + (sql.length > 100 ? '...' : ''))
    
    const hasErrors = result.errors.length > 0
    const success = expectErrors ? hasErrors : !hasErrors
    const extraCheck = errorCheck ? errorCheck(result.errors) : true
    
    if (success && extraCheck) {
        console.log('✅ PASS')
        passed++
    } else {
        console.log('❌ FAIL')
        console.log('Expected errors:', expectErrors)
        console.log('Got errors:', hasErrors)
        if (result.errors.length > 0) {
            console.log('Error details:', result.errors.map((e: ValidationError) => e.message))
        }
        failed++
    }
    console.log()
}

// ============================================
// BASIC SELECT TESTS
// ============================================

test('Simple SELECT with literal', 
    'SELECT 1', 
    false)

test('SELECT with column alias', 
    'SELECT 1 AS COL_1, 2 AS COL_2', 
    false)

test('SELECT with table reference', 
    'SELECT ACCOUNTKEY FROM DIMACCOUNT', 
    false)

test('SELECT with schema.table', 
    'SELECT ACCOUNTKEY FROM ADMIN.DIMACCOUNT', 
    false)

test('SELECT with database.schema.table', 
    'SELECT ACCOUNTKEY FROM JUST_DATA.ADMIN.DIMACCOUNT', 
    false)

test('SELECT with database..table (double dot)', 
    'SELECT ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT with table alias', 
    'SELECT A.ACCOUNTKEY FROM DIMACCOUNT A', 
    false)

test('SELECT with AS alias', 
    'SELECT A.ACCOUNTKEY FROM DIMACCOUNT AS A', 
    false)

// ============================================
// COLUMN VALIDATION TESTS
// ============================================

test('Valid column reference', 
    'SELECT A.ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT A', 
    false)

test('Invalid column reference - WRONGCOL', 
    'SELECT A.WRONGCOL FROM JUST_DATA..DIMACCOUNT A', 
    true, 
    (errors) => errors.some(e => e.code === 'SQL004' && e.message.includes('WRONGCOL')))

test('Multiple valid columns', 
    'SELECT A.ACCOUNTKEY, A.PARENTACCOUNTKEY FROM JUST_DATA..DIMACCOUNT A', 
    false)

// ============================================
// WHERE CLAUSE TESTS
// ============================================

test('WHERE with equality', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY = 1', 
    false)

test('WHERE with AND', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY = 1 AND PARENTACCOUNTKEY = 2', 
    false)

test('WHERE with OR', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY = 1 OR ACCOUNTKEY = 2', 
    false)

test('WHERE with IN list', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY IN (1, 2, 3)', 
    false)

test('WHERE with IN subquery', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY IN (SELECT ACCOUNTKEY FROM DIMACCOUNT)', 
    false)

test('WHERE with BETWEEN', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY BETWEEN 1 AND 10', 
    false)

test('WHERE with LIKE', 
    "SELECT * FROM DIMACCOUNT WHERE ACCOUNTDESCRIPTION LIKE '%test%'", 
    false)

test('WHERE with NOT LIKE', 
    "SELECT * FROM DIMACCOUNT WHERE ACCOUNTDESCRIPTION NOT LIKE '%test%'", 
    false)

test('WHERE with IS NULL', 
    'SELECT * FROM DIMACCOUNT WHERE PARENTACCOUNTKEY IS NULL', 
    false)

test('WHERE with IS NOT NULL', 
    'SELECT * FROM DIMACCOUNT WHERE PARENTACCOUNTKEY IS NOT NULL', 
    false)

test('WHERE with NOT IN', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY NOT IN (1, 2, 3)', 
    false)

test('WHERE with NOT BETWEEN', 
    'SELECT * FROM DIMACCOUNT WHERE ACCOUNTKEY NOT BETWEEN 1 AND 10', 
    false)

test('WHERE with NOT expression', 
    'SELECT * FROM DIMACCOUNT WHERE NOT ACCOUNTKEY = 1', 
    false)

test('WHERE with complex NOT expression', 
    'SELECT * FROM DIMACCOUNT WHERE NOT (ACCOUNTKEY < 0 OR ACCOUNTKEY > 100)', 
    false)

test('WHERE with multiple NOT conditions', 
    "SELECT * FROM DIMACCOUNT WHERE NOT ACCOUNTDESCRIPTION LIKE '%test%' AND ACCOUNTKEY NOT IN (1, 2, 3)", 
    false)

// ============================================
// JOIN TESTS
// ============================================

test('INNER JOIN', 
    'SELECT * FROM DIMACCOUNT A INNER JOIN DIMEMPLOYEE E ON A.ACCOUNTKEY = E.EMPLOYEEKEY', 
    false)

test('LEFT JOIN', 
    'SELECT * FROM DIMACCOUNT A LEFT JOIN DIMEMPLOYEE E ON A.ACCOUNTKEY = E.EMPLOYEEKEY', 
    false)

test('LEFT OUTER JOIN', 
    'SELECT * FROM DIMACCOUNT A LEFT OUTER JOIN DIMEMPLOYEE E ON A.ACCOUNTKEY = E.EMPLOYEEKEY', 
    false)

test('RIGHT JOIN', 
    'SELECT * FROM DIMACCOUNT A RIGHT JOIN DIMEMPLOYEE E ON A.ACCOUNTKEY = E.EMPLOYEEKEY', 
    false)

test('FULL OUTER JOIN', 
    'SELECT * FROM DIMACCOUNT A FULL OUTER JOIN DIMEMPLOYEE E ON A.ACCOUNTKEY = E.EMPLOYEEKEY', 
    false)

test('CROSS JOIN', 
    'SELECT * FROM DIMACCOUNT CROSS JOIN DIMEMPLOYEE', 
    false)

test('Multiple JOINs', 
    `SELECT * FROM FACTSALES F 
     JOIN DIMACCOUNT A ON F.SALEKEY = A.ACCOUNTKEY 
     JOIN DIMEMPLOYEE E ON F.SALEKEY = E.EMPLOYEEKEY`, 
    false)

// ============================================
// SUBQUERY TESTS
// ============================================

test('Subquery in FROM', 
    'SELECT * FROM (SELECT 1 AS COL) AS SUB', 
    false)

test('Nested subqueries', 
    'SELECT * FROM (SELECT * FROM (SELECT 1 AS COL) AS S1) AS S2', 
    false)

test('Subquery in JOIN', 
    'SELECT * FROM DIMACCOUNT A JOIN (SELECT ACCOUNTKEY FROM DIMACCOUNT) AS B ON A.ACCOUNTKEY = B.ACCOUNTKEY', 
    false)

// ============================================
// SCOPE TESTS
// ============================================

test('Z2 outside scope - should error', 
    `SELECT Z2.COL FROM DIMACCOUNT A 
     LEFT JOIN (SELECT 1 AS COL FROM (SELECT 1 AS X) AS Z2) AS Z ON 1=1`, 
    true,
    (errors) => errors.some(e => e.code === 'SQL003' && e.message.includes('Z2')))

// ============================================
// CTE (WITH CLAUSE) TESTS
// ============================================

test('Simple CTE', 
    'WITH CTE AS (SELECT 1 AS COL) SELECT * FROM CTE', 
    false)

test('Multiple CTEs', 
    `WITH 
        CTE1 AS (SELECT 1 AS A), 
        CTE2 AS (SELECT 2 AS B) 
     SELECT * FROM CTE1 JOIN CTE2 ON 1=1`, 
    false)

test('CTE with INSERT', 
    'WITH CTE AS (SELECT 1 AS COL) INSERT INTO T SELECT * FROM CTE', 
    false)

// ============================================
// CREATE TABLE AS TESTS
// ============================================

test('CREATE TABLE AS', 
    'CREATE TABLE NEW_TABLE AS SELECT * FROM DIMACCOUNT', 
    false)

test('CREATE TABLE AS with parentheses', 
    'CREATE TABLE NEW_TABLE AS (SELECT * FROM DIMACCOUNT)', 
    false)

test('CREATE TEMP TABLE', 
    'CREATE TEMP TABLE NEW_TABLE AS SELECT * FROM DIMACCOUNT', 
    false)

test('CREATE TEMPORARY TABLE', 
    'CREATE TEMPORARY TABLE NEW_TABLE AS SELECT * FROM DIMACCOUNT', 
    false)

test('CREATE TABLE AS with DISTRIBUTE ON RANDOM', 
    'CREATE TABLE NEW_TABLE AS (SELECT * FROM DIMACCOUNT) DISTRIBUTE ON RANDOM', 
    false)

// ============================================
// INSERT/UPDATE/DELETE TESTS
// ============================================

test('INSERT with VALUES', 
    "INSERT INTO DIMACCOUNT (ACCOUNTKEY, PARENTACCOUNTKEY) VALUES (1, 2)", 
    false)

test('INSERT with SELECT', 
    'INSERT INTO DIMACCOUNT SELECT * FROM DIMACCOUNT', 
    false)

test('UPDATE with SET', 
    "UPDATE DIMACCOUNT SET ACCOUNTDESCRIPTION = 'test' WHERE ACCOUNTKEY = 1", 
    false)

test('DELETE with WHERE', 
    'DELETE FROM DIMACCOUNT WHERE ACCOUNTKEY = 1', 
    false)

// ============================================
// EXPRESSION TESTS
// ============================================

test('CASE expression', 
    "SELECT CASE WHEN ACCOUNTKEY = 1 THEN 'ONE' ELSE 'OTHER' END FROM DIMACCOUNT", 
    false)

test('CASE with multiple WHEN', 
    `SELECT CASE 
        WHEN ACCOUNTKEY = 1 THEN 'ONE' 
        WHEN ACCOUNTKEY = 2 THEN 'TWO' 
        ELSE 'OTHER' 
     END FROM DIMACCOUNT`, 
    false)

test('Arithmetic expressions', 
    'SELECT ACCOUNTKEY + 1, ACCOUNTKEY - 1, ACCOUNTKEY * 2, ACCOUNTKEY / 2 FROM DIMACCOUNT', 
    false)

test('Concatenation', 
    "SELECT ACCOUNTKEY || '-' || ACCOUNTDESCRIPTION FROM DIMACCOUNT", 
    false)

// ============================================
// SYNTAX ERROR TESTS
// ============================================

test('Double comma - syntax error', 
    'SELECT A.ACCOUNTKEY,, A.PARENTACCOUNTKEY FROM DIMACCOUNT A', 
    true,
    (errors) => errors.some(e => e.code.startsWith('PAR')))

test('Missing FROM - syntax error', 
    'SELECT *', 
    true)

test('Invalid keyword placement', 
    'SELECT FROM FROM DIMACCOUNT', 
    true)

// ============================================
// KEYWORD AS IDENTIFIER TESTS
// ============================================

test('INNER_COL as identifier (keyword INNER)', 
    'SELECT 1 AS INNER_COL FROM DIMACCOUNT', 
    false)

test('LEFT_COL as identifier (keyword LEFT)', 
    'SELECT 1 AS LEFT_COL FROM DIMACCOUNT', 
    false)

test('RIGHT_COL as identifier (keyword RIGHT)', 
    'SELECT 1 AS RIGHT_COL FROM DIMACCOUNT', 
    false)

test('FULL_COL as identifier (keyword FULL)', 
    'SELECT 1 AS FULL_COL FROM DIMACCOUNT', 
    false)

test('CROSS_COL as identifier (keyword CROSS)', 
    'SELECT 1 AS CROSS_COL FROM DIMACCOUNT', 
    false)

test('TABLE_A as identifier (keyword TABLE)', 
    'SELECT 1 AS COL FROM TABLE_A', 
    false)

// ============================================
// ORDER BY / GROUP BY / HAVING TESTS
// ============================================

test('ORDER BY', 
    'SELECT * FROM DIMACCOUNT ORDER BY ACCOUNTKEY', 
    false)

test('ORDER BY DESC', 
    'SELECT * FROM DIMACCOUNT ORDER BY ACCOUNTKEY DESC', 
    false)

test('ORDER BY multiple columns', 
    'SELECT * FROM DIMACCOUNT ORDER BY ACCOUNTKEY, PARENTACCOUNTKEY', 
    false)

test('GROUP BY', 
    'SELECT ACCOUNTKEY, COUNT(*) FROM DIMACCOUNT GROUP BY ACCOUNTKEY', 
    false)

test('HAVING', 
    'SELECT ACCOUNTKEY, COUNT(*) AS CNT FROM DIMACCOUNT GROUP BY ACCOUNTKEY HAVING COUNT(*) > 1', 
    false)

// ============================================
// LIMIT / OFFSET TESTS
// ============================================

test('LIMIT', 
    'SELECT * FROM DIMACCOUNT LIMIT 10', 
    false)

test('LIMIT with OFFSET', 
    'SELECT * FROM DIMACCOUNT LIMIT 10 OFFSET 5', 
    false)

// ============================================
// UNION / INTERSECT / EXCEPT TESTS
// ============================================

test('UNION', 
    'SELECT ACCOUNTKEY FROM DIMACCOUNT UNION SELECT ACCOUNTKEY FROM DIMACCOUNT', 
    false)

test('UNION ALL', 
    'SELECT ACCOUNTKEY FROM DIMACCOUNT UNION ALL SELECT ACCOUNTKEY FROM DIMACCOUNT', 
    false)

test('INTERSECT', 
    'SELECT ACCOUNTKEY FROM DIMACCOUNT INTERSECT SELECT ACCOUNTKEY FROM DIMACCOUNT', 
    false)

test('EXCEPT', 
    'SELECT ACCOUNTKEY FROM DIMACCOUNT EXCEPT SELECT ACCOUNTKEY FROM DIMACCOUNT', 
    false)

// ============================================
// NETEZZA SPECIAL BUILT-IN VALUES TESTS
// ============================================

test('SELECT CURRENT_TIMESTAMP (special built-in)', 
    'SELECT CURRENT_TIMESTAMP FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT CURRENT_DATE (special built-in)', 
    'SELECT CURRENT_DATE FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT CURRENT_CATALOG (special built-in)', 
    'SELECT CURRENT_CATALOG FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT CURRENT_USER (special built-in)', 
    'SELECT CURRENT_USER FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT CURRENT_SID (special built-in)', 
    'SELECT CURRENT_SID FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT CURRENT_TIME (special built-in)', 
    'SELECT CURRENT_TIME FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT SESSION_USER (special built-in)', 
    'SELECT SESSION_USER FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT SYSTEM_USER (special built-in)', 
    'SELECT SYSTEM_USER FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT current_db (special built-in lowercase)', 
    'SELECT current_db FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT current_schema (special built-in lowercase)', 
    'SELECT current_schema FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT with multiple special built-ins', 
    'SELECT CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_USER FROM JUST_DATA..DIMACCOUNT', 
    false)

test('SELECT special built-in with alias', 
    'SELECT CURRENT_TIMESTAMP AS TS, CURRENT_DATE AS DT FROM JUST_DATA..DIMACCOUNT', 
    false)

// ============================================
// SUMMARY
// ============================================

console.log('=== Summary ===')
console.log(`Total: ${testNum}`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)
console.log(`Success rate: ${((passed / testNum) * 100).toFixed(1)}%`)
