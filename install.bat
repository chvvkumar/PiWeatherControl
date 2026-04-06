@echo off
REM PiWeatherControl — Windows Installer
REM Creates a Python virtual environment and installs dependencies.

setlocal
set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv"

echo === PiWeatherControl Installer ===
echo Project directory: %SCRIPT_DIR%

REM ── Check Python ──────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python 3 is required but not found in PATH.
    exit /b 1
)

python -c "import sys; exit(0 if sys.version_info >= (3,9) else 1)"
if errorlevel 1 (
    echo ERROR: Python 3.9+ is required.
    exit /b 1
)

for /f "delims=" %%v in ('python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"') do set PY_VERSION=%%v
echo Found Python %PY_VERSION%

REM ── Create venv ───────────────────────────────────────────
if exist "%VENV_DIR%" (
    echo Virtual environment already exists at %VENV_DIR%
    set /p "RECREATE=Recreate it? [y/N] "
    if /i "%RECREATE%"=="y" (
        echo Removing old venv...
        rmdir /s /q "%VENV_DIR%"
    ) else (
        echo Reusing existing venv.
    )
)

if not exist "%VENV_DIR%" (
    echo Creating virtual environment...
    python -m venv "%VENV_DIR%"
)

REM ── Install dependencies ─────────────────────────────────
echo Installing dependencies...
"%VENV_DIR%\Scripts\pip.exe" install --upgrade pip
"%VENV_DIR%\Scripts\pip.exe" install -r "%SCRIPT_DIR%requirements.txt"

echo.
echo === Installation complete ===
echo.
echo To run:
echo   cd %SCRIPT_DIR%
echo   .venv\Scripts\activate
echo   python app.py
echo.
echo Or without activating:
echo   %VENV_DIR%\Scripts\python.exe app.py

endlocal
pause
