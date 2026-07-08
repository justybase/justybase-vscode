/**
 * Netezza Stored Procedure Templates
 * Provides templates for creating procedures with various error handling patterns
 */

export interface ProcedureTemplate {
    id: string;
    name: string;
    description: string;
    category: 'basic' | 'advanced';
    template: (procedureName: string, database: string, schema?: string) => string;
}

function normalizeIdentifier(value: string | undefined, fallback: string): string {
    const normalized = (value || '').replace(/"/g, '').trim().toUpperCase();
    return normalized.length > 0 ? normalized : fallback;
}

function qualifyProcedureName(database: string, schema: string | undefined, procedureName: string): string {
    const db = normalizeIdentifier(database, 'SYSTEM');
    const sch = normalizeIdentifier(schema, 'ADMIN');
    const proc = normalizeIdentifier(procedureName, 'NEW_PROCEDURE');
    return `${db}.${sch}.${proc}`;
}

export const procedureTemplates: ProcedureTemplate[] = [
    // Basic Templates
    {
        id: 'basic-simple',
        name: 'Basic - Simple Error Handling',
        description: 'Simple procedure with basic WHEN OTHERS exception handling',
        category: 'basic',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER)
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
BEGIN
    -- YOUR CODE GOES HERE

    RETURN 1;

EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error code: %, Message: %', SQLSTATE, SQLERRM;
        RETURN -1;

END;
END_PROC;`
    },
    {
        id: 'basic-select-into',
        name: 'Basic - SELECT INTO with NO_DATA_FOUND',
        description: 'Procedure that fetches a single value with error handling',
        category: 'basic',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER)
RETURNS VARCHAR(100)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    v_result VARCHAR(100);
BEGIN
    SELECT name INTO v_result
    FROM customers
    WHERE customer_id = arg1;

    RETURN v_result;

EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RAISE NOTICE 'Customer % not found', arg1;
        RETURN 'NOT FOUND';

    WHEN OTHERS THEN
        RAISE ERROR 'Unexpected error: %', SQLERRM;
        RETURN NULL;

END;
END_PROC;`
    },

    // Advanced Templates
    {
        id: 'advanced-retry',
        name: 'Advanced - Retry Logic with Loop',
        description: 'Procedure with retry mechanism for transaction conflicts',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER, INTEGER)
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    arg2 ALIAS FOR $2;
    v_attempts INT := 0;
    v_result VARCHAR(200);
BEGIN
    LOOP
        BEGIN
            -- Attempt operation
            UPDATE inventory SET qty = qty - arg2 WHERE product_id = arg1;

            v_result := 'Success';
            EXIT;  -- Success - exit loop

        EXCEPTION
            WHEN TRANSACTION_ABORTED THEN
                v_attempts := v_attempts + 1;
                IF v_attempts >= 3 THEN
                    RAISE ERROR 'Failed after 3 attempts: %', SQLERRM;
                    RETURN 'ERROR: Max retries exceeded';
                END IF;
                -- Try again

            WHEN OTHERS THEN
                RAISE NOTICE 'Error: %', SQLERRM;
                RETURN 'ERROR: ' || SQLERRM;
        END;
    END LOOP;

    RETURN v_result;

END;
END_PROC;`
    },
    {
        id: 'advanced-division',
        name: 'Advanced - Division by Zero Handling',
        description: 'Procedure with specific DIVISION_BY_ZERO exception handling',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER)
RETURNS NUMERIC(10,2)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    v_avg_price NUMERIC(10,2);
BEGIN
    SELECT total_amount / total_items INTO v_avg_price
    FROM orders
    WHERE order_id = arg1;

    RETURN v_avg_price;

EXCEPTION
    WHEN DIVISION_BY_ZERO THEN
        RAISE NOTICE 'Order has zero items - order_id: %', arg1;
        RETURN 0;

    WHEN NO_DATA_FOUND THEN
        RAISE NOTICE 'Order % not found', arg1;
        RETURN NULL;

    WHEN OTHERS THEN
        RAISE ERROR 'Error: %', SQLERRM;
        RETURN NULL;

END;
END_PROC;`
    },
    {
        id: 'advanced-transaction',
        name: 'Advanced - Transaction Management',
        description: 'Procedure with explicit transaction control and error handling',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER, INTEGER)
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    arg2 ALIAS FOR $2;
    v_result VARCHAR(200);
BEGIN
    UPDATE inventory
    SET quantity = quantity - arg2
    WHERE product_id = arg1;

    INSERT INTO sales_log VALUES (arg1, arg2, CURRENT_TIMESTAMP);

    v_result := 'SUCCESS';
    RETURN v_result;

EXCEPTION
    WHEN TRANSACTION_ABORTED THEN
        RAISE ERROR 'Transaction conflict: %', SQLERRM;
        RETURN 'ERROR: Conflict';

    WHEN OTHERS THEN
        RAISE NOTICE 'Unexpected error: %', SQLERRM;
        RETURN 'ERROR: ' || SQLERRM;

