import time
import asyncio
import httpx
from server.config import (
    ESP32_DEFAULT_IP, ESP32_PORT, TECHNICAL_PINS,
    DEFAULT_HOME_CONFIG, SERVO_LIMITS
)

class ESP32Client:
    def __init__(self):
        self.ip = ESP32_DEFAULT_IP
        self.port = ESP32_PORT
        self.is_connected = False
        self.is_simulated = True
        
        # System status
        self.system_enabled = True
        
        # Exact angles (in transit) vs target angles (commanded goal)
        self.current_angles = {k: float(v) for k, v in DEFAULT_HOME_CONFIG.items()}
        self.target_angles = dict(DEFAULT_HOME_CONFIG)
        self.speed = 60
        self.is_moving = False
        self.home_config = dict(DEFAULT_HOME_CONFIG)
        
        # Pin mapping (Servo ID -> GPIO pin)
        self.pins_mapping = {
            "garra_abertura": 13,
            "garra_rotacao": 14,
            "ombro_slave": 18,
            "punho": 19,
            "base_rotacao": 25,
            "cotovelo": 26,
            "ombro_master": 27
        }

        self.last_check_time = 0.0
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(1.0, connect=0.5),
                limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
            )
        return self._client

    def set_ip(self, raw_ip: str) -> str:
        """Sanitizes raw IP/URL input and extracts port if specified."""
        ip = raw_ip.strip()
        if ip.startswith("http://"):
            ip = ip[7:]
        elif ip.startswith("https://"):
            ip = ip[8:]
        if ":" in ip:
            ip_part, port_part = ip.split(":", 1)
            ip = ip_part
            try:
                self.port = int(port_part.split("/")[0])
            except ValueError:
                pass
        if "/" in ip:
            ip = ip.split("/", 1)[0]
        self.ip = ip
        return self.ip

    @property
    def base_url(self):
        return f"http://{self.ip}:{self.port}"

    async def check_connection(self) -> bool:
        """Pings ESP32 status endpoint to verify if hardware is online."""
        try:
            client = self._get_client()
            resp = await client.get(f"{self.base_url}/status", timeout=1.2)
            if resp.status_code == 200:
                data = resp.json()
                self.is_connected = True
                self.is_simulated = False
                self.system_enabled = data.get("habilitado", True)
                # Sync angles if available
                for m in data.get("motores", []):
                    nome = m.get("nome")
                    atual = m.get("atual")
                    alvo = m.get("alvo")
                    # Map ombro_master to ombro for frontend compatibility
                    key = "ombro" if nome == "ombro_master" else nome
                    if key in self.current_angles and atual is not None:
                        self.current_angles[key] = float(atual)
                    if key in self.target_angles and alvo is not None:
                        self.target_angles[key] = int(alvo)
                return True
        except Exception:
            pass

        self.is_connected = False
        self.is_simulated = True
        return False

    async def poll_hardware_telemetry(self) -> bool:
        """Queries the ultra-fast /telemetry endpoint on ESP32 in real time."""
        if not self.is_connected:
            return False
        try:
            client = self._get_client()
            resp = await client.get(f"{self.base_url}/telemetry", timeout=0.35)
            if resp.status_code == 200:
                data = resp.json()
                # Fast mapping from ESP32 compact keys
                if "b" in data: self.current_angles["base_rotacao"] = float(data["b"])
                if "o" in data: self.current_angles["ombro"] = float(data["o"])
                if "c" in data: self.current_angles["cotovelo"] = float(data["c"])
                if "p" in data: self.current_angles["punho"] = float(data["p"])
                if "gr" in data: self.current_angles["garra_rotacao"] = float(data["gr"])
                if "ga" in data: self.current_angles["garra_abertura"] = float(data["ga"])
                self.is_moving = bool(data.get("m", 0))
                return True
        except Exception:
            pass
        return False

    def step_simulation(self, dt: float = 0.033) -> bool:
        """
        Simulates step-by-step physical servo motor kinematics in real time.
        Each servo moves at `self.speed` degrees per second, exactly mirroring
        the ESP32 firmware's atualizarMovimentos() timing!
        """
        changed = False
        any_moving = False
        # Degrees to advance in this dt step
        step = max(5.0, float(self.speed)) * dt

        for joint, target in self.target_angles.items():
            curr = self.current_angles.get(joint, float(target))
            diff = float(target) - curr
            if abs(diff) > 0.01:
                any_moving = True
                if abs(diff) <= step:
                    self.current_angles[joint] = float(target)
                else:
                    self.current_angles[joint] = curr + (step if diff > 0 else -step)
                changed = True

        self.is_moving = any_moving
        return changed

    async def send_move(self, angles: dict, speed: int = 60) -> dict:
        """Sends joint movement command to ESP32 or registers movement in simulator."""
        self.speed = max(1, min(180, int(speed)))
        
        # Clamp and store target angles
        for k, v in angles.items():
            if k in self.target_angles:
                lim = SERVO_LIMITS.get(k) or SERVO_LIMITS.get("ombro_master" if k == "ombro" else k, {"min": 0, "max": 180})
                min_val = lim.get("min", 0) if isinstance(lim, dict) else lim[0]
                max_val = lim.get("max", 180) if isinstance(lim, dict) else lim[1]
                val = max(min_val, min(max_val, int(v)))
                self.target_angles[k] = val
                if not self.is_connected:
                    self.current_angles[k] = float(val)

        self.is_moving = any(
            abs(self.current_angles[k] - self.target_angles[k]) > 0.5
            for k in self.target_angles
        )

        if self.is_connected:
            try:
                client = self._get_client()
                # Send with both query parameters and JSON body for universal compatibility
                payload = {k: int(v) for k, v in angles.items()}
                payload["speed"] = self.speed
                resp = await client.post(
                    f"{self.base_url}/move",
                    params=payload,
                    json=payload,
                    timeout=1.5
                )
                if resp.status_code in [200, 202]:
                    return {"success": True, "simulated": False, "target_angles": self.target_angles}
            except Exception as e:
                print(f"[ESP32Client] Send move error: {e}")
                self.is_connected = False
                self.is_simulated = True

        return {
            "success": True,
            "simulated": True,
            "target_angles": self.target_angles,
            "current_angles": {k: int(round(v)) for k, v in self.current_angles.items()}
        }

    async def send_home(self) -> dict:
        """Moves arm to the configured home position."""
        return await self.send_move(self.home_config, speed=35)

    def set_home_config(self, new_config: dict) -> dict:
        """Updates the default/custom home position for each joint."""
        for k, v in new_config.items():
            if k in self.home_config:
                self.home_config[k] = int(v)
        return {"success": True, "home_config": self.home_config}

    async def set_pins(self, new_pins: dict) -> dict:
        """Updates dynamic GPIO pin assignments for servos."""
        for k, v in new_pins.items():
            if k in self.pins_mapping:
                self.pins_mapping[k] = int(v)

        if self.is_connected:
            try:
                client = self._get_client()
                await client.post(f"{self.base_url}/pins", json=self.pins_mapping, timeout=2.0)
            except Exception:
                pass

        return {"success": True, "pins": self.pins_mapping}

    async def enable_system(self) -> dict:
        self.system_enabled = True
        if self.is_connected:
            try:
                client = self._get_client()
                await client.get(f"{self.base_url}/habilitar", timeout=1.5)
            except Exception:
                pass
        return {"success": True, "system_enabled": True}

    async def disable_system(self) -> dict:
        self.system_enabled = False
        if self.is_connected:
            try:
                client = self._get_client()
                await client.get(f"{self.base_url}/desabilitar", timeout=1.5)
            except Exception:
                pass
        return {"success": True, "system_enabled": False}

    async def stop_motion(self) -> dict:
        # Halt in place: target becomes current position
        for k in self.target_angles:
            self.target_angles[k] = int(round(self.current_angles[k]))
        self.is_moving = False

        if self.is_connected:
            try:
                client = self._get_client()
                await client.get(f"{self.base_url}/stop", timeout=1.5)
            except Exception:
                pass
        return {"success": True, "status": "stopped"}

    async def stream_audio_chunk(self, pcm_chunk: bytes) -> bool:
        """Streams audio chunk to ESP32 I2S speaker endpoint."""
        if not self.is_connected:
            return False
        try:
            client = self._get_client()
            await client.post(
                f"{self.base_url}/audio/stream",
                content=pcm_chunk,
                headers={"Content-Type": "application/octet-stream"},
                timeout=0.6
            )
            return True
        except Exception:
            return False

    async def capture_mic_audio(self) -> bytes:
        """Captures raw stereo audio buffer from ESP32 I2S INMP441 microphones."""
        if not self.is_connected:
            return b""
        try:
            client = self._get_client()
            resp = await client.get(f"{self.base_url}/mic/capture", timeout=3.0)
            if resp.status_code == 200:
                return resp.content
        except Exception as e:
            print(f"[ESP32Client] Mic capture error: {e}")
        return b""

    def get_status(self) -> dict:
        return {
            "success": True,
            "connected": self.is_connected,
            "simulated": self.is_simulated,
            "ip": self.ip,
            "port": self.port,
            "system_enabled": self.system_enabled,
            "is_moving": self.is_moving,
            "angles": {k: int(round(v)) for k, v in self.current_angles.items()},
            "target_angles": dict(self.target_angles),
            "home_config": self.home_config,
            "pins": self.pins_mapping,
            "technical_pins": TECHNICAL_PINS
        }

esp32_client = ESP32Client()
