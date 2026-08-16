-- Manual syntax highlighting and execution check: SAS-style SQL variables.
-- EXPECT: %LET declarations are stripped before execution.
-- EXPECT: %EVAL resolves arithmetic from earlier declarations.
-- EXPECT: %PUT writes resolved text to the execution log.
-- EXPECT: $name, ${name}, and &name all resolve to the same declared value.

%LET points_cutoff = 20;
%LET base_score = 5;
%LET bonus = %EVAL((&base_score * 2) + 1);
%LET report_title = 'Monthly score report';

%PUT Report: &report_title;
%PUT Cutoff: &points_cutoff;
%PUT Bonus: &bonus;

SELECT
  d.ACCOUNTKEY,
  d.DATEKEY,
  &points_cutoff AS cutoff_value,
  ${bonus} AS bonus_value,
  $report_title AS report_title
FROM JUST_DATA.ADMIN.DIMDATE d
WHERE d.CALENDARQUARTER >= &base_score
  AND d.DATEKEY >= &points_cutoff
ORDER BY d.DATEKEY;

