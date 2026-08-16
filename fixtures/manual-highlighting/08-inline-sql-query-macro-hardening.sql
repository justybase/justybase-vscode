-- Manual execution check: SQL-backed macro hardening.
-- EXPECT: Empty %SQLLIST results are substituted as NULL, so IN (...) remains valid.
-- EXPECT: %SQLLIST string values are SQL-escaped.
-- EXPECT: If an inner query fails, the user-facing error starts with
--         "Failed to execute %SQL macro query:" or "Failed to execute %SQLLIST macro query:".

%LET dim_table = JUST_DATA.ADMIN.DIMDATE;

-- Empty list visualisation:
--   %SQLLIST(query returning 0 rows) -> NULL
--   final SQL                       -> CALENDARQUARTER IN (NULL)
SELECT COUNT(*) AS matched_rows
FROM &dim_table
WHERE CALENDARQUARTER IN (
  %SQLLIST(
    SELECT CALENDARQUARTER
    FROM &dim_table
    WHERE 1 = 0
  )
);

-- Literal escaping visualisation:
--   values returned by %SQLLIST are quoted as SQL literals.
--   O'Brien becomes 'O''Brien'.
SELECT *
FROM (
  SELECT 'EAST' AS region
  UNION ALL
  SELECT 'O''Brien' AS region
) regions
WHERE region IN (
  %SQLLIST(
    SELECT 'EAST'
    UNION ALL
    SELECT 'O''Brien'
  )
);

-- Error wrapping visualisation:
-- Uncomment to confirm the error prefix is macro-specific.
-- SELECT %SQL(SELECT missing_column FROM JUST_DATA.ADMIN.DIMDATE);
