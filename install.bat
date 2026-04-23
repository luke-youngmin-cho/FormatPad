@echo off
title FormatPad Install

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ================================
echo   FormatPad Install
echo ================================
echo.

set "SOURCE=%~dp0release\win-unpacked"
set "DEST=%ProgramFiles%\FormatPad"
set "EXE=%DEST%\FormatPad.exe"

if not exist "%SOURCE%\FormatPad.exe" (
    echo [ERROR] release\win-unpacked\FormatPad.exe not found.
    echo Run "npm run dist" first.
    pause
    exit /b 1
)

echo [1/6] Closing FormatPad...
taskkill /F /IM FormatPad.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/6] Copying files to %DEST%...
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SOURCE%\*" "%DEST%\" /s /e /q /y >nul

echo [3/6] Registering file associations...
reg add "HKLM\Software\Classes\FormatPad.md" /ve /d "Markdown Document" /f >nul
reg add "HKLM\Software\Classes\FormatPad.md\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
reg add "HKLM\Software\Classes\.md" /ve /d "FormatPad.md" /f >nul
reg add "HKLM\Software\Classes\.md\OpenWithProgids" /v "FormatPad.md" /f >nul
reg add "HKLM\Software\Classes\.markdown" /ve /d "FormatPad.md" /f >nul
reg add "HKLM\Software\Classes\.markdown\OpenWithProgids" /v "FormatPad.md" /f >nul
reg add "HKLM\Software\Classes\.mdx" /ve /d "FormatPad.md" /f >nul
reg add "HKLM\Software\Classes\.mdx\OpenWithProgids" /v "FormatPad.md" /f >nul

echo [4/6] Registering app capabilities...
reg add "HKLM\Software\FormatPad\Capabilities" /v "ApplicationName" /d "FormatPad" /f >nul
reg add "HKLM\Software\FormatPad\Capabilities" /v "ApplicationDescription" /d "Markdown File Reader" /f >nul
reg add "HKLM\Software\FormatPad\Capabilities\FileAssociations" /v ".md" /d "FormatPad.md" /f >nul
reg add "HKLM\Software\FormatPad\Capabilities\FileAssociations" /v ".markdown" /d "FormatPad.md" /f >nul
reg add "HKLM\Software\FormatPad\Capabilities\FileAssociations" /v ".mdx" /d "FormatPad.md" /f >nul
reg add "HKLM\Software\RegisteredApplications" /v "FormatPad" /d "Software\FormatPad\Capabilities" /f >nul

echo [5/6] Setting file associations...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mdx\UserChoice" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoiceLatest" /v Hash /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoiceLatest" /v ProgId /d "FormatPad.md" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoiceLatest" /v Hash /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoiceLatest" /v ProgId /d "FormatPad.md" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mdx\UserChoiceLatest" /v Hash /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mdx\UserChoiceLatest" /v ProgId /d "FormatPad.md" /f >nul 2>&1

echo [6/6] Creating desktop shortcut...
powershell -Command "$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut($env:USERPROFILE+'\Desktop\FormatPad.lnk');$sc.TargetPath='%EXE%';$sc.WorkingDirectory='%DEST%';$sc.Save()" 2>nul

ie4uinit.exe -show 2>nul

:: Create a sample .md file for association setup
set "SAMPLE=%TEMP%\FormatPad_open_with_this.md"
echo # FormatPad Setup > "%SAMPLE%"
echo. >> "%SAMPLE%"
echo Right-click this file, select "Open with", choose FormatPad, click "Always". >> "%SAMPLE%"

echo.
echo ================================
echo   Install complete!
echo ================================
echo.
echo   Installed to: %DEST%
echo.
echo   [IMPORTANT] One more step needed:
echo   A file explorer window will open.
echo   Right-click the .md file, select "Open with",
echo   choose "FormatPad", then click "Always".
echo.
pause

:: Open explorer with the sample file selected
explorer.exe /select,"%SAMPLE%"
