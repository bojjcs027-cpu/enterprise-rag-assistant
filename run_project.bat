@echo off
setlocal
cd /d "%~dp0"

echo Starting OmniCorp Enterprise RAG Assistant...
echo ==============================================

:: Verify Python is available
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found on PATH. Install Python 3.11+ and retry.
    goto :fail
)

:: Check if .env exists, if not, create it from .env.example with a real secret
if not exist ".env" (
    echo .env not found. Creating from .env.example...
    copy .env.example .env >nul
    for /f "delims=" %%s in ('python -c "import secrets; print(secrets.token_urlsafe(64))"') do set "GEN_SECRET=%%s"
    python -c "import re,os; p=open('.env').read(); open('.env','w').write(re.sub(r'JWT_SECRET_KEY=.*', 'JWT_SECRET_KEY=' + os.environ['GEN_SECRET'], p))"
    echo Generated a random JWT_SECRET_KEY automatically.
)

:: Install requirements (skipped once a marker exists; delete .deps_installed to force)
if not exist ".deps_installed" (
    echo Installing dependencies - this may take a while on first run...
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed. See output above.
        goto :fail
    )
    echo ok> .deps_installed
)

:: Start the server
echo Starting the server at http://127.0.0.1:8000 ...
python run.py --server
if errorlevel 1 (
    echo [ERROR] Server exited with an error. See output above.
    goto :fail
)
goto :end

:fail
echo.
echo Startup failed.

:end
pause
