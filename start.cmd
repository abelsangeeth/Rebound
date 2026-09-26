@echo off
REM Start the whole Rebound stack.
REM
REM   start.cmd          bring everything up
REM   start.cmd -Demo    ...and prepare a recording-ready state
REM
REM %~dp0 is this file's own directory, so this works from ANY current
REM directory and from a double-click in Explorer. A bare
REM `-File scripts\start-all.ps1` is resolved against wherever the shell
REM happens to be, which fails the moment you are one folder deep.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" %*

REM On a double-click the console closes the instant this script ends, so a
REM failure message would be on screen for zero milliseconds. Hold the window
REM open when something actually went wrong.
if errorlevel 1 (
    echo.
    echo   Startup failed -- the reason is printed above.
    echo.
    pause
)
