-- Manual syntax highlighting check: Netezza qualified names.
-- EXPECT: live qualified names get TextMate fallback and semantic colors when available.

-- P16: DB.SCHEMA.TABLE after FROM.
SELECT d.DATEKEY, d.CALENDARQUARTER
FROM JUST_DATA.ADMIN.DIMDATE d
WHERE d.DATEKEY > 20240101;

-- P15: DB..TABLE after JOIN.
SELECT d.DATEKEY, a.ACCOUNTKEY
FROM JUST_DATA.ADMIN.DIMDATE d
JOIN JUST_DATA..DIMACCOUNT a ON a.ACCOUNTKEY = d.DATEKEY;

-- P17: SCHEMA.TABLE after FROM/JOIN.
SELECT s.ACCOUNTKEY
FROM ADMIN.DIMACCOUNT s
JOIN ADMIN.DIMDATE dd ON dd.DATEKEY = s.ACCOUNTKEY;

-- EXPECT: qualified names inside comments stay comment-colored only.
/*
FROM JUST_DATA.ADMIN.DIMDATE d
JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id
JOIN ADMIN.DIMACCOUNT s ON s.id = a.id
*/

-- EXPECT: active qualified names still color after a closed block comment.
/* closed comment: FROM JUST_DATA.ADMIN.COMMENTED_TABLE */
SELECT *
FROM JUST_DATA.ADMIN.DIMDATE live_after_comment;

-- EXPECT: line comments do not leak P15/P16/P17 scopes.
-- FROM JUST_DATA.ADMIN.DIMDATE d JOIN JUST_DATA..DIMACCOUNT a JOIN ADMIN.DIMDATE x
SELECT *
FROM JUST_DATA..DIMACCOUNT;
