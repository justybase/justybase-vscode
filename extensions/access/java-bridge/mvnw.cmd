@echo off
where mvn >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  mvn %*
  exit /b %ERRORLEVEL%
)
echo Maven is required to build the Access bridge. Install Maven 3.9.11+ or provide mvn on PATH. 1>&2
exit /b 1
