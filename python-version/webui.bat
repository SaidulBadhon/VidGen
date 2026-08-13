@echo off
setlocal
set "CURRENT_DIR=%CD%"
echo ***** Current directory: %CURRENT_DIR% *****
set "PYTHONPATH=%CURRENT_DIR%"

rem set HF_ENDPOINT=https://hf-mirror.com

rem MPT_* was the pre-rebrand prefix; still honoured so existing setups keep working.
if not defined VIDGEN_WEBUI_HOST if defined MPT_WEBUI_HOST (
    echo ***** MPT_WEBUI_HOST is deprecated, use VIDGEN_WEBUI_HOST instead. *****
    set "VIDGEN_WEBUI_HOST=%MPT_WEBUI_HOST%"
)
if not defined VIDGEN_WEBUI_PORT if defined MPT_WEBUI_PORT (
    echo ***** MPT_WEBUI_PORT is deprecated, use VIDGEN_WEBUI_PORT instead. *****
    set "VIDGEN_WEBUI_PORT=%MPT_WEBUI_PORT%"
)

if not defined VIDGEN_WEBUI_HOST set "VIDGEN_WEBUI_HOST=127.0.0.1"
if not defined VIDGEN_WEBUI_PORT set "VIDGEN_WEBUI_PORT=8501"

set "STREAMLIT_CMD="
if exist "%CURRENT_DIR%\.venv\Scripts\python.exe" (
    set "STREAMLIT_CMD="%CURRENT_DIR%\.venv\Scripts\python.exe" -m streamlit"
) else if exist "%CURRENT_DIR%\lib\python\python.exe" (
    set "STREAMLIT_CMD="%CURRENT_DIR%\lib\python\python.exe" -m streamlit"
) else (
    where uv >nul 2>nul
    if not errorlevel 1 set "STREAMLIT_CMD=uv run streamlit"
)

if not defined STREAMLIT_CMD (
    where streamlit >nul 2>nul
    if not errorlevel 1 (
        echo ***** Warning: using streamlit from PATH. If dependencies fail, run 'uv sync --frozen' first. *****
        set "STREAMLIT_CMD=streamlit"
    )
)

if not defined STREAMLIT_CMD (
    echo ***** Neither project Python, uv, nor streamlit was found. Please install dependencies first. *****
    pause
    exit /b 1
)

set "SELECTED_WEBUI_PORT="
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$hostAddress=$null; foreach ($address in [Net.Dns]::GetHostAddresses($env:VIDGEN_WEBUI_HOST)) { if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { $hostAddress=$address; break } }; if ($null -eq $hostAddress) { exit 1 }; $preferred=[int]$env:VIDGEN_WEBUI_PORT; $candidates=New-Object System.Collections.Generic.List[int]; $candidates.Add($preferred); foreach ($candidate in 8502..8599) { if ($candidate -ne $preferred) { $candidates.Add($candidate) } }; foreach ($port in $candidates) { $socket=[Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Tcp); try { $socket.Bind([Net.IPEndPoint]::new($hostAddress,$port)); $socket.Close(); Write-Output $port; exit 0 } catch { try { $socket.Close() } catch {} } }; exit 1"') do set "SELECTED_WEBUI_PORT=%%P"

if not defined SELECTED_WEBUI_PORT (
    echo ***** No available WebUI port found in 8501-8599 for %VIDGEN_WEBUI_HOST%. *****
    echo ***** If Windows reports WinError 10013, check reserved ports: netsh interface ipv4 show excludedportrange protocol=tcp *****
    pause
    exit /b 1
)

if not "%SELECTED_WEBUI_PORT%"=="%VIDGEN_WEBUI_PORT%" (
    echo ***** Port %VIDGEN_WEBUI_PORT% is unavailable, using %SELECTED_WEBUI_PORT% instead. *****
)
set "VIDGEN_WEBUI_PORT=%SELECTED_WEBUI_PORT%"

echo ***** WebUI address: http://%VIDGEN_WEBUI_HOST%:%VIDGEN_WEBUI_PORT% *****
%STREAMLIT_CMD% run .\webui\Main.py --server.address=%VIDGEN_WEBUI_HOST% --server.port=%VIDGEN_WEBUI_PORT% --browser.serverAddress=%VIDGEN_WEBUI_HOST% --browser.gatherUsageStats=False --client.toolbarMode=minimal --logger.hideWelcomeMessage=True --server.showEmailPrompt=False --server.enableCORS=True
