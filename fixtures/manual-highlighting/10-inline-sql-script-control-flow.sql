%LET run_detail = 1;
%LET region = 'EAST';

%PUT Starting conditional inline SQL workflow for &region;

%IF &run_detail = 1 AND &region != 'WEST' %THEN %DO;
  SELECT
    DATEKEY,
    CALENDARQUARTER,
    &region AS report_region
  FROM JUST_DATA.ADMIN.DIMDATE
  WHERE CALENDARQUARTER IN (
    %SQLLIST(
      SELECT DISTINCT CALENDARQUARTER
      FROM JUST_DATA.ADMIN.DIMDATE
      WHERE DATEKEY >= %EVAL(20240731 - 30)
    )
  );
%ELSE %DO;
  %PUT Detail query skipped for &region;
%END;
