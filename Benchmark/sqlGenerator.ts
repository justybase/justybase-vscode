/**
 * SQL Document Generator for Performance Benchmarks
 *
 * Generates realistic Netezza SQL documents of configurable size
 * for measuring suggest/autocomplete pipeline performance.
 */

const TABLE_NAMES = [
    'CUSTOMERS', 'ORDERS', 'ORDER_ITEMS', 'PRODUCTS', 'CATEGORIES',
    'EMPLOYEES', 'DEPARTMENTS', 'SUPPLIERS', 'SHIPMENTS', 'INVOICES',
    'PAYMENTS', 'ACCOUNTS', 'TRANSACTIONS', 'INVENTORY', 'WAREHOUSES',
    'REGIONS', 'COUNTRIES', 'ADDRESSES', 'CONTACTS', 'LOGS'
];

const COLUMN_SETS: Record<string, string[]> = {
    CUSTOMERS: ['CUSTOMER_ID', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'CREATED_DATE', 'STATUS', 'SEGMENT'],
    ORDERS: ['ORDER_ID', 'CUSTOMER_ID', 'ORDER_DATE', 'TOTAL_AMOUNT', 'STATUS', 'SHIP_DATE', 'DISCOUNT'],
    ORDER_ITEMS: ['ITEM_ID', 'ORDER_ID', 'PRODUCT_ID', 'QUANTITY', 'UNIT_PRICE', 'LINE_TOTAL'],
    PRODUCTS: ['PRODUCT_ID', 'PRODUCT_NAME', 'CATEGORY_ID', 'PRICE', 'STOCK_QTY', 'SUPPLIER_ID'],
    CATEGORIES: ['CATEGORY_ID', 'CATEGORY_NAME', 'PARENT_ID', 'DESCRIPTION'],
    EMPLOYEES: ['EMPLOYEE_ID', 'FIRST_NAME', 'LAST_NAME', 'DEPARTMENT_ID', 'HIRE_DATE', 'SALARY', 'MANAGER_ID'],
    DEPARTMENTS: ['DEPT_ID', 'DEPT_NAME', 'LOCATION_ID', 'BUDGET'],
    SUPPLIERS: ['SUPPLIER_ID', 'SUPPLIER_NAME', 'COUNTRY', 'RATING', 'CONTRACT_DATE'],
    SHIPMENTS: ['SHIPMENT_ID', 'ORDER_ID', 'CARRIER', 'TRACKING_NO', 'SHIP_DATE', 'DELIVERY_DATE'],
    INVOICES: ['INVOICE_ID', 'ORDER_ID', 'INVOICE_DATE', 'DUE_DATE', 'AMOUNT', 'PAID'],
    PAYMENTS: ['PAYMENT_ID', 'INVOICE_ID', 'PAYMENT_DATE', 'AMOUNT', 'METHOD'],
    ACCOUNTS: ['ACCOUNT_ID', 'CUSTOMER_ID', 'BALANCE', 'CURRENCY', 'ACCOUNT_TYPE'],
    TRANSACTIONS: ['TXN_ID', 'ACCOUNT_ID', 'TXN_DATE', 'AMOUNT', 'TXN_TYPE', 'REFERENCE'],
    INVENTORY: ['PRODUCT_ID', 'WAREHOUSE_ID', 'QUANTITY', 'LAST_UPDATED'],
    WAREHOUSES: ['WAREHOUSE_ID', 'WAREHOUSE_NAME', 'REGION_ID', 'CAPACITY'],
    REGIONS: ['REGION_ID', 'REGION_NAME', 'COUNTRY_ID'],
    COUNTRIES: ['COUNTRY_ID', 'COUNTRY_NAME', 'CONTINENT'],
    ADDRESSES: ['ADDRESS_ID', 'CUSTOMER_ID', 'STREET', 'CITY', 'ZIP_CODE', 'COUNTRY'],
    CONTACTS: ['CONTACT_ID', 'CUSTOMER_ID', 'CONTACT_TYPE', 'VALUE'],
    LOGS: ['LOG_ID', 'TABLE_NAME', 'ACTION', 'TIMESTAMP', 'USER_ID', 'DETAILS']
};

