-- Quick reference for inline SQL variables.
-- Use this file to test editor completion and substitution behavior.
-- EXPECT: typing % should offer a %LET snippet.
-- EXPECT: typing & or $ should offer variables declared earlier in the file.

%LET region = 'EAST';
%LET threshold = 10;
%LET multiplier = %EVAL(2 + 3);

%PUT Region: &region;
%PUT Threshold: &threshold;
%PUT Multiplier: &multiplier;

SELECT
  '&region' AS quoted_reference_example,
  &threshold AS ampersand_reference,
  ${threshold} AS braced_reference,
  $region AS dollar_reference
FROM JUST_DATA.ADMIN.DIMDATE
WHERE CALENDARQUARTER >= &multiplier
  AND REGION = $region;
