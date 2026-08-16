-- EXPERIMENT 05: Alternating string literals and nested function calls on ONE line
-- HOW TO TEST: scroll horizontally; hover each ')' on the right side.
-- EXPECT: ')' after function chain matches function '('; ')' inside strings ignored.

SELECT
    'prefix (not a bracket) ' || TRIM(SUBSTRING(UPPER(COALESCE(a.description, '(empty)')), 1, 100)) || ' suffix (also ignored)' AS mixed_col,
    CASE
        WHEN a.status IN ('ACTIVE', 'PENDING (review)', 'CLOSED (final)') THEN COALESCE(LENGTH(TRIM(a.accountname)), 0)
        ELSE 0
    END AS status_len
FROM JUST_DATA..DIMACCOUNT a
WHERE a.description LIKE '%(pattern)%'
  AND (COALESCE(a.accountkey, 0) > (SELECT MIN(accountkey) FROM JUST_DATA..DIMACCOUNT WHERE (country = 'US')));
