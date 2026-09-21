import io
import os
import time
import base64
import asyncio
import subprocess
import httpx
import numpy as np
from server.config import GROQ_API_KEY, MISTRAL_API_KEY, get_ffmpeg_executable

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
MISTRAL_BASE_URL = "https://api.mistral.ai/v1"

SYSTEM_PROMPT = (
    "Você é a inteligência artificial do Braço Robótico ESP32. "
    "Responda sempre em português brasileiro de forma direta, concisa e objetiva (no máximo 1 a 2 frases curtas), "
    "pois sua resposta será sintetizada em voz no alto-falante do robô. "
    "Nunca use emojis, asteriscos ou formatações de markdown que fiquem estranhas quando faladas em voz alta."
)

class AIService:
    def __init__(self):
        self.groq_key = GROQ_API_KEY
        self.mistral_key = MISTRAL_API_KEY
        self.conversation_history = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        self.last_tts_time = 0.0
        self.lock = asyncio.Lock()

    def reset_conversation(self):
        self.conversation_history = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]

    def _convert_to_wav(self, audio_bytes: bytes) -> bytes:
        """Converts arbitrary audio bytes (webm, pcm, ogg, etc.) to 16kHz 16-bit mono WAV using ffmpeg."""
        try:
            ffmpeg_exe = get_ffmpeg_executable()
            process = subprocess.Popen(
                [ffmpeg_exe, "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            out, err = process.communicate(input=audio_bytes, timeout=10)
            if process.returncode == 0 and len(out) > 44:
                return out
        except Exception as e:
            print(f"[AIService] FFmpeg conversion error: {e}")
        return audio_bytes

    def _convert_mp3_to_pcm(self, mp3_bytes: bytes, sample_rate=16000) -> bytes:
        """Converts MP3 audio to raw 16-bit signed PCM mono for ESP32 I2S output."""
        try:
            ffmpeg_exe = get_ffmpeg_executable()
            process = subprocess.Popen(
                [ffmpeg_exe, "-y", "-i", "pipe:0", "-ar", str(sample_rate), "-ac", "1", "-f", "s16le", "pipe:1"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            out, err = process.communicate(input=mp3_bytes, timeout=10)
            if process.returncode == 0:
                return out
        except Exception as e:
            print(f"[AIService] MP3 to PCM conversion error: {e}")
        return b""

    async def speech_to_text(self, audio_bytes: bytes) -> str:
        """Transcribes speech using Groq whisper-large-v3-turbo in Portuguese."""
        wav_data = self._convert_to_wav(audio_bytes)
        url = f"{GROQ_BASE_URL}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self.groq_key}"}
        files = {"file": ("audio.wav", wav_data, "audio/wav")}
        data = {
            "model": "whisper-large-v3-turbo",
            "language": "pt",
            "response_format": "json"
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, files=files, data=data)
            if resp.status_code == 200:
                result = resp.json()
                text = result.get("text", "").strip()
                return text
            else:
                print(f"[AIService] Whisper error {resp.status_code}: {resp.text}")
                return ""

    async def chat_generate(self, user_text: str) -> str:
        """Generates AI response using Groq chat completions."""
        self.conversation_history.append({"role": "user", "content": user_text})

        # Keep history compact (system prompt + last 6 messages)
        if len(self.conversation_history) > 7:
            self.conversation_history = [self.conversation_history[0]] + self.conversation_history[-6:]

        url = f"{GROQ_BASE_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.groq_key}",
            "Content-Type": "application/json"
        }

        # Preferred model: openai/gpt-oss-safeguard-20b, fallback to openai/gpt-oss-20b
        models_to_try = ["openai/gpt-oss-safeguard-20b", "openai/gpt-oss-20b"]
        reply_text = ""

        async with httpx.AsyncClient(timeout=20.0) as client:
            for model_name in models_to_try:
                try:
                    payload = {
                        "model": model_name,
                        "messages": self.conversation_history,
                        "max_tokens": 150,
                        "temperature": 0.7
                    }
                    resp = await client.post(url, headers=headers, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        reply_text = data["choices"][0]["message"]["content"].strip()
                        if reply_text:
                            break
                    else:
                        print(f"[AIService] Chat error with {model_name} {resp.status_code}: {resp.text}")
                except Exception as e:
                    print(f"[AIService] Error calling chat model {model_name}: {e}")

        if not reply_text:
            reply_text = "Comando recebido. Estou pronto para ajudar."

        self.conversation_history.append({"role": "assistant", "content": reply_text})
        return reply_text

    async def text_to_speech(self, text: str, voice: str = "pt-BR-AntonioNeural") -> bytes:
        """
        Synthesizes speech in natural native Brazilian Portuguese (pt-BR)
        using Edge Neural TTS (default pt-BR-AntonioNeural, zero accent),
        with fallback to Mistral Voxtral.
        """
        # 1. Native Brazilian Portuguese via Edge-TTS (No accent, fluent, natural)
        if voice.startswith("pt-BR"):
            try:
                import edge_tts
                communicate = edge_tts.Communicate(text, voice)
                audio_data = b""
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_data += chunk["data"]
                if audio_data:
                    return audio_data
            except Exception as e:
                print(f"[AIService] Edge-TTS error for {voice}: {e}")

        # 2. Fallback to Mistral Voxtral
        async with self.lock:
            now = time.time()
            elapsed = now - self.last_tts_time
            if elapsed < 0.5:
                await asyncio.sleep(0.5 - elapsed)
            self.last_tts_time = time.time()

        url = f"{MISTRAL_BASE_URL}/audio/speech"
        headers = {
            "Authorization": f"Bearer {self.mistral_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": "voxtral-mini-tts-2603",
            "input": text,
            "voice": voice if not voice.startswith("pt-BR") else "en_paul_neutral"
        }

        async with httpx.AsyncClient(timeout=25.0) as client:
            try:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                    b64_audio = data.get("audio_data", "")
                    if b64_audio:
                        return base64.b64decode(b64_audio)
                else:
                    print(f"[AIService] Mistral TTS error {resp.status_code}: {resp.text}")
            except Exception as e:
                print(f"[AIService] Error calling Mistral TTS: {e}")

        return b""

    def estimate_sound_direction(self, stereo_pcm_bytes: bytes, sample_rate=16000, mic_distance_m=0.06) -> dict:
        """
        Estimates the horizontal direction of arrival (DOA) from stereo microphone audio (Left & Right).
        Returns:
            dict with angle_degrees, side ('left', 'right', 'center'), confidence [0.0, 1.0]
        """
        try:
            if len(stereo_pcm_bytes) < 1024:
                return {"angle_degrees": 0.0, "side": "center", "confidence": 0.0}

            data = stereo_pcm_bytes
            # Detect RIFF WAV header and extract raw audio frames
            if data[:4] == b"RIFF" and len(data) > 44:
                try:
                    import wave
                    import io
                    with wave.open(io.BytesIO(data), 'rb') as wf:
                        if wf.getframerate() > 0:
                            sample_rate = wf.getframerate()
                        if wf.getnchannels() == 2:
                            data = wf.readframes(wf.getnframes())
                        else:
                            return {"angle_degrees": 0.0, "side": "center", "confidence": 0.0}
                except Exception:
                    data = data[44:]

            # Unpack 16-bit interleaved stereo
            samples = np.frombuffer(data, dtype=np.int16)
            if len(samples) % 2 != 0:
                samples = samples[:-1]

            left_samples = samples[0::2]
            right_samples = samples[1::2]

            # 1. Interaural Level Difference (ILD)
            rms_left = np.sqrt(np.mean(left_samples.astype(np.float32) ** 2) + 1e-9)
            rms_right = np.sqrt(np.mean(right_samples.astype(np.float32) ** 2) + 1e-9)
            energy_diff = (rms_left - rms_right) / (rms_left + rms_right)

            # 2. Time Difference of Arrival (TDOA) via GCC-PHAT
            n = min(len(left_samples), 4096)
            x = left_samples[:n].astype(np.float32)
            y = right_samples[:n].astype(np.float32)

            n_fft = 2 ** int(np.ceil(np.log2(2 * n - 1)))
            X = np.fft.rfft(x, n=n_fft)
            Y = np.fft.rfft(y, n=n_fft)

            cross = Y * np.conj(X)
            denom = np.abs(cross) + 1e-9
            gcc_phat = np.fft.irfft(cross / denom, n=n_fft)

            c = 343.0 # speed of sound in m/s
            max_tau = int(np.ceil((mic_distance_m / c) * sample_rate)) + 2

            half = n_fft // 2
            gcc_shifted = np.roll(gcc_phat, half)
            search_range = gcc_shifted[half - max_tau : half + max_tau + 1]

            peak_idx = np.argmax(search_range) - max_tau
            tau_sec = peak_idx / sample_rate

            sin_theta = np.clip(c * tau_sec / mic_distance_m, -1.0, 1.0)
            tdoa_angle = float(np.degrees(np.arcsin(sin_theta)))

            # Acoustic barrier creates pronounced ILD
            ild_angle = float(energy_diff * 75.0)
            combined_angle = float(np.clip(0.6 * ild_angle + 0.4 * tdoa_angle, -80.0, 80.0))

            conf = float(min(1.0, abs(energy_diff) * 2.5 + abs(peak_idx) / (max_tau or 1)))
            side = "left" if combined_angle > 10.0 else ("right" if combined_angle < -10.0 else "center")

            return {
                "angle_degrees": round(combined_angle, 1),
                "side": side,
                "confidence": round(conf, 2)
            }
        except Exception as e:
            print(f"[AIService] Sound direction error: {e}")
            return {"angle_degrees": 0.0, "side": "center", "confidence": 0.0}

    async def process_turn(self, audio_bytes: bytes, is_arm_mic: bool = False, tts_voice: str = "pt-BR-AntonioNeural") -> dict:
        """Full pipeline: Audio In -> (DOA localization if Arm Mic) -> Whisper STT -> Groq Chat -> Native pt-BR TTS -> Audio Out."""
        # Check sound direction if stereo from arm mics
        doa_result = {"angle_degrees": 0.0, "side": "center", "confidence": 0.0}
        if is_arm_mic:
            doa_result = self.estimate_sound_direction(audio_bytes)

        user_text = await self.speech_to_text(audio_bytes)
        if not user_text:
            return {
                "success": False,
                "error": "Nenhum áudio detectado ou falha na transcrição.",
                "doa": doa_result
            }

        ai_text = await self.chat_generate(user_text)
        mp3_bytes = await self.text_to_speech(ai_text, voice=tts_voice)
        pcm_bytes = self._convert_mp3_to_pcm(mp3_bytes) if mp3_bytes else b""

        return {
            "success": True,
            "user_text": user_text,
            "ai_text": ai_text,
            "audio_base64": base64.b64encode(mp3_bytes).decode("utf-8") if mp3_bytes else "",
            "pcm_bytes": pcm_bytes,
            "pcm_len": len(pcm_bytes),
            "doa": doa_result
        }

ai_service = AIService()
