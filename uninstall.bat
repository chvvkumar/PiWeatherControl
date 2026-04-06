@echo off
REM PiWeatherControl — Windows Uninstaller
REM Removes the virtual environment and optionally the config.

setlocal
set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv"

echo === PiWeatherControl Uninstaller ===

REM ── Remove virtual environment ────────────────────────────
if exist "%VENV_DIR%" (
    set /p "REMOVE_VENV=Remove virtual environment at %VENV_DIR%? [y/N] "
    if /i "%REMOVE_VENV%"=="y" (
        rmdir /s /q "%VENV_DIR%"
        echo Virtual environment removed.
    )
) else (
    echo No virtual environment found at %VENV_DIR%
)

REM ── Optionally remove config ──────────────────────────────
if exist "%SCRIPT_DIR%config.json" (
    set /p "REMOVE_CONFIG=Remove config.json (your settings will be lost)? [y/N] "
    if /i "%REMOVE_CONFIG%"=="y" (
        del "%SCRIPT_DIR%config.json"
        echo Config removed.
    )
)

echo.
echo === Uninstall complete ===
echo Source files remain in %SCRIPT_DIR%

endlocal
pause
