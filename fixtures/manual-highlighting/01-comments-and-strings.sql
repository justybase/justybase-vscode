-- Manual syntax highlighting check: comments and strings.
-- Open as SQL/Netezza SQL after Developer: Reload Window.

-- EXPECT: live SELECT/FROM/table colored; only the text after -- is comment-colored.
SELECT CURRENT_DATE, d.DATEKEY
FROM JUST_DATA.ADMIN.DIMDATE d -- SELECT CALL DISTRIBUTE ON JUST_DATA..DIMACCOUNT should stay gray
WHERE d.CALENDARQUARTER > 0;

-- EXPECT: the whole block is one uniform comment color.
/*
SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE d
JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id
CALL JUST_DATA..SP_GET_ACCOUNT_DETAILS('12345');
DISTRIBUTE ON RANDOM;
CREATE TABLE x (id INT) DISTRIBUTE ON RANDOM;
${comment_var} $comment_var CURRENT_DATE
*/

-- EXPECT: nested block comment stays gray until the outer closing marker.
/* outer block start
   SELECT * FROM JUST_DATA.ADMIN.DIMDATE
   /* inner block start
      CALL JUST_DATA..SP_INNER();
      DISTRIBUTE ON RANDOM;
   inner block end */
   JOIN JUST_DATA..DIMACCOUNT
outer block end */
SELECT 1 AS after_nested_comment;

-- EXPECT: /*--*/ is comment-colored only; the table after it remains live SQL.
SELECT *
FROM /*--*/ JUST_DATA..DIMACCOUNT a
WHERE a.ACCOUNTKEY > 0;

-- EXPECT: comment markers inside strings are string-colored, not comment-colored.
SELECT
  '-- not a line comment' AS line_marker,
  '/* not a block comment */' AS block_marker,
  "*/quoted identifier/*" AS quoted_identifier
FROM JUST_DATA..DIMACCOUNT;

-- EXPECT: tail comment does not color DB..TABLE, CALL, or DISTRIBUTE as live code.
SELECT 42 -- JUST_DATA..DIMACCOUNT CALL PROCEDURE() DISTRIBUTE ON RANDOM
;
