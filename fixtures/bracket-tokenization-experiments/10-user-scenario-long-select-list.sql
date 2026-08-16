-- EXPERIMENT 10: Realistic user scenario — very wide SELECT list + long VARCHAR literal
-- Mimics generated SQL / ETL exports with hundreds of columns on one line.

-- Part A: wide expression list (scroll right to test bracket hover at line end)
SELECT
    a.accountkey,
    a.accountname,
    COALESCE(a.description, 'n/a') AS description,
    UPPER(TRIM(a.city)) AS city,
    UPPER(TRIM(a.state)) AS state,
    CASE WHEN a.status = 'ACTIVE' THEN 1 WHEN a.status = 'PENDING' THEN 2 ELSE 0 END AS status_code,
    SUBSTRING(REPLACE(REPLACE(a.notes, '(', '['), ')', ']'), 1, 200) AS notes_clean,
    LENGTH(TRIM(COALESCE(a.accountname, ''))) AS name_len,
    (SELECT COUNT(*) FROM JUST_DATA..DIMACCOUNT x WHERE (x.country = a.country) AND (x.status = a.status)) AS peer_count
FROM JUST_DATA..DIMACCOUNT a
WHERE (a.accountkey BETWEEN 1 AND 1000)
  AND (COALESCE(a.description, '') <> '');

-- Part B: single mega-line (uncomment to test horizontal scroll + bracket matching)
/*
SELECT a.accountkey, a.accountname, COALESCE(a.description,'x'), UPPER(TRIM(a.city)), UPPER(TRIM(a.state)), CASE WHEN a.status='ACTIVE' THEN 1 ELSE 0 END, SUBSTRING(a.notes,1,50), (SELECT COUNT(*) FROM JUST_DATA..DIMACCOUNT x WHERE (x.country=a.country)) FROM JUST_DATA..DIMACCOUNT a WHERE (a.accountkey>0) AND (a.description='LONG_LITERAL: (fake open paren) ................................................................................................................................................................ (fake close paren) ................................................................................................................................................................ END')
*/
