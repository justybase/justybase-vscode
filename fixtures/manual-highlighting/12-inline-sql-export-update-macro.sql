-- Manual authoring check: update an existing XLSX/XLSB workbook sheet.
-- EXPECT: update=true is accepted by the macro parser and linter.
-- EXPECT: the target workbook and named sheet must already exist.
-- EXPECT: only the selected sheet is replaced; other sheets remain intact.

%LET source_table = JUST_DATA.ADMIN.DIMDATE;

%EXPORT(
  format='xlsx',
  file='/tmp/existing-report.xlsx',
  sheet='Data',
  query=(SELECT DATEKEY, CALENDARQUARTER FROM &source_table),
  update=true
);

%EXPORT(
  format='xlsb',
  file='/tmp/existing-report.xlsb',
  sheet='Data',
  query=(SELECT DATEKEY, CALENDARQUARTER FROM &source_table),
  update=true
);

%PUT Refreshed both spreadsheet formats from &source_table;
