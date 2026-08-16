%INCLUDE 'shared-report-settings.sql';

%PUT Running report for &report_region from include settings;

%IF &export_report = 1 %THEN %DO;
  %EXPORT(
    file='/tmp/dimdate-report.xlsx',
    sheet='Dim Date',
    query=(
      SELECT DATEKEY, CALENDARQUARTER
      FROM JUST_DATA.ADMIN.DIMDATE
      WHERE CALENDARQUARTER = &report_region
    ),
    overwrite=true
  );
%ELSE %DO;
  SELECT DATEKEY, CALENDARQUARTER
  FROM JUST_DATA.ADMIN.DIMDATE
  WHERE CALENDARQUARTER = &report_region;
%END;
