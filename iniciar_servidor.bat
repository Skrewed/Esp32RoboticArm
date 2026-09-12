@echo off
chcp 65001 > nul
title Servidor - Braço Robótico ESP32
cd /d %~dp0

echo ====================================================================
echo  🤖 INICIANDO CENTRAL DE CONTROLE DO BRAÇO ROBÓTICO ESP32
echo ====================================================================
echo.

:: 1. Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Python não encontrado no PATH!
    echo Instale o Python 3.10+ marcando a opção Add python.exe to PATH.
    echo Comando sugerido: winget install Python.Python.3.12
    pause
    exit /b 1
)

:: 2. Verificar FFmpeg (Necessário para converter áudios)
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [AVISO] FFmpeg não encontrado no PATH!
    echo Funções de áudio e música podem falhar.
    echo Instale rapidamente via: winget install Gyan.FFmpeg
    echo.
)

:: 3. Verificar Node.js (Necessário para yt-dlp desofuscar YouTube)
node -v >nul 2>&1
if errorlevel 1 (
    echo [AVISO] Node.js não encontrado no PATH!
    echo Download do YouTube pode falhar se não houver runtime JS.
    echo Instale rapidamente via: winget install OpenJS.NodeJS.LTS
    echo.
)

:: 4. Ambiente Virtual Python
if not exist venv\Scripts\activate.bat (
    echo [INFO] Criando ambiente virtual Python (venv)...
    python -m venv venv
    echo [INFO] Instalando dependências de requirements.txt...
    call venv\Scripts\activate.bat
    pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

:: 5. Verificar .env
if not exist .env (
    if exist .env.example (
        echo [INFO] Criando arquivo .env a partir de .env.example...
        copy .env.example .env >nul
        echo [AVISO] Configure suas chaves no arquivo .env se for usar STT/LLM em nuvem.
    )
)

echo.
echo [OK] Tudo pronto! Iniciando servidor FastAPI na porta 8000...
echo Interface Web disponível em: http://127.0.0.1:8000
echo Pressione CTRL+C para encerrar.
echo.

:: Abrir navegador automaticamente
start http://127.0.0.1:8000

:: Executar Uvicorn
python -m uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload

pause
