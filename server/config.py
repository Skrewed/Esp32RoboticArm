import os
import sys
import shutil
from pathlib import Path

# Base paths
BASE_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = BASE_DIR / ".env"
STATIC_DIR = BASE_DIR / "web"
MODELS_3D_DIR = (BASE_DIR / "artefatos" / "3d") if (BASE_DIR / "artefatos" / "3d").exists() else (BASE_DIR / "3d")
MODELS_3D_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR = BASE_DIR / "server" / "media"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
ARM_CONFIG_FILE = BASE_DIR / "server" / "arm_config.json"

# Ensure venv Scripts and standard Windows utility folders are in os.environ["PATH"]
VENV_SCRIPTS = BASE_DIR / "venv" / "Scripts"
EXTRA_PATH_DIRS = [
    str(VENV_SCRIPTS),
    r"C:\ffmpeg\bin",
    r"C:\Program Files\nodejs",
    r"C:\Program Files (x86)\nodejs"
]
for p in EXTRA_PATH_DIRS:
    if os.path.exists(p) and p.lower() not in os.environ.get("PATH", "").lower():
        os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")

def get_ffmpeg_executable() -> str:
    """Finds absolute path to ffmpeg executable with fallbacks."""
    which = shutil.which("ffmpeg")
    if which:
        return which
    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "ffmpeg"

def get_ffmpeg_dir() -> str | None:
    """Returns directory containing ffmpeg binary for tools like yt-dlp."""
    exe = get_ffmpeg_executable()
    if os.path.isabs(exe) and os.path.exists(exe):
        return str(Path(exe).parent)
    which = shutil.which("ffmpeg")
    return str(Path(which).parent) if which else None

def get_node_executable() -> str | None:
    """Finds absolute path to node executable for yt-dlp JS runtime."""
    which = shutil.which("node")
    if which:
        return which
    candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None

# Initialize API keys strictly from environment or .env file (NEVER hardcode secrets in source code)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", os.getenv("groq", ""))
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", os.getenv("voxtralArm", ""))

# Load .env using python-dotenv if installed
try:
    from dotenv import load_dotenv
    if ENV_PATH.exists():
        load_dotenv(dotenv_path=ENV_PATH, override=True)
        GROQ_API_KEY = os.getenv("GROQ_API_KEY", os.getenv("groq", GROQ_API_KEY))
        MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", os.getenv("voxtralArm", MISTRAL_API_KEY))
except ImportError:
    pass

# Direct parser fallback to ensure .env is always loaded even without python-dotenv
if ENV_PATH.exists():
    try:
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k in ["groq", "GROQ_API_KEY"] and v:
                        GROQ_API_KEY = v
                    elif k in ["voxtralArm", "MISTRAL_API_KEY"] and v:
                        MISTRAL_API_KEY = v
    except Exception as e:
        print(f"[Config] Erro ao ler arquivo .env: {e}")

if not GROQ_API_KEY:
    print("[Config] AVISO: Nenhuma chave 'groq' configurada no .env da raiz. As funções de IA por voz necessitam desta chave.")

# Server settings
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8000

# ESP32 settings
ESP32_DEFAULT_IP = "192.168.4.1" # Default AP IP or LAN IP
ESP32_PORT = 80

# Technical sheet pins (from Descritivo Técnico - Esquema v8)
# MG90S: D13, D14, D18, D19
# MG996R: D25, D26, D27
TECHNICAL_PINS = {
    "D13": {"gpio": 13, "type": "MG90S", "buffer": "A1-IN > B1-OUT (Pinos 2 e 18)", "default_joint": "garra_abertura"},
    "D14": {"gpio": 14, "type": "MG90S", "buffer": "A2-IN > B2-OUT (Pinos 3 e 17)", "default_joint": "garra_rotacao"},
    "D18": {"gpio": 18, "type": "MG90S", "buffer": "A6-IN > B6-OUT (Pinos 7 e 13)", "default_joint": "ombro_slave"},
    "D19": {"gpio": 19, "type": "MG90S", "buffer": "A7-IN > B7-OUT (Pinos 8 e 12)", "default_joint": "punho"},
    "D25": {"gpio": 25, "type": "MG996R", "buffer": "A5-IN > B5-OUT (Pinos 6 e 14)", "default_joint": "base_rotacao"},
    "D26": {"gpio": 26, "type": "MG996R", "buffer": "A4-IN > B4-OUT (Pinos 5 e 15)", "default_joint": "cotovelo"},
    "D27": {"gpio": 27, "type": "MG996R", "buffer": "A3-IN > B3-OUT (Pinos 4 e 16)", "default_joint": "ombro_master"},
}

# I2S Pin mappings
I2S_MIC_PINS = {
    "WS": 33,
    "SCK": 32,
    "SD": 35
}

I2S_SPK_PINS = {
    "LRC": 21,
    "BCLK": 22,
    "DIN": 23
}

# Default Joint limits and home angles
DEFAULT_HOME_CONFIG = {
    "base_rotacao": 90,
    "ombro": 90,
    "cotovelo": 90,
    "punho": 90,
    "garra_rotacao": 90,
    "garra_abertura": 90
}

# 7 Servo Motors Limit Specifications (0° to 180° physical range, centered at 90° [-90° to +90°])
DEFAULT_SERVO_LIMITS = {
    "base_rotacao": {
        "id": "base_rotacao",
        "name": "Base (Rotação)",
        "type": "MG996R",
        "default_pin": 25,
        "min": 15,
        "max": 165,
        "axis": "base"
    },
    "ombro_master": {
        "id": "ombro_master",
        "name": "Ombro (Motor Principal / Master)",
        "type": "MG996R",
        "default_pin": 27,
        "min": 35,
        "max": 145,
        "axis": "ombro",
        "role": "master"
    },
    "ombro_slave": {
        "id": "ombro_slave",
        "name": "Ombro (Motor Auxiliar / Slave)",
        "type": "MG90S",
        "default_pin": 18,
        "min": 35,
        "max": 145,
        "axis": "ombro",
        "role": "slave"
    },
    "cotovelo": {
        "id": "cotovelo",
        "name": "Cotovelo",
        "type": "MG996R",
        "default_pin": 26,
        "min": 25,
        "max": 105,
        "axis": "cotovelo"
    },
    "punho": {
        "id": "punho",
        "name": "Punho (Inclinação / Pitch)",
        "type": "MG90S",
        "default_pin": 19,
        "min": 35,
        "max": 145,
        "axis": "punho"
    },
    "garra_rotacao": {
        "id": "garra_rotacao",
        "name": "Garra (Rotação / Roll)",
        "type": "MG90S",
        "default_pin": 14,
        "min": 0,
        "max": 180,
        "axis": "garra_rotacao"
    },
    "garra_abertura": {
        "id": "garra_abertura",
        "name": "Garra (Abertura / Pinça)",
        "type": "MG90S",
        "default_pin": 13,
        "min": 45,
        "max": 135,
        "axis": "garra_abertura"
    }
}

SERVO_LIMITS = DEFAULT_SERVO_LIMITS
