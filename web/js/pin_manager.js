/**
 * pin_manager.js - Mapeamento dinâmico de pinos do ESP32 para cada servo
 */

class PinManager {
  constructor() {
    this.technicalPins = [
      { pin: "D13", gpio: 13, type: "MG90S", desc: "MG90S #1 (HCT245 A1>B1, pinos 2 e 18)" },
      { pin: "D14", gpio: 14, type: "MG90S", desc: "MG90S #2 (HCT245 A2>B2, pinos 3 e 17)" },
      { pin: "D18", gpio: 18, type: "MG90S", desc: "MG90S #3 (HCT245 A6>B6, pinos 7 e 13)" },
      { pin: "D19", gpio: 19, type: "MG90S", desc: "MG90S #4 (HCT245 A7>B7, pinos 8 e 12)" },
      { pin: "D25", gpio: 25, type: "MG996R", desc: "MG996R #3 (HCT245 A5>B5, pinos 6 e 14)" },
      { pin: "D26", gpio: 26, type: "MG996R", desc: "MG996R #2 (HCT245 A4>B4, pinos 5 e 15)" },
      { pin: "D27", gpio: 27, type: "MG996R", desc: "MG996R #1 (HCT245 A3>B3, pinos 4 e 16)" },
    ];

    this.currentMapping = {
      garra_abertura: 13,
      garra_rotacao: 14,
      ombro_slave: 18,
      punho: 19,
      base_rotacao: 25,
      cotovelo: 26,
      ombro_master: 27
    };

    this.initModal();
  }

  initModal() {
    this.modal = document.getElementById("modal-pins");
    this.container = document.getElementById("pin-mapping-list");
    this.btnSave = document.getElementById("btn-save-pins");
    this.btnClose = document.getElementById("btn-close-pins");

    if (this.btnClose) {
      this.btnClose.addEventListener("click", () => this.close());
    }

    if (this.btnSave) {
      this.btnSave.addEventListener("click", () => this.save());
    }
  }

  open(highlightJoint = null) {
    this.renderRows(highlightJoint);
    this.modal.classList.add("active");
  }

  close() {
    this.modal.classList.remove("active");
  }

  renderRows(highlightJoint) {
    if (!this.container) return;
    this.container.innerHTML = "";

    const jointLabels = {
      base_rotacao: "Base (Rotação Horizontal)",
      ombro_master: "Ombro Master (MG996R)",
      ombro_slave: "Ombro Slave (MG90S Invertido)",
      cotovelo: "Cotovelo (MG996R)",
      punho: "Punho (Pitch)",
      garra_rotacao: "Garra (Rotação/Roll)",
      garra_abertura: "Garra (Abertura/Pinça)"
    };

    for (const [jointKey, currentGpio] of Object.entries(this.currentMapping)) {
      const row = document.createElement("div");
      row.className = "pin-select-row";
      if (highlightJoint === jointKey) {
        row.style.borderColor = "var(--accent-cyan)";
        row.style.background = "rgba(56, 189, 248, 0.1)";
      }

      const label = document.createElement("div");
      label.innerHTML = `<strong>${jointLabels[jointKey] || jointKey}</strong>`;

      const select = document.createElement("select");
      select.className = "pin-select";
      select.dataset.joint = jointKey;

      this.technicalPins.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.gpio;
        opt.textContent = `${p.pin} (GPIO ${p.gpio}) - ${p.type}`;
        if (p.gpio === currentGpio) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });

      row.appendChild(label);
      row.appendChild(select);
      this.container.appendChild(row);
    }
  }

  async save() {
    const selects = this.container.querySelectorAll(".pin-select");
    const updated = {};
    selects.forEach((sel) => {
      updated[sel.dataset.joint] = parseInt(sel.value, 10);
    });

    this.currentMapping = updated;

    try {
      const res = await fetch("/api/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pins: updated })
      });
      const data = await res.json();
      if (data.success) {
        this.close();
        if (window.showToast) window.showToast("Mapeamento de pinos atualizado com sucesso!");
      }
    } catch (e) {
      console.error("Erro ao salvar pinos:", e);
      this.close();
    }
  }
}

window.PinManager = PinManager;