function pick<T>(arr: T[], idx: number): T {
    return arr[idx % arr.length];
}

function getColumns(table: string): string[] {
    return COLUMN_SETS[table] || ['ID', 'NAME', 'VALUE', 'CREATED_DATE'];
}

/**
 * Generate N simple SELECT statements with WHERE clauses
 */
export function generateSimpleSelects(n: number): string {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        const table = pick(TABLE_NAMES, i);
        const cols = getColumns(table);
        const selectedCols = cols.slice(0, Math.min(4, cols.length));
        lines.push(
            `SELECT ${selectedCols.join(', ')}`,
            `FROM PROD_DB..${table} T${i}`,
            `WHERE T${i}.${cols[0]} > ${i * 100}`,
            `  AND T${i}.${pick(cols, 1)} IS NOT NULL`,
            `ORDER BY T${i}.${cols[0]} DESC`,
            `LIMIT 1000;`,
            ''
        );
    }
    return lines.join('\n');
}

/**
 * Generate a query with N CTE definitions
 */
export function generateWithCTEs(n: number): string {
    const lines: string[] = ['WITH'];
    for (let i = 0; i < n; i++) {
        const table = pick(TABLE_NAMES, i);
        const cols = getColumns(table);
        const cteName = `CTE_${table}_${i}`;
        const comma = i < n - 1 ? ',' : '';

        if (i === 0) {
            lines.push(
                `${cteName} AS (`,
                `    SELECT ${cols.join(', ')}`,
                `    FROM PROD_DB..${table}`,
                `    WHERE ${cols[0]} IS NOT NULL`,
                `)${comma}`
            );
        } else {
            const prevCte = `CTE_${pick(TABLE_NAMES, i - 1)}_${i - 1}`;
            lines.push(
                `${cteName} AS (`,
                `    SELECT A.${cols.slice(0, 3).join(', A.')},`,
                `           B.${getColumns(pick(TABLE_NAMES, i - 1)).slice(0, 2).join(', B.')}`,
                `    FROM PROD_DB..${table} A`,
                `    INNER JOIN ${prevCte} B ON A.${cols[0]} = B.${getColumns(pick(TABLE_NAMES, i - 1))[0]}`,
                `    WHERE A.${pick(cols, 2)} IS NOT NULL`,
                `)${comma}`
            );
        }
    }

    // Final SELECT from the last CTE
    const lastCte = `CTE_${pick(TABLE_NAMES, n - 1)}_${n - 1}`;
    lines.push(
        `SELECT *`,
        `FROM ${lastCte}`,
        `ORDER BY 1`,
        `LIMIT 500;`
    );
    return lines.join('\n');
}

/**
 * Generate a query with N JOINs including subquery aliases
 */
export function generateComplexJoins(n: number): string {
    const lines: string[] = [];
    const baseTable = TABLE_NAMES[0];
    const baseCols = getColumns(baseTable);

    lines.push(
        'SELECT',
        `    T0.${baseCols.slice(0, 3).join(', T0.')},`
    );

    for (let i = 1; i <= n; i++) {
        const table = pick(TABLE_NAMES, i);
        const cols = getColumns(table);
        const comma = i < n ? ',' : '';
        lines.push(`    T${i}.${cols[0]}, T${i}.${pick(cols, 1)}${comma}`);
    }

    lines.push(`FROM PROD_DB..${baseTable} T0`);

    for (let i = 1; i <= n; i++) {
        const table = pick(TABLE_NAMES, i);
        const cols = getColumns(table);
        const joinCol = baseCols[0];

        if (i % 3 === 0) {
            // Subquery join every 3rd
            lines.push(
                `LEFT JOIN (`,
                `    SELECT ${cols.join(', ')}`,
                `    FROM PROD_DB..${table}`,
                `    WHERE ${cols[0]} IS NOT NULL`,
                `) T${i} ON T0.${joinCol} = T${i}.${cols[0]}`
            );
        } else {
            lines.push(
                `INNER JOIN PROD_DB..${table} T${i}`,
                `    ON T0.${joinCol} = T${i}.${cols[0]}`
            );
        }
    }

    lines.push(
        `WHERE T0.${baseCols[0]} > 0`,
        `ORDER BY T0.${baseCols[0]}`,
        `LIMIT 1000;`
    );
    return lines.join('\n');
}

