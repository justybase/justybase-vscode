-- =============================================================================
-- Phase 4 Dogfooding Script
-- Purpose: Validate result-panel UX states, hydration performance, and
--          execution-path correctness on a live Netezza database.
--
-- Instructions:
--   1. Connect to a live Netezza instance
--   2. Run: Command Palette → "Netezza: Clear Result Panel Performance Stats"
--   3. Execute each section below one by one (or as a batch for multi-statement tests)
--   4. After all scenarios, run: "Netezza: Show Result Panel Performance Stats"
--   5. Review p50/p95 first-paint against synthetic baseline
-- =============================================================================

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 1: Zero-row SELECT                                     ║
-- ║  Expected: empty-result card, columns still visible              ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT 'zero_row_test' AS scenario, 1 AS col_a, 'text' AS col_b, CURRENT_TIMESTAMP AS col_ts
WHERE 1 = 0;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 2: Single-row SELECT                                    ║
-- ║  Expected: normal render, quick first-paint                       ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT 'single_row' AS scenario, 42 AS numeric_col, 'hello' AS text_col, CURRENT_TIMESTAMP AS ts_col;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 3: Medium result (~1000 rows)                           ║
-- ║  Expected: streaming delivery, first-paint < 50ms                 ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT
    ROW_NUMBER() OVER (ORDER BY 1) AS row_num,
    'medium_test_' || CAST(ROW_NUMBER() OVER (ORDER BY 1) AS VARCHAR(10)) AS text_col,
    RANDOM() * 1000.0 AS numeric_col,
    CURRENT_DATE AS date_col,
    CURRENT_TIMESTAMP AS timestamp_col
FROM _V_RELATION_COLUMN
LIMIT 1000;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 4: Large result (~10k rows)                             ║
-- ║  Expected: streaming, payload bucket = l or xl, no UI freeze      ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT
    ROW_NUMBER() OVER (ORDER BY 1) AS row_num,
    'large_test_' || CAST(ROW_NUMBER() OVER (ORDER BY 1) AS VARCHAR(10)) AS label,
    RANDOM() * 100000.0 AS amount,
    CURRENT_TIMESTAMP AS created_at
FROM _V_RELATION_COLUMN a
CROSS JOIN (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) b
LIMIT 10000;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 5: Syntax error                                         ║
-- ║  Expected: error card with recovery hint + Open Logs action       ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECTX 1 AS this_should_fail;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 6: Runtime error (non-existent object)                  ║
-- ║  Expected: error banner with Copilot fix path                     ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT * FROM _NONEXISTENT_TABLE_PHASE4_TEST_XYZ;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 7: DDL/DML (no result set)                              ║
-- ║  Expected: statement-complete card, "rows affected" message       ║
-- ╚═══════════════════════════════════════════════════════════════════╝
-- NOTE: Use a safe temp table pattern. Uncomment if safe to run:
-- CREATE TEMP TABLE _phase4_dogfood_tmp AS SELECT 1 AS id, 'test' AS val;
-- DROP TABLE _phase4_dogfood_tmp;

-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  SCENARIO 8: Mixed type columns (alignment check)                 ║
-- ║  Expected: text=left, numeric=right, date/timestamp=right         ║
-- ╚═══════════════════════════════════════════════════════════════════╝
SELECT
    'left-aligned' AS varchar_col,
    12345 AS integer_col,
    123.456 AS numeric_col,
    CURRENT_DATE AS date_col,
    CURRENT_TIMESTAMP AS timestamp_col,
    TRUE AS bool_col;

-- =============================================================================
-- MULTI-STATEMENT BATCH TEST
-- Execute the block below as a single batch (select all, run)
-- Expected: multiple result-set tabs, per-tab status badges where applicable
-- =============================================================================

-- Batch statement 1 (success)
SELECT 'batch_1' AS scenario, COUNT(*) AS total_objects FROM _V_RELATION_COLUMN LIMIT 10;

-- Batch statement 2 (success, different shape)
SELECT 'batch_2' AS scenario, OBJTYPE, COUNT(*) AS cnt FROM _V_OBJ_RELATION GROUP BY OBJTYPE LIMIT 20;

-- Batch statement 3 (success, zero rows)
SELECT 'batch_3_empty' AS scenario WHERE 1 = 0;

-- =============================================================================
-- CANCELLATION TEST
-- Run the query below and immediately click Cancel
-- Expected: partial rows retained in result panel, exportable
-- =============================================================================
SELECT
    ROW_NUMBER() OVER (ORDER BY 1) AS row_num,
    'cancel_test_' || CAST(ROW_NUMBER() OVER (ORDER BY 1) AS VARCHAR(10)) AS data,
    RANDOM() AS val
FROM _V_RELATION_COLUMN a
CROSS JOIN _V_RELATION_COLUMN b
LIMIT 100000;
