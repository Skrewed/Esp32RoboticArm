/**
 * ai_talk.js - Live Portuguese conversational voice pipeline with Groq Whisper, Groq Chat & Mistral Voxtral TTS
 */

class AITalkController {
  constructor(armVisualizer) {
    this.arm = armVisualizer;
    this.isActive = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioContext = null;
    this.analyser = null;
    this.bandpassFilter = null;
    this.isSpeaking = false;
    this.isProcessing = false;
    this.hasSpoken = false;
    this.silenceTimer = null;
    this.turnMaxTimer = null;
    this.sensitivityThreshold = 35;

    this.initUI();
  }

  initUI() {
    this.btnToggle = document.getElementById("btn-ai-talk");
    this.btnSendNow = document.getElementById("btn-ai-send-now");
    this.chatContainer = document.getElementById("ai-chat-history");
    this.statusText = document.getElementById("ai-status-text");
    this.statusDot = document.getElementById("ai-status-dot");
    this.micCanvas = document.getElementById("ai-mic-visualizer");
    this.btnReset = document.getElementById("btn-ai-reset");
    this.micSourceSelect = document.getElementById("ai-mic-source");
    this.voiceSelect = document.getElementById("ai-voice-select");
    this.sensitivitySlider = document.getElementById("ai-sensitivity-slider");
    this.sensitivityVal = document.getElementById("ai-sensitivity-val");
    this.doaIndicator = document.getElementById("doa-indicator");
    this.doaText = document.getElementById("doa-text");

    if (this.btnToggle) {
      this.btnToggle.addEventListener("click", () => this.toggleAITalk());
    }

    if (this.btnSendNow) {
      this.btnSendNow.addEventListener("click", () => this.forceSend());
    }

    if (this.sensitivitySlider) {
      this.sensitivitySlider.addEventListener("input", (e) => {
        this.sensitivityThreshold = parseInt(e.target.value, 10);
        if (this.sensitivityVal) {
          this.sensitivityVal.textContent = this.sensitivityThreshold;
        }
      });
    }

    if (this.btnReset) {
      this.btnReset.addEventListener("click", () => this.resetConversation());
    }

    if (this.micCanvas) {
      this.ctx = this.micCanvas.getContext("2d");
    }
  }

  async toggleAITalk() {
    if (this.isActive) {
      this.stop();
    } else {
      await this.start();
    }
  }