/**
 * Generate temp table creation statements
 */
export function generateTempTables(n: number): string {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        const table = pick(TABLE_NAMES, i);
        const cols = getColumns(table);
        lines.push(
            `CREATE TEMP TABLE TEMP_${table}_${i} AS (`,
            `    SELECT ${cols.join(', ')}`,
            `    FROM PROD_DB..${table}`,
            `    WHERE ${cols[0]} IS NOT NULL`,
            `);`,
            ''
        );
    }
    return lines.join('\n');
}

/**
 * Generate @SET variable definitions
 */
export function generateVariables(n: number): string {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        lines.push(`@SET VAR_${i} = 'value_${i}';`);
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Insert SQL block/line comments throughout text
 */
export function addComments(sql: string): string {
    const lines = sql.split('\n');
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        // Add a block comment every 10 lines
        if (i > 0 && i % 10 === 0) {
            result.push(`/* ============================================================`);
            result.push(`   Section ${Math.floor(i / 10)}: Processing stage for data pipeline`);
            result.push(`   Author: benchmark_generator`);
            result.push(`   Date: 2026-01-15`);
            result.push(`   ============================================================ */`);
        }
        // Add a line comment every 5 lines
        if (i % 5 === 0) {
            result.push(`-- Step ${i}: Processing ${pick(TABLE_NAMES, i)} data`);
        }
        result.push(lines[i]);
    }
    return result.join('\n');
}

/**
 * Generate a mixed SQL document targeting a specific line count.
 * Combines all pattern types for a realistic workload.
 */
export function generateMixed(targetLines: number): string {
    const parts: string[] = [];
    let currentLines = 0;

    // Phase 1: Variables (~5% of lines)
    const varCount = Math.max(2, Math.floor(targetLines * 0.05));
    const vars = generateVariables(varCount);
    parts.push(vars);
    currentLines += vars.split('\n').length;

    // Phase 2: Temp tables (~15% of lines)
    const tempCount = Math.max(1, Math.floor(targetLines * 0.025));
    const temps = generateTempTables(tempCount);
    parts.push(temps);
    currentLines += temps.split('\n').length;

    // Phase 3: CTE queries (~30% of lines)
    const cteCount = Math.max(2, Math.floor(targetLines * 0.04));
    const ctes = generateWithCTEs(cteCount);
    parts.push(ctes);
    currentLines += ctes.split('\n').length;

    // Phase 4: Complex joins (~25% of lines)
    const joinCount = Math.max(2, Math.floor(targetLines * 0.04));
    const joins = generateComplexJoins(joinCount);
    parts.push(joins);
    currentLines += joins.split('\n').length;

    // Phase 5: Fill remaining with simple selects
    const remainingLines = targetLines - currentLines;
    if (remainingLines > 0) {
        const selectCount = Math.max(1, Math.floor(remainingLines / 7));
        parts.push(generateSimpleSelects(selectCount));
    }

    return parts.join('\n');
}

/**
 * Generate a mixed document with comments (heavier for stripComments)
 */
export function generateMixedWithComments(targetLines: number): string {
    // Generate base at ~70% of target, comments will expand it
    const base = generateMixed(Math.floor(targetLines * 0.7));
    return addComments(base);
}

/**
 * Pre-built document size configurations
 */
export interface BenchmarkDocument {
    name: string;
    targetLines: number;
    sql: string;
    actualLines: number;
    actualChars: number;
}

export function generateBenchmarkDocuments(): BenchmarkDocument[] {
    const sizes = [
        { name: 'Tiny (50 lines)', targetLines: 50 },
        { name: 'Small (200 lines)', targetLines: 200 },
        { name: 'Medium (500 lines)', targetLines: 500 },
        { name: 'Large (1000 lines)', targetLines: 1000 },
        { name: 'XLarge (3000 lines)', targetLines: 3000 },
    ];

    return sizes.map(s => {
        const sql = generateMixedWithComments(s.targetLines);
        return {
            name: s.name,
            targetLines: s.targetLines,
            sql,
            actualLines: sql.split('\n').length,
            actualChars: sql.length,
        };
    });
}
