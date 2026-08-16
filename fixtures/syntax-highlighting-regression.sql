-- =============================================================================
-- MANUAL REGRESSION: syntax highlighting (TextMate + semantic tokens)
-- Open as SQL in VS Code after extension reload (Developer: Reload Window).
-- Each section lists EXPECTED colors. Comment if something looks wrong.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- [1] ACTIVE QUERY — baseline (your confirmed-good example)
-- EXPECT: SELECT/FROM blue; 123 orange/green; JUST_DATA.ADMIN.DIMDATE teal;
--         alias D normal; NO coloring inside comments on this line.
-- -----------------------------------------------------------------------------
SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE D;

-- -----------------------------------------------------------------------------
-- [2] LINE COMMENT — code colored, tail gray
-- EXPECT: line 1 active colors; only "gray tail" after -- is comment-colored.
-- -----------------------------------------------------------------------------
SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE D  -- gray: kolory jak wcześniej OK

-- -----------------------------------------------------------------------------
-- [3] BLOCK COMMENT — entire block uniform comment gray
-- EXPECT: everything between /* and */ gray; no blue SELECT, no teal tables, no CALL.
-- -----------------------------------------------------------------------------
/*
SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE D
WHERE D.CALENDARQUARTER > 0
CALL PROCEDURE();
DISTRIBUTE ON RANDOM
EXECUTE IMMEDIATE 'SELECT 1';
CREATE TABLE x (id INT) DISTRIBUTE ON RANDOM;
*/

-- -----------------------------------------------------------------------------
-- [4] EDGE — /*--*/ between FROM and table (active SQL around it)
-- EXPECT: table JUST_DATA..DIMACCOUNT still teal (semantic); /*--*/ not breaking colors.
-- -----------------------------------------------------------------------------
SELECT * FROM /*--*/ JUST_DATA..DIMACCOUNT;

-- -----------------------------------------------------------------------------
-- [5] EDGE — string containing --
-- EXPECT: SELECT and FROM active; '--' inside string is NOT a comment.
-- -----------------------------------------------------------------------------
SELECT '--', * FROM JUST_DATA..DIMACCOUNT;

-- -----------------------------------------------------------------------------
-- [6] NETEZZA DDL/DML keywords in LIVE code (not inside comments)
-- EXPECT: DISTRIBUTE ON, MERGE, GROOM TABLE, MATERIALIZED VIEW highlighted.
-- -----------------------------------------------------------------------------
CREATE TABLE staging.example (id INT) DISTRIBUTE ON RANDOM;
MERGE INTO tgt USING src ON tgt.id = src.id WHEN MATCHED THEN UPDATE SET id = src.id;
GROOM TABLE JUST_DATA..DIMDATE;
CREATE MATERIALIZED VIEW mv AS SELECT 1;

-- -----------------------------------------------------------------------------
-- [7] NZPLSQL / variables in LIVE code
-- EXPECT: BEGIN_PROC, LANGUAGE, RETURNS, ${var}, $var colored; CALL in procedure body OK.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE p() RETURNS INT LANGUAGE NZPLSQL AS
BEGIN_PROC
  ${batch_id} := 1;
  PERFORM CALL helper();
END_PROC;

-- -----------------------------------------------------------------------------
-- [8] NESTED BLOCK COMMENTS
-- EXPECT: all /* ... */ regions gray; active SELECT on last line colored.
-- -----------------------------------------------------------------------------
/* outer start
   /* inner still comment */
   SELECT FROM CALL
   outer end */
SELECT 1;

-- -----------------------------------------------------------------------------
-- [9] MULTI-STATEMENT + comments between statements
-- EXPECT: both SELECTs active; middle -- line gray only.
-- -----------------------------------------------------------------------------
SELECT 1;
-- commented-out query: SELECT * FROM JUST_DATA..DIMACCOUNT
SELECT 2;

-- -----------------------------------------------------------------------------
-- [10] QUALIFIED NAMES (semantic; needs connection/parse for full teal)
-- EXPECT with metadata: DB / schema / table semantic colors on live lines only.
-- -----------------------------------------------------------------------------
SELECT d.*
FROM JUST_DATA.ADMIN.DIMDATE d
JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id;
