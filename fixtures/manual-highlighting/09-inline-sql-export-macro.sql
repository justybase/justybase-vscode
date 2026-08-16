-- Manual execution check: SQL-backed export macro.
-- EXPECT: %EXPORT executes its inner query during preprocessing and writes the file.
-- EXPECT: The %EXPORT directive is stripped; only the final SELECT is sent as the main query.
-- EXPECT: overwrite=false refuses an existing target; set overwrite=true to replace it.
--
-- Visual flow:
--   %LET export_file = '/tmp/dimdate_export.xlsx'
--   %EXPORT(query=(SELECT ...), file=&export_file) -> XLSX file on disk
--   final SELECT                                  -> ordinary SQL result

%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET export_file = '/tmp/justybase_dimdate_export.xlsx';

%EXPORT(
  format='xlsx',
  file=&export_file,
  sheet='Dim Date',
  query=(
    SELECT DATEKEY, CALENDARQUARTER
    FROM &dim_table
    WHERE DATEKEY = %SQL(
      SELECT MAX(DATEKEY)
      FROM &dim_table
    )
  ),
  overwrite=true
);

%PUT Exported current DIMDATE row to &export_file;

SELECT &export_file AS exported_file;
