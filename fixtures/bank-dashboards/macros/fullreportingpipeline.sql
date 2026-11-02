-- Macro Full Reporting Pipeline: Complete pipeline with variables, SQL/EVAL, branching, logging and export
%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET output_file = /tmp/monthly-report.xlsx;
%LET run_report = 1;
%LET as_of_key = %SQL(SELECT MAX(DATEKEY) FROM &dim_table);
%LET min_key = %EVAL(&as_of_key - 30);
%IF &run_report = 1 %THEN %DO;
  %PUT Running report for &dim_table, DATEKEY=&as_of_key;
  %EXPORT(
    format='xlsx',
    file='/tmp/monthly-report.xlsx',
    sheet='Daily',
    query=(
      SELECT DATEKEY, CALENDARQUARTER
      FROM &dim_table
      WHERE DATEKEY BETWEEN &min_key AND &as_of_key
      ORDER BY DATEKEY
    ),
    overwrite=true
  );
%ELSE %DO;
  %PUT Report disabled;
%END;
