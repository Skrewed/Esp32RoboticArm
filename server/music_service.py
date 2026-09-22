import os
import sys
import re
import math
import time
import asyncio
import subprocess
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from scipy.signal import find_peaks
from server.config import (
    UPLOADS_DIR, get_ffmpeg_executable, get_ffmpeg_dir, get_node_executable
)

class MusicService:
    def __init__(self):
        self.current_song = None
        self.is_playing = False
        self.dance_task = None
        self.subscribers = set()
        self.playback_start_time = 0.0
        self.current_choreography = []
        self.current_song_duration = 0.0

    def download_youtube_audio(self, youtube_url: str) -> dict:
        """Downloads YouTube audio using yt-dlp and converts to MP3 & 16kHz WAV."""
        try:
            output_template = str(UPLOADS_DIR / "yt_%(id)s.%(ext)s")
            ffmpeg_exe = get_ffmpeg_executable()
            ffmpeg_dir = get_ffmpeg_dir()
            node_exe = get_node_executable()

            # Always invoke yt-dlp via sys.executable to prevent Windows WinError 2
            cmd = [
                sys.executable,
                "-m",
                "yt_dlp",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", "0",
                "--no-playlist",
                "-o", output_template
            ]
            if ffmpeg_dir:
                cmd.extend(["--ffmpeg-location", ffmpeg_dir])
            if node_exe:
                cmd.extend(["--js-runtimes", f"node:{node_exe}"])
            cmd.append(youtube_url)

            subprocess.run(cmd, check=True, capture_output=True, timeout=120)

            # Find the downloaded file
            mp3_files = list(UPLOADS_DIR.glob("yt_*.mp3"))
            if not mp3_files:
                return {"success": False, "error": "Arquivo não encontrado após download."}

            latest_mp3 = max(mp3_files, key=os.path.getctime)
            wav_path = latest_mp3.with_suffix(".wav")
            pcm_path = latest_mp3.with_suffix(".pcm")

            # Convert to 16kHz WAV for analysis
            subprocess.run([
                ffmpeg_exe, "-y", "-i", str(latest_mp3),
                "-ar", "16000", "-ac", "1",
                str(wav_path)
            ], check=True, capture_output=True, timeout=30)

            # Convert to 16kHz raw PCM for ESP32 I2S
            subprocess.run([
                ffmpeg_exe, "-y", "-i", str(latest_mp3),
                "-ar", "16000", "-ac", "1", "-f", "s16le",
                str(pcm_path)
            ], check=True, capture_output=True, timeout=30)

            choreo, duration = self.analyze_beats_and_choreograph(str(wav_path))

            return {
                "success": True,
                "title": latest_mp3.stem,
                "mp3_filename": latest_mp3.name,
                "mp3_url": f"/media/{latest_mp3.name}",
                "duration": duration,
                "beats_count": len(choreo)
            }
        except subprocess.CalledProcessError as e:
            err_msg = e.stderr.decode("utf-8", errors="ignore").strip() if e.stderr else str(e)
            err_lines = [l for l in err_msg.splitlines() if "ERROR:" in l or "error" in l.lower()]
            clean_err = err_lines[-1] if err_lines else (err_msg[:300] or str(e))
            print(f"[MusicService] YouTube process error: {clean_err}")
            return {"success": False, "error": clean_err}
        except Exception as e:
            print(f"[MusicService] YouTube download error: {e}")
            return {"success": False, "error": str(e)}

    def process_local_file(self, file_path: Path) -> dict:
        """Converts uploaded file to MP3, 16kHz WAV and raw PCM, then extracts choreography."""
        try:
            ffmpeg_exe = get_ffmpeg_executable()
            mp3_path = file_path.with_suffix(".mp3")
            wav_path = file_path.with_suffix(".wav")
            pcm_path = file_path.with_suffix(".pcm")

            # Ensure MP3 exists
            if file_path.suffix.lower() != ".mp3":
                subprocess.run([
                    ffmpeg_exe, "-y", "-i", str(file_path),
                    "-b:a", "192k",
                    str(mp3_path)
                ], check=True, capture_output=True, timeout=30)

            # Convert to 16kHz WAV
            subprocess.run([
                ffmpeg_exe, "-y", "-i", str(mp3_path),
                "-ar", "16000", "-ac", "1",
                str(wav_path)
            ], check=True, capture_output=True, timeout=30)

            # Convert to raw PCM
            subprocess.run([
                ffmpeg_exe, "-y", "-i", str(mp3_path),
                "-ar", "16000", "-ac", "1", "-f", "s16le",
                str(pcm_path)
            ], check=True, capture_output=True, timeout=30)

            choreo, duration = self.analyze_beats_and_choreograph(str(wav_path))

            return {
                "success": True,
                "title": mp3_path.stem,
                "mp3_filename": mp3_path.name,
                "mp3_url": f"/media/{mp3_path.name}",
                "duration": duration,
                "beats_count": len(choreo)
            }
        except Exception as e:
            print(f"[MusicService] Process local file error: {e}")
            return {"success": False, "error": str(e)}

    def analyze_beats_and_choreograph(self, wav_path: str):
        """Analyzes audio energy and onsets to generate smooth beat-synchronized dance motions."""
        try:
            sr, data = wavfile.read(wav_path)
            if data.ndim > 1:
                data = data[:, 0]
            data = data.astype(np.float32)

            duration = len(data) / float(sr)
            self.current_song_duration = duration

            # Compute short-time energy envelope (hop size ~ 20ms)
            hop_size = int(sr * 0.02)
            window_size = int(sr * 0.04)
            num_frames = int(math.floor((len(data) - window_size) / hop_size))

            if num_frames <= 0:
                return [], duration

            energy = np.zeros(num_frames)
            for i in range(num_frames):
                segment = data[i * hop_size : i * hop_size + window_size]
                energy[i] = np.sqrt(np.mean(segment ** 2) + 1e-8)

            # High-pass filter of energy for onset novelty
            energy_diff = np.diff(energy, prepend=energy[0])
            energy_diff = np.maximum(0, energy_diff)

            # Peak detection for beats
            peaks, properties = find_peaks(
                energy_diff,
                height=np.mean(energy_diff) * 1.3,
                distance=int(0.25 / 0.02) # min 250ms between beats (~240 BPM max)
            )

            beat_times = peaks * 0.02

            # Generate choreographic keyframes
            keyframes = []
            dance_modes = ["groove", "sway", "headbang", "claw_snap"]

            for idx, t in enumerate(beat_times):
                mode = dance_modes[idx % len(dance_modes)]
                phase = (idx % 8) / 8.0 * (2 * math.pi)

                # Rhythmic base sway
                base_angle = int(90 + 35 * math.sin(phase))
                
                # Shoulder & elbow rhythmic nodding
                if mode == "headbang" or idx % 2 == 0:
                    ombro_angle = int(90 - 25)
                    cotovelo_angle = int(90 + 30)
                else:
                    ombro_angle = int(90 + 15)
                    cotovelo_angle = int(90 - 15)

                # Wrist pitch & roll
                punho_angle = int(90 + 20 * math.cos(phase))
                garra_rot_angle = int(90 + 40 * math.sin(phase * 1.5))

                # Claw snapping to beats
                garra_abertura = 125 if (idx % 2 == 0) else 65

                keyframes.append({
                    "time": round(float(t), 2),
                    "base_rotacao": int(np.clip(base_angle, 25, 155)),
                    "ombro": int(np.clip(ombro_angle, 40, 140)),
                    "cotovelo": int(np.clip(cotovelo_angle, 40, 140)),
                    "punho": int(np.clip(punho_angle, 30, 150)),
                    "garra_rotacao": int(np.clip(garra_rot_angle, 20, 160)),
                    "garra_abertura": int(np.clip(garra_abertura, 50, 130)),
                    "speed": 100
                })

            self.current_choreography = keyframes
            return keyframes, duration
        except Exception as e:
            print(f"[MusicService] Beat detection error: {e}")
            return [], 0.0

    def get_pose_at_time(self, current_sec: float) -> dict:
        """Interpolates between choreography keyframes for smooth continuous servo motion."""
        if not self.current_choreography:
            # Fallback rhythmic ambient sway
            base = int(90 + 25 * math.sin(current_sec * 2.0))
            ombro = int(90 + 15 * math.cos(current_sec * 3.0))
            cotovelo = int(90 - 15 * math.cos(current_sec * 3.0))
            punho = int(90 + 20 * math.sin(current_sec * 4.0))
            garra_rot = int(90 + 30 * math.sin(current_sec * 1.5))
            garra_abertura = int(90 + 35 * math.sin(current_sec * 6.0))
            return {
                "base_rotacao": base,
                "ombro": ombro,
                "cotovelo": cotovelo,
                "punho": punho,
                "garra_rotacao": garra_rot,
                "garra_abertura": int(np.clip(garra_abertura, 50, 130)),
                "speed": 80
            }

        choreo = self.current_choreography
        # Find adjacent keyframes
        prev_kf = choreo[0]
        next_kf = choreo[-1]

        if current_sec <= prev_kf["time"]:
            return prev_kf
        if current_sec >= next_kf["time"]:
            return next_kf

        for i in range(len(choreo) - 1):
            if choreo[i]["time"] <= current_sec <= choreo[i + 1]["time"]:
                prev_kf = choreo[i]
                next_kf = choreo[i + 1]
                break

        # Linear interpolation factor
        dt = next_kf["time"] - prev_kf["time"]
        alpha = (current_sec - prev_kf["time"]) / dt if dt > 0 else 0.0
        # Smooth step (Hermite)
        alpha = alpha * alpha * (3 - 2 * alpha)

        interpolated = {}
        for joint in ["base_rotacao", "ombro", "cotovelo", "punho", "garra_rotacao", "garra_abertura"]:
            val = prev_kf[joint] + alpha * (next_kf[joint] - prev_kf[joint])
            interpolated[joint] = int(round(val))

        interpolated["speed"] = 90
        return interpolated

music_service = MusicService()
