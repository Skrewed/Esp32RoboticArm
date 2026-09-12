/**
 * home_manager.js - Gerenciador da posição Home e calibração personalizada de repouso
 */

class HomeManager {
  constructor(armVisualizer) {
    this.arm = armVisualizer;
    this.homeConfig = {
      base_rotacao: 90,
      ombro: 90,
      cotovelo: 90,
      punho: 90,
      garra_rotacao: 90,
      garra_abertura: 90
    };

    // Load persisted home from localStorage if present
    const saved = localStorage.getItem("arm_custom_home");
    if (saved) {
      try {
        this.homeConfig = JSON.parse(saved);
      } catch (e) {}
    }

    this.initUI();
  }

  initUI() {
    this.btnBringHome = document.getElementById("btn-bring-home");
    this.btnEditHome = document.getElementById("btn-edit-home");
    this.modal = document.getElementById("modal-home");
    this.container = document.getElementById("home-sliders-container");
    this.btnSave = document.getElementById("btn-save-home");
    this.btnCaptureCurrent = document.getElementById("btn-capture-current-home");
    this.btnResetDefault = document.getElementById("btn-reset-default-home");
    this.btnClose = document.getElementById("btn-close-home");

    if (this.btnBringHome) {
      this.btnBringHome.addEventListener("click", () => this.bringHome());
    }

    if (this.btnEditHome) {
      this.btnEditHome.addEventListener("click", () => this.openModal());
    }

    if (this.btnClose) {
      this.btnClose.addEventListener("click", () => this.closeModal());
    }

    if (this.btnSave) {
      this.btnSave.addEventListener("click", () => this.saveHomeConfig());
    }

    if (this.btnCaptureCurrent) {
      this.btnCaptureCurrent.addEventListener("click", () => this.captureCurrentPose());
    }

    if (this.btnResetDefault) {
      this.btnResetDefault.addEventListener("click", () => this.resetPhysicalDefault());
    }
  }

  async bringHome() {
    window.isHomingActive = true;
    if (this.arm) {
      this.arm.applyAllAngles(this.homeConfig);
      this.arm.syncGimbalToClawTip();
    }
    try {
      await fetch("/api/home", { method: "POST" });
      if (window.showToast) window.showToast("Movendo para a Posição Home...");
    } catch (e) {
      console.error("Erro ao enviar comando home:", e);
    } finally {
      setTimeout(() => {
        window.isHomingActive = false;
        if (this.arm) this.arm.syncGimbalToClawTip();
      }, 1500);
    }
  }

  openModal() {
    this.renderSliders();
    this.modal.classList.add("active");
  }

  closeModal() {
    this.modal.classList.remove("active");
  }

  renderSliders() {
    if (!this.container) return;
    this.container.innerHTML = "";

    const jointLabels = {
      base_rotacao: "Base Rotação",
      ombro: "Ombro",
      cotovelo: "Cotovelo",
      punho: "Punho",
      garra_rotacao: "Garra Rotação",
      garra_abertura: "Garra Abertura"
    };

    const jointLimits = {
      base_rotacao: { min: 15, max: 165 },
      ombro: { min: 35, max: 145 },
      cotovelo: { min: 25, max: 105 },
      punho: { min: 35, max: 145 },
      garra_rotacao: { min: 0, max: 180 },
      garra_abertura: { min: 45, max: 135 }
    };

    for (const [joint, val] of Object.entries(this.homeConfig)) {
      const lim = jointLimits[joint] || { min: 0, max: 180 };
      const clampedVal = Math.max(lim.min, Math.min(lim.max, val));
      this.homeConfig[joint] = clampedVal;

      const row = document.createElement("div");
      row.className = "input-group joint-control-group";

      const header = document.createElement("div");
      header.className = "joint-row";
      header.innerHTML = `
        <span class="joint-name">${jointLabels[joint] || joint}</span>
        <span class="joint-badge" id="val-home-${joint}">${clampedVal}°</span>
      `;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "joint-slider";
      slider.min = lim.min;
      slider.max = lim.max;
      slider.value = clampedVal;
      slider.dataset.joint = joint;

      const scale = document.createElement("div");
      scale.className = "slider-scale";
      scale.innerHTML = `
        <span class="scale-limit">${lim.min}°</span>
        <span class="scale-current" id="scale-cur-home-${joint}">Atual: <strong>${clampedVal}°</strong></span>
        <span class="scale-limit">${lim.max}°</span>
      `;

      slider.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        document.getElementById(`val-home-${joint}`).textContent = `${v}°`;
        const curIndicator = document.getElementById(`scale-cur-home-${joint}`);
        if (curIndicator) curIndicator.innerHTML = `Atual: <strong>${v}°</strong>`;
        this.homeConfig[joint] = v;
        // Preview in 3D in real time
        if (this.arm) {
          this.arm.setJointAngle(joint, v);
          this.arm.syncGimbalToClawTip();
        }
      });

      row.appendChild(header);
      row.appendChild(slider);
      row.appendChild(scale);
      this.container.appendChild(row);
    }
  }

  captureCurrentPose() {
    if (this.arm) {
      for (const joint of Object.keys(this.homeConfig)) {
        if (this.arm.currentAngles[joint] !== undefined) {
          this.homeConfig[joint] = this.arm.currentAngles[joint];
        }
      }
      this.renderSliders();
      if (window.showToast) window.showToast("Posição atual capturada para o Home!");
    }
  }

  resetPhysicalDefault() {
    this.homeConfig = {
      base_rotacao: 90,
      ombro: 90,
      cotovelo: 90,
      punho: 90,
      garra_rotacao: 90,
      garra_abertura: 90
    };
    this.renderSliders();
    if (this.arm) {
      this.arm.applyAllAngles(this.homeConfig);
    }
    if (window.showToast) window.showToast("Home restaurado para o padrão físico (90°).");
  }

  async saveHomeConfig() {
    localStorage.setItem("arm_custom_home", JSON.stringify(this.homeConfig));
    try {
      await fetch("/api/home/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: this.homeConfig })
      });
      this.closeModal();
      if (window.showToast) window.showToast("Nova posição Home salva com sucesso!");
    } catch (e) {
      console.error("Erro ao salvar config home:", e);
      this.closeModal();
    }
  }
}

window.HomeManager = HomeManager;
