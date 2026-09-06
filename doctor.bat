@echo off
title Multi API Web Search - Model Arena and Doctor
cd /d "%~dp0"
cls

echo ================================================================
echo       Multi API Web Search - Model Arena and Capability Doctor
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

if not exist ".env" goto NO_ENV

goto RUN

:NO_NODE
echo [ERROR] Node.js is not installed or not in PATH!
echo Please install Node.js v18 or higher from nodejs.org
echo.
pause
exit /b 1

:NO_ENV
echo [INFO] .env file not found.
if not exist ".env.example" goto MISSING_TEMPLATE

echo Creating .env from .env.example...
copy ".env.example" ".env" >nul
echo [SUCCESS] .env file created!
echo.
echo Opening .env in Notepad...
echo Please fill in your API Key and Base URL, then save and close Notepad.
echo.
notepad ".env"
echo Press any key when you have saved your .env file...
pause >nul

:RUN
echo Starting Model Arena...
echo.
node "bin\doctor.js"

echo.
echo ================================================================
echo Process finished. Press any key to exit...
echo ================================================================
pause >nul
exit /b 0

:MISSING_TEMPLATE
echo [ERROR] .env.example template not found!
pause
exit /b 1
