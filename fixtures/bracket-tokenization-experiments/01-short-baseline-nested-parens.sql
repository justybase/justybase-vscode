-- EXPERIMENT 01: Baseline — short lines, nested parentheses (control group)
-- EXPECT: all bracket pairs match and share the same color.

SELECT
    UPPER(TRIM(a.accountname)) AS name,
    COALESCE(
        SUBSTRING(
            REPLACE(a.description, '(legacy)', ''),
            1,
            50
        ),
        '(no description)'
    ) AS clean_desc
FROM (
    SELECT *
    FROM JUST_DATA..DIMACCOUNT
    WHERE (status = 'ACTIVE' OR (status = 'PENDING' AND (review_flag = 'Y')))
) a
WHERE (a.accountkey > 0)
  AND ((a.country = 'US') OR (a.country = 'CA'));
