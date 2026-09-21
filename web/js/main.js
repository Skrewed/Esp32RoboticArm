/**
 * main.js - Core application orchestrator, WebSocket telemetry and UI binding
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. Initialize 3D Visualizer
  const arm = new Arm3DVisualizer("canvas-3d");
  window.armVisualizer = arm;

  // 2. Initialize Subsystems
  const pinMgr = new PinManager();
  const homeMgr = new HomeManager(arm);
  const musicCtrl = new MusicDanceController(arm);
  const aiCtrl = new AITalkController(arm);

  window.pinManager = pinMgr;
  window.homeManager = homeMgr;
  window.musicDanceController = musicCtrl;
  window.aiTalkController = aiCtrl;
  const inputIp = document.getElementById("esp-ip-input");

  // 3. Coordinate Gimbal Holding State and User Interaction
  let lastUserInteractionTime = 0;

  window.onGimbalHoldStart = () => {
    lastUserInteractionTime = performance.now();
    // Pause music and AI talk if running
    if (musicCtrl.isPlaying) {
      musicCtrl.pause();
    }
    if (aiCtrl.isActive) {
      aiCtrl.stop();
    }
  };

  window.onGimbalHoldEnd = () => {
    lastUserInteractionTime = performance.now();
    // Ao soltar, garante que o gimbal permaneça perfeitamente fixado na ponta da garra
    arm.syncGimbalToClawTip();
    // Envia os ângulos finais alvos consolidados
    sendJointMovement(arm.targetAngles, 55);
  };

  // Throttled real-time angle sender for gimbal interaction
  let lastMoveSendTime = 0;
  window.onArmAnglesChanged = (angles) => {
    lastUserInteractionTime = performance.now();
    updateAngleDisplays(angles);
    const now = performance.now();
    if (now - lastMoveSendTime > 33) { // ~30 fps max transmission rate
      lastMoveSendTime = now;
      sendJointMovement(angles, 70);
    }
  };

  // Real-time HUD and slider update as the 3D model moves in lockstep with the physical arm
  window.onArmRenderedAnglesChanged = (angles) => {
    updateAngleDisplays(angles);
  };

  // 4. WebSocket Telemetry Connection
  let ws = null;
  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleTelemetry(data);
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(connectWebSocket, 2000);
    };
  }
  connectWebSocket();

  function sendJointMovement(angles, speed = 60) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "move", angles, speed }));
    } else {
      fetch("/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ angles, speed })
      });
    }
  }

  function handleTelemetry(data) {
    const badgeConn = document.getElementById("badge-esp-status");
    const badgeText = document.getElementById("esp-status-text");

    if (data.connected) {
      badgeConn.className = "badge badge-connected";
      badgeText.textContent = `ESP32 Online (${data.ip})`;
    } else {
      badgeConn.className = "badge badge-simulated";
      badgeText.textContent = "Simulador Virtual";
    }

    const now = performance.now();
    const userRecentlyInteracted = (now - lastUserInteractionTime) < 800;
    const isAutonomous = Boolean(
      data.music_playing ||
      (musicCtrl && musicCtrl.isPlaying) ||
      window.isHomingActive ||
      (aiCtrl && aiCtrl.isSteeringArm)
    );

    // O modelo 3D só é atualizado pela telemetria se:
    // 1) Uma rotina autônoma estiver em execução (música, busca por voz, bring home), OU
    // 2) O usuário não estiver segurando o gimbal e não tiver interagido nos últimos 800ms
    //    E o hardware real do ESP32 estiver conectado (refletindo o braço físico).
    if (data.angles && !arm.isHoldingGimbal) {
      if (isAutonomous) {
        arm.applyAllAngles(data.angles);
      } else if (!userRecentlyInteracted && data.connected) {
        arm.applyAllAngles(data.angles);
      }
    }

    if (data.pins) {
      pinMgr.currentMapping = data.pins;
    }
    if (data.home_config && homeMgr) {
      homeMgr.onTelemetry(data.home_config);
    }

    if (inputIp && document.activeElement !== inputIp && data.ip) {
      inputIp.value = data.ip;
    }
  }

  function updateAngleDisplays(angles) {
    for (const [k, v] of Object.entries(angles)) {
      const rounded = Math.round(v);
      const badge = document.getElementById(`angle-val-${k}`);
      if (badge) badge.textContent = `${rounded}°`;

      const scaleCur = document.getElementById(`slider-cur-${k}`);
      if (scaleCur) scaleCur.innerHTML = `Atual: <strong>${rounded}°</strong>`;

      const slider = document.getElementById(`manual-slider-${k}`);
      if (slider && document.activeElement !== slider) {
        slider.value = rounded;
      }
    }
  }

  // 5. Manual Joint Sliders in Right HUD
  const joints = ["base_rotacao", "ombro", "cotovelo", "punho", "garra_rotacao", "garra_abertura"];
  joints.forEach((joint) => {
    const slider = document.getElementById(`manual-slider-${joint}`);
    if (slider) {
      slider.addEventListener("input", (e) => {
        lastUserInteractionTime = performance.now();
        const v = parseInt(e.target.value, 10);
        arm.targetAngles[joint] = v;
        arm.setJointAngle(joint, v);
        arm.syncGimbalToClawTip();
        updateAngleDisplays(arm.currentAngles);
        sendJointMovement(arm.targetAngles, 65);
      });
      slider.addEventListener("change", () => {
        lastUserInteractionTime = performance.now();
        arm.syncGimbalToClawTip();
        sendJointMovement(arm.targetAngles, 60);
      });
    }
  });

  // 6. Top Bar Action Buttons
  const btnStop = document.getElementById("btn-emergency-stop");
  if (btnStop) {
    btnStop.addEventListener("click", () => {
      if (musicCtrl.isPlaying) musicCtrl.stop();
      if (aiCtrl.isActive) aiCtrl.stop();
      fetch("/api/stop", { method: "POST" });
      showToast("Parada de Emergência acionada!");
    });
  }

  const btnOpenPins = document.getElementById("btn-open-pins");
  if (btnOpenPins) {
    btnOpenPins.addEventListener("click", () => pinMgr.open());
  }

  const btnUpdateIp = document.getElementById("btn-update-ip");
  const btnConnectIcon = document.getElementById("btn-connect-icon");
  const btnConnectText = document.getElementById("btn-connect-text");

  async function testAndConnectESP32() {
    if (!inputIp) return;
    const ip = inputIp.value.trim();
    if (!ip) {
      showToast("Por favor, digite o IP do ESP32.");
      return;
    }

    if (btnUpdateIp) {
      btnUpdateIp.classList.add("loading");
      if (btnConnectIcon) btnConnectIcon.textContent = "⏳";
      if (btnConnectText) btnConnectText.textContent = "Testando...";
    }

    try {
      const res = await fetch("/api/ip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip })
      });
      const data = await res.json();
      
      if (data.connected) {
        showToast(`✅ Conectado ao ESP32 com sucesso! (${data.ip})`);
      } else {
        showToast(`⚠️ ESP32 offline em ${data.ip}. Modo Simulado mantido.`);
      }
    } catch (e) {
      showToast("❌ Erro ao testar conexão com o servidor local.");
    } finally {
      if (btnUpdateIp) {
        btnUpdateIp.classList.remove("loading");
        if (btnConnectIcon) btnConnectIcon.textContent = "⚡";
        if (btnConnectText) btnConnectText.textContent = "Testar Conexão";
      }
    }
  }

  if (btnUpdateIp) {
    btnUpdateIp.addEventListener("click", testAndConnectESP32);
  }
  if (inputIp) {
    inputIp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        testAndConnectESP32();
      }
    });
  }

  // 7. Left Panel Tab Navigation
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const targetPane = document.getElementById(btn.dataset.target);
      if (targetPane) targetPane.classList.add("active");
    });
  });

  // 8. Toast notification system
  window.showToast = (msg) => {
    let toast = document.getElementById("app-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "app-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      toast.classList.remove("visible");
    }, 2800);
  };

  // 9. Light / Dark Theme Toggle
  const btnThemeToggle = document.getElementById("btn-theme-toggle");
  const themeToggleIcon = document.getElementById("theme-toggle-icon");
  const themeToggleText = document.getElementById("theme-toggle-text");

  function applyTheme(theme) {
    if (theme === "light") {
      document.body.classList.add("light-theme");
      if (themeToggleIcon) themeToggleIcon.textContent = "🌙";
      if (themeToggleText) themeToggleText.textContent = "Tema Escuro";
      if (arm) arm.setTheme("light");
    } else {
      document.body.classList.remove("light-theme");
      if (themeToggleIcon) themeToggleIcon.textContent = "☀️";
      if (themeToggleText) themeToggleText.textContent = "Tema Claro";
      if (arm) arm.setTheme("dark");
    }
    localStorage.setItem("arm_theme", theme);
  }

  // Restore saved theme or default to dark
  const savedTheme = localStorage.getItem("arm_theme") || "dark";
  applyTheme(savedTheme);

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
      const isCurrentlyLight = document.body.classList.contains("light-theme");
      const nextTheme = isCurrentlyLight ? "dark" : "light";
      applyTheme(nextTheme);
      showToast(nextTheme === "light" ? "☀️ Tema Claro ativado!" : "🌙 Tema Escuro ativado!");
    });
  }
});
