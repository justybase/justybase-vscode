-- Manual syntax highlighting check: mixed regression grid.
-- This file intentionally mixes live SQL, comments, strings, variables, DDL,
-- qualified names, and partially invalid snippets for visual inspection.

-- EXPECT: live code colored, comment tail gray only.
SELECT ${batch_id} AS batch_id, CURRENT_USER AS who_ran_it
FROM JUST_DATA.ADMIN.DIMDATE d -- ${not_live} CURRENT_DATE CALL JUST_DATA..SP()
WHERE d.DATEKEY BETWEEN 20240101 AND 20241231;

-- EXPECT: everything in this nested block remains comment-colored.
/* outer comment
SELECT CURRENT_DATE FROM JUST_DATA.ADMIN.DIMDATE;
CALL JUST_DATA..SP_COMMENTED();
DISTRIBUTE ON RANDOM;
  /* nested comment
     MERGE INTO tgt USING src ON tgt.id = src.id;
     JOIN JUST_DATA..DIMACCOUNT a ON a.id = src.id;
  */
CREATE TABLE commented_table (id INT) DISTRIBUTE ON RANDOM;
outer comment end */

-- EXPECT: active MERGE and qualified objects are colored.
MERGE INTO JUST_DATA.ADMIN.FACT_SALES tgt
USING JUST_DATA..STAGE_SALES src
ON tgt.SALE_ID = src.SALE_ID
WHEN MATCHED THEN UPDATE SET STATUS = src.STATUS
WHEN NOT MATCHED THEN INSERT (SALE_ID, STATUS) VALUES (src.SALE_ID, src.STATUS);

-- EXPECT: markers in strings do not begin/end comments.
SELECT
  'literal with -- CALL JUST_DATA..SP()' AS line_comment_text,
  'literal with /* SELECT * FROM JUST_DATA.ADMIN.DIMDATE */' AS block_comment_text,
  CURRENT_SCHEMA AS current_schema_value
FROM JUST_DATA..DIMACCOUNT;

-- EXPECT: after the inline block comment, active DB..TABLE still colors.
SELECT *
FROM JUST_DATA.ADMIN.DIMDATE d
JOIN /* inline comment JOIN JUST_DATA.ADMIN.BAD_TABLE */ JUST_DATA..DIMACCOUNT a
  ON a.ACCOUNTKEY = d.DATEKEY;

-- EXPECT: only this line is a comment; following SQL is live.
-- CALL JUST_DATA..SP_LINE_COMMENT(); DISTRIBUTE ON RANDOM; SELECT * FROM JUST_DATA..DIMACCOUNT
SHOW TABLE JUST_DATA.ADMIN.DIMDATE;
