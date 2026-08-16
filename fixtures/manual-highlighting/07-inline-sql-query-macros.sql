-- Manual execution check: SQL-backed macro variables.
-- EXPECT: %SQL runs the inner query and substitutes its first row/first column.
-- EXPECT: %SQLLIST runs the inner query and substitutes a SQL literal list.
-- EXPECT: inner macro queries can use values declared by earlier %LET directives.
--
-- Visual flow:
--   %LET as_of_key = %SQL(query)        -> one scalar value
--   %SQLLIST(query) inside IN (...)     -> 'A', 'B', 'C'
--   final SELECT sent to Netezza        -> no macro functions remain

%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);

%PUT As-of DATEKEY resolved from database: &as_of_key;

SELECT
  d.DATEKEY,
  d.CALENDARQUARTER,
  &as_of_key AS as_of_key
FROM &dim_table d
WHERE d.DATEKEY = &as_of_key
  AND d.CALENDARQUARTER IN (
    %SQLLIST(
      SELECT DISTINCT CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY >= %EVAL(&as_of_key - 30)
    )
  )
ORDER BY d.DATEKEY;

