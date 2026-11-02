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
    // Every template is verified on a live Netezza (CREATE + CALL); see
    // nzplsqlArtifacts.live.integration.test.ts.
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
        RAISE NOTICE 'Error: %', SQLERRM;
        RETURN -1;

END;
END_PROC;`
    },
    {
        id: 'basic-select-into',
        name: 'Basic - SELECT INTO with NOT FOUND check',
        description: 'Procedure that fetches a single value and handles a missing row',
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

    -- SELECT INTO does not raise when no row matches; check FOUND
    IF NOT FOUND THEN
        RAISE NOTICE 'Customer % not found', arg1;
        RETURN 'NOT FOUND';
    END IF;

    RETURN v_result;

EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Unexpected error: %', SQLERRM;
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
    <<retry>> LOOP
        BEGIN
            -- Attempt operation
            UPDATE inventory SET qty = qty - arg2 WHERE product_id = arg1;

            v_result := 'Success';
            -- EXIT needs the label: a plain EXIT only leaves this inner block
            EXIT retry;

        EXCEPTION
            WHEN TRANSACTION_ABORTED THEN
                v_attempts := v_attempts + 1;
                IF v_attempts >= 3 THEN
                    RAISE NOTICE 'Failed after 3 attempts: %', SQLERRM;
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
        name: 'Advanced - Division by Zero Guard',
        description: 'Procedure that checks the divisor before dividing',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER)
RETURNS NUMERIC(10,2)
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    v_total NUMERIC(10,2);
    v_items INT;
BEGIN
    SELECT total_amount, total_items INTO v_total, v_items
    FROM orders
    WHERE order_id = arg1;

    IF NOT FOUND THEN
        RAISE NOTICE 'Order % not found', arg1;
        RETURN NULL;
    END IF;

    -- Netezza has no DIVISION_BY_ZERO handler; check the divisor first
    IF v_items = 0 THEN
        RAISE NOTICE 'Order has zero items - order_id: %', arg1;
        RETURN 0;
    END IF;

    RETURN v_total / v_items;

EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error: %', SQLERRM;
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
        RAISE NOTICE 'Transaction conflict: %', SQLERRM;
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
            RAISE NOTICE 'Insert failed: %', SQLERRM;
            RETURN 'ERROR: ' || SQLERRM;
        END IF;

END;
END_PROC;`
    },
    {
        id: 'advanced-netezza-safe',
        name: 'Advanced - Full Netezza Safe Insert',
        description: 'Complete procedure with the Netezza exception handlers (TRANSACTION_ABORTED and OTHERS)',
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

-- Netezza accepts only TRANSACTION_ABORTED and OTHERS as handlers;
-- named conditions such as NO_DATA_FOUND and SQLSTATE codes are rejected.
EXCEPTION
    WHEN TRANSACTION_ABORTED THEN
        -- Serialization conflict
        RAISE NOTICE 'Transaction aborted: %', SQLERRM;
        RETURN 'ERROR: Transaction conflict';

    WHEN OTHERS THEN
        -- All other errors: table doesn't exist, column doesn't exist, etc.
        -- SQLERRM holds the message; SQLSTATE is not available here.
        RAISE NOTICE 'Unexpected error: %', SQLERRM;
        RETURN 'ERROR: ' || SQLERRM;

END;
END_PROC;`
    },
    {
        id: 'advanced-row-loop',
        name: 'Advanced - Row Loop with FOR IN SELECT',
        description: 'Procedure that processes query rows one by one (Netezza has no explicit cursors)',
        category: 'advanced',
template: (name: string, database: string, schema?: string) => `CREATE OR REPLACE PROCEDURE ${qualifyProcedureName(database, schema, name)}(INTEGER)
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL
AS BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
    rec RECORD;
    v_count INT := 0;
BEGIN
    -- DECLARE CURSOR / OPEN / FETCH are not supported; FOR ... IN SELECT
    -- iterates the rows into a RECORD variable
    FOR rec IN
        SELECT customer_id, name
        FROM customers
        WHERE customer_id >= arg1
    LOOP
        RAISE NOTICE 'Customer %: %', rec.customer_id, rec.name;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;

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

    -- Check duplicates (a sub-SELECT in FROM needs an alias)
    SELECT COUNT(*) INTO v_count
    FROM (
        SELECT 1 FROM temp_customers
        GROUP BY customer_id
        HAVING COUNT(*) > 1
    ) duplicates;

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
