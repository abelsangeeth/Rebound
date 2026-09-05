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
