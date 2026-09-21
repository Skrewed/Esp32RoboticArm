@echo off
chcp 65001 > nul
title Servidor - Braco Robotico ESP32
cd /d "%~dp0"

echo ====================================================================
echo   INICIANDO CENTRAL DE CONTROLE DO BRACO ROBOTICO ESP32
echo ====================================================================
echo.

REM 1. Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Python nao encontrado no PATH!
    echo Instale o Python 3.10+ marcando a opcao Add python.exe to PATH.
    echo Comando sugerido: winget install Python.Python.3.12
    pause
    exit /b 1
)

REM 2. Verificar FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [AVISO] FFmpeg nao encontrado no PATH!
    echo Funcoes de audio e musica podem falhar.
    echo Instale rapidamente via: winget install Gyan.FFmpeg
    echo.
)

REM 3. Verificar Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo [AVISO] Node.js nao encontrado no PATH!
    echo Download do YouTube pode falhar se nao houver runtime JS.
    echo Instale rapidamente via: winget install OpenJS.NodeJS.LTS
    echo.
)

REM 4. Ambiente Virtual Python
if not exist "%~dp0venv\Scripts\activate.bat" (
    echo [INFO] Criando ambiente virtual Python [venv]...
    python -m venv "%~dp0venv"
    echo [INFO] Instalando dependencias de requirements.txt...
    call "%~dp0venv\Scripts\activate.bat"
    "%~dp0venv\Scripts\python.exe" -m pip install --upgrade pip
    "%~dp0venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
) else (
    call "%~dp0venv\Scripts\activate.bat"
)

REM 5. Verificar .env
if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        echo [INFO] Criando arquivo .env a partir de .env.example...
        copy "%~dp0.env.example" "%~dp0.env" >nul
        echo [AVISO] Configure suas chaves no arquivo .env se for usar STT/LLM em nuvem.
    )
)

echo.
echo [OK] Tudo pronto! Iniciando servidor FastAPI na porta 8000...
echo Interface Web disponivel em: http://127.0.0.1:8000
echo Pressione CTRL+C para encerrar.
echo.

REM Abrir navegador automaticamente
start http://127.0.0.1:8000

REM Executar Uvicorn
"%~dp0venv\Scripts\python.exe" -m uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload --reload-dir "%~dp0server"

if errorlevel 1 (
    echo [ERRO] O servidor foi finalizado ou ocorreu uma falha na execucao.
    pause
)