  async start() {
    this.isActive = true;
    this.btnToggle.classList.add("btn-ai-active");
    this.btnToggle.textContent = "Desligar IA Talk";
    if (this.btnSendNow) this.btnSendNow.style.display = "inline-block";

    // Stop and pause all other features (3D manual control & music)
    if (window.musicDanceController) {
      window.musicDanceController.stop();
    }
    if (this.arm) {
      this.arm.controls.enabled = false;
      if (this.arm.gimbalControl) this.arm.gimbalControl.enabled = false;
    }

    this.setStatus("Iniciando escuta...", "amber");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.setupRecorder(stream);
      this.setupVisualizer(stream);
      this.setStatus("Ouvindo você...", "emerald");
      if (window.showToast) window.showToast("Modo IA Talk ativado! Fale com o braço robótico.");
    } catch (e) {
      console.warn("Could not access browser mic, using simulated audio stream:", e);
      this.setStatus("Microfone indisponível", "rose");
    }
  }

  stop() {
    this.isActive = false;
    this.btnToggle.classList.remove("btn-ai-active");
    this.btnToggle.textContent = "Iniciar IA Talk";
    if (this.btnSendNow) this.btnSendNow.style.display = "none";

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.turnMaxTimer) {
      clearTimeout(this.turnMaxTimer);
      this.turnMaxTimer = null;
    }

    if (this.doaIndicator) {
      this.doaIndicator.style.display = "none";
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    if (this.arm) {
      this.arm.controls.enabled = true;
      if (this.arm.gimbalControl) this.arm.gimbalControl.enabled = true;
    }

    this.setStatus("IA Talk Desligada", "dim");
  }

  forceSend() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this.turnMaxTimer) {
        clearTimeout(this.turnMaxTimer);
        this.turnMaxTimer = null;
      }
      this.mediaRecorder.stop();
    }
  }

  setupRecorder(stream) {
    this.mediaRecorder = new MediaRecorder(stream);
    this.audioChunks = [];
    this.hasSpoken = false;

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = async () => {
      if (this.turnMaxTimer) {
        clearTimeout(this.turnMaxTimer);
        this.turnMaxTimer = null;
      }
      if (!this.isActive) return;

      const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
      this.audioChunks = [];

      if (audioBlob.size > 2000) {
        await this.sendVoiceTurn(audioBlob);
      } else {
        this.resumeListening();
      }
    };

    this.startRecordingChunk();
  }

  startRecordingChunk() {
    if (!this.isActive || !this.mediaRecorder) return;
    this.hasSpoken = false;
    this.audioChunks = [];

    if (this.turnMaxTimer) clearTimeout(this.turnMaxTimer);
    // Max duration safety guard: auto-send after 8 seconds of continuous speech/noise
    this.turnMaxTimer = setTimeout(() => {
      if (this.isActive && !this.isProcessing && this.mediaRecorder && this.mediaRecorder.state === "recording") {
        if (this.hasSpoken) {
          console.log("[AITalk] Limite máximo de fala atingido (8s), enviando...");
          this.mediaRecorder.stop();
        }
      }
    }, 8000);

    this.mediaRecorder.start(250);
  }

  setupVisualizer(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    const source = this.audioContext.createMediaStreamSource(stream);

    // Bandpass filter to isolate human speech (300Hz - 3200Hz) and reject bird whistles & keyboard thuds
    this.bandpassFilter = this.audioContext.createBiquadFilter();
    this.bandpassFilter.type = "bandpass";
    this.bandpassFilter.frequency.value = 1400; // Center around primary speech formants
    this.bandpassFilter.Q.value = 0.85;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.4;

    source.connect(this.bandpassFilter);
    this.bandpassFilter.connect(this.analyser);

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkVolume = () => {
      if (!this.isActive) return;
      requestAnimationFrame(checkVolume);

      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      const threshold = this.sensitivityThreshold || 35;

      // Draw mic level & threshold indicator
      if (this.ctx && this.micCanvas) {
        const w = this.micCanvas.width;
        const h = this.micCanvas.height;
        this.ctx.clearRect(0, 0, w, h);

        // Level bar
        const levelW = Math.min(w, (avg / 100) * w);
        this.ctx.fillStyle = avg >= threshold ? "#a855f7" : "#475569";
        this.ctx.fillRect(0, 0, levelW, h);

        // Sensitivity threshold line marker
        const threshX = Math.min(w - 2, (threshold / 100) * w);
        this.ctx.fillStyle = "#38bdf8";
        this.ctx.fillRect(threshX, 0, 2, h);
      }

      // Voice Activity Detection (VAD)
      if (avg >= threshold) {
        this.hasSpoken = true;
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      } else if (this.hasSpoken && avg < (threshold * 0.7) && this.mediaRecorder && this.mediaRecorder.state === "recording") {
        // User finished speaking, count 800ms of quiet before finishing turn
        if (!this.silenceTimer && !this.isProcessing) {
          this.silenceTimer = setTimeout(() => {
            if (this.isActive && !this.isProcessing && this.mediaRecorder && this.mediaRecorder.state === "recording") {
              this.mediaRecorder.stop();
            }
          }, 800);
        }
      }
    };

    checkVolume();
  }

  async sendVoiceTurn(audioBlob) {
    this.isProcessing = true;
    this.setStatus("Processando e localizando voz...", "amber");

    const micSource = this.micSourceSelect ? this.micSourceSelect.value : "arm_mic";
    const voice = this.voiceSelect ? this.voiceSelect.value : "pt-BR-AntonioNeural";

    const formData = new FormData();
    formData.append("file", audioBlob, "voice.webm");
    formData.append("mic_source", micSource);
    formData.append("tts_voice", voice);

    try {
      const res = await fetch("/api/ai-talk/turn", {
        method: "POST",
        body: formData
      });
      const data = await res.json();

      if (data.success) {
        // Show Direction of Arrival indicator if detected
        if (data.doa && data.doa.confidence > 0.25 && this.doaIndicator && this.doaText) {
          const sideText = data.doa.side === "left" ? "Esquerda" : (data.doa.side === "right" ? "Direita" : "Frente");
          this.doaText.textContent = `Voz detectada à ${sideText} (${data.doa.angle_degrees}°) -> Virando base para você!`;
          this.doaIndicator.style.display = "block";
        }

        this.addChatBubble("user", data.user_text);
        this.addChatBubble("ai", data.ai_text);

        if (data.audio_base64) {
          this.setStatus("Braço Robótico falando...", "cyan");
          await this.playSpeechAudio(data.audio_base64);
        }
      } else {
        console.warn("AI Turn warning/empty:", data.error);
      }
    } catch (e) {
      console.error("Erro na comunicação com IA:", e);
    } finally {
      this.isProcessing = false;
      this.resumeListening();
    }
  }

  playSpeechAudio(base64Audio) {
    return new Promise((resolve) => {
      const audio = new Audio("data:audio/mp3;base64," + base64Audio);
      // Talking gesture animation
      const talkInterval = setInterval(() => {
        if (this.arm) {
          const clawAngle = 70 + Math.random() * 30;
          this.arm.setJointAngle("garra_abertura", Math.round(clawAngle));
        }
      }, 150);

      audio.onended = () => {
        clearInterval(talkInterval);
        if (this.arm) {
          this.arm.setJointAngle("garra_abertura", 90);
        }
        resolve();
      };
      audio.onerror = () => {
        clearInterval(talkInterval);
        resolve();
      };
      audio.play().catch(() => {
        clearInterval(talkInterval);
        resolve();
      });
    });
  }

  resumeListening() {
    if (this.isActive && this.mediaRecorder) {
      if (this.mediaRecorder.state === "inactive") {
        this.startRecordingChunk();
      }
      this.setStatus("Ouvindo você...", "emerald");
    }
  }

  addChatBubble(role, text) {
    if (!this.chatContainer) return;
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-${role}`;
    bubble.textContent = text;
    this.chatContainer.appendChild(bubble);
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
  }

  async resetConversation() {
    try {
      await fetch("/api/ai-talk/reset", { method: "POST" });
      if (this.chatContainer) this.chatContainer.innerHTML = "";
      if (window.showToast) window.showToast("Conversa com a IA reiniciada!");
    } catch (e) {}
  }

  setStatus(msg, colorType) {
    if (this.statusText) this.statusText.textContent = msg;
    if (this.statusDot) {
      this.statusDot.style.background =
        colorType === "emerald" ? "var(--accent-emerald)" :
        colorType === "amber" ? "var(--accent-amber)" :
        colorType === "rose" ? "var(--accent-rose)" :
        colorType === "cyan" ? "var(--accent-cyan)" : "var(--text-dim)";
    }
  }
}

window.AITalkController = AITalkController;