END;
END_PROC;`
    },
    {
        id: 'advanced-duplicate-check',
        name: 'Advanced - Manual Duplicate Check',
        description: 'Procedure that manually checks for duplicates (Netezza does not enforce UNIQUE)',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER, VARCHAR(100))
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    arg2 ALIAS FOR $2;
    v_count INT;
BEGIN
    -- MANUALLY check duplicates (Netezza doesn't do this!)
    SELECT COUNT(*) INTO v_count
    FROM customers
    WHERE customer_id = arg1;

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Customer % already exists!', arg1;
    END IF;

    INSERT INTO customers VALUES (arg1, arg2);
    RETURN 'Customer added';

EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM LIKE '%already exists%' THEN
            RETURN 'ERROR: Duplicate customer';
        ELSE
            RAISE ERROR 'Insert failed: %', SQLERRM;
            RETURN 'ERROR: ' || SQLERRM;
        END IF;

END;
END_PROC;`
    },
    {
        id: 'advanced-netezza-safe',
        name: 'Advanced - Full Netezza Safe Insert',
        description: 'Complete procedure with all Netezza-specific error handling patterns',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER, VARCHAR(100))
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    arg2 ALIAS FOR $2;
    v_existing_count INTEGER;
    v_result VARCHAR(200);
BEGIN
    -- NETEZZA DOESN'T ENFORCE UNIQUE - we must check manually!
    SELECT COUNT(*) INTO v_existing_count
    FROM customers
    WHERE customer_id = arg1;

    IF v_existing_count > 0 THEN
        -- Manually report error (because UNIQUE constraint won't work)
        RAISE EXCEPTION 'Customer ID % already exists', arg1;
    END IF;

    -- Insert record
    INSERT INTO customers (customer_id, name)
    VALUES (arg1, arg2);

    v_result := 'Customer ' || arg1 || ' added successfully';
    RETURN v_result;

EXCEPTION
    WHEN NO_DATA_FOUND THEN
        -- This error can occur in SELECT INTO
        RAISE NOTICE 'No data found during validation';
        RETURN 'ERROR: Validation failed';

    WHEN DIVISION_BY_ZERO THEN
        -- If there was logic with division
        RAISE NOTICE 'Division by zero detected';
        RETURN 'ERROR: Math error';

    WHEN TRANSACTION_ABORTED THEN
        -- Serialization conflict
        RAISE ERROR 'Transaction aborted: %', SQLERRM;
        RETURN 'ERROR: Transaction conflict';

    WHEN OTHERS THEN
        -- All other errors
        -- In Netezza this can be: table doesn't exist, column doesn't exist, etc.
        RAISE NOTICE 'Unexpected error: SQLSTATE=%, Message=%', SQLSTATE, SQLERRM;
        RETURN 'ERROR: ' || SQLERRM;

END;
END_PROC;`
    },
    {
        id: 'advanced-hash-check',
        name: 'Advanced - Hash-based Duplicate Detection',
        description: 'Procedure using hash8() for fast duplicate checking',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER, VARCHAR(100))
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    arg2 ALIAS FOR $2;
    v_hash BIGINT;
    v_count INT;
BEGIN
    -- Use hash8() for fast uniqueness checking
    v_hash := hash8(CAST(arg1 AS VARCHAR));

    SELECT COUNT(*) INTO v_count
    FROM customers
    WHERE hash8(CAST(customer_id AS VARCHAR)) = v_hash;

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Duplicate detected via hash for customer %', arg1;
    END IF;

    INSERT INTO customers VALUES (arg1, arg2, v_hash);
    RETURN 'Customer added with hash verification';

END;
END_PROC;`
    },
    {
        id: 'advanced-temp-table',
        name: 'Advanced - Temp Table Operations',
        description: 'Procedure using temp tables with duplicate checking',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}()
RETURNS VARCHAR(200)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    v_count INT;
BEGIN
    -- Insert into temp table
    INSERT INTO temp_customers SELECT * FROM new_data;

    -- Check duplicates
    SELECT COUNT(*) INTO v_count
    FROM (
        SELECT 1 FROM temp_customers
        GROUP BY customer_id
        HAVING COUNT(*) > 1
    );

    IF v_count > 0 THEN
        RAISE EXCEPTION 'Duplicates found in data';
    END IF;

    -- If there's no error, insert into target table
    INSERT INTO customers
    SELECT * FROM temp_customers;

    RETURN 'Data inserted successfully';

END;
END_PROC;`
    }
];

export function getTemplatesByCategory(): { basic: ProcedureTemplate[]; advanced: ProcedureTemplate[] } {
    return {
        basic: procedureTemplates.filter(t => t.category === 'basic'),
        advanced: procedureTemplates.filter(t => t.category === 'advanced')
    };
}

export function getTemplateById(id: string): ProcedureTemplate | undefined {
    return procedureTemplates.find(t => t.id === id);
}
