/**
 * limits_manager.js - Gerenciador de Limites de Movimento (Min e Max) dos 7 Motores
 * Amplitude física máxima de 180° [-90° a +90°] por servo
 * Coordenação segura para o Eixo do Ombro (Dual-Motor Master + Slave Invertido)
 */

class LimitsManager {
	constructor(armVisualizer, homeManager) {
		this.arm = armVisualizer
		this.homeManager = homeManager
		this.isModalOpen = false

		this.motorSpecs = [
			{
				id: "base_rotacao",
				name: "Base",
				type: "MG996R",
				pin: 25,
				defaultMin: 15,
				defaultMax: 165,
				axis: "base",
			},
			{
				id: "ombro_master",
				name: "Ombro Master (Motor Principal)",
				type: "MG996R",
				pin: 27,
				defaultMin: 35,
				defaultMax: 145,
				axis: "ombro",
				role: "master",
			},
			{
				id: "ombro_slave",
				name: "Ombro Slave (Motor Auxiliar Invertido)",
				type: "MG90S",
				pin: 18,
				defaultMin: 35,
				defaultMax: 145,
				axis: "ombro",
				role: "slave",
			},
			{
				id: "cotovelo",
				name: "Cotovelo",
				type: "MG996R",
				pin: 26,
				defaultMin: 25,
				defaultMax: 105,
				axis: "cotovelo",
			},
			{
				id: "punho",
				name: "Punho (Inclinação)",
				type: "MG90S",
				pin: 19,
				defaultMin: 35,
				defaultMax: 145,
				axis: "punho",
			},
			{
				id: "garra_rotacao",
				name: "Garra (Rotação)",
				type: "MG90S",
				pin: 14,
				defaultMin: 0,
				defaultMax: 180,
				axis: "garra_rotacao",
			},
			{
				id: "garra_abertura",
				name: "Garra (Abertura e Pinça)",
				type: "MG90S",
				pin: 13,
				defaultMin: 45,
				defaultMax: 135,
				axis: "garra_abertura",
			},
		]

		// Limites ativos atuais dos 7 motores
		this.currentLimits = {}
		this.motorSpecs.forEach((spec) => {
			this.currentLimits[spec.id] = {
				min: spec.defaultMin,
				max: spec.defaultMax,
			}
		})

		// Cópia temporária para edição dentro do modal
		this.editingLimits = JSON.parse(JSON.stringify(this.currentLimits))

		// 1. Carrega do localStorage se existente
		const saved = localStorage.getItem("arm_custom_limits")
		if (saved) {
			try {
				const parsed = JSON.parse(saved)
				if (parsed && typeof parsed === "object") {
					for (const [k, v] of Object.entries(parsed)) {
						if (this.currentLimits[k] && v) {
							this.currentLimits[k].min = Math.max(0, Math.min(180, parseInt(v.min, 10) || 0))
							this.currentLimits[k].max = Math.max(0, Math.min(180, parseInt(v.max, 10) || 180))
						}
					}
				}
			} catch (e) {}
		}
		this.editingLimits = JSON.parse(JSON.stringify(this.currentLimits))

		this.initUI()
		this.fetchInitialLimits()
	}

	initUI() {
		this.modal = document.getElementById("modal-limits")
		this.container = document.getElementById("limits-motors-container")
		this.btnOpen = document.getElementById("btn-open-limits")
		this.btnOpenAlt = document.getElementById("btn-open-limits-alt")
		this.btnClose = document.getElementById("btn-close-limits")
		this.btnSave = document.getElementById("btn-save-limits")
		this.btnReset = document.getElementById("btn-reset-limits")
		this.shoulderInfoBox = document.getElementById("shoulder-coupling-info")

		if (this.btnOpen) {
			this.btnOpen.addEventListener("click", () => this.openModal())
		}
		if (this.btnOpenAlt) {
			this.btnOpenAlt.addEventListener("click", () => this.openModal())
		}
		if (this.btnClose) {
			this.btnClose.addEventListener("click", () => this.closeModal())
		}
		if (this.btnSave) {
			this.btnSave.addEventListener("click", () => this.saveLimits())
		}
		if (this.btnReset) {
			this.btnReset.addEventListener("click", () => this.resetFactoryDefaults())
		}

		// Fechar ao clicar fora do conteúdo
		if (this.modal) {
			this.modal.addEventListener("click", (e) => {
				if (e.target === this.modal) this.closeModal()
			})
		}

		// Aplica os limites iniciais aos sliders e visualizador
		this.applyLimitsToUI(this.currentLimits)
	}

	async fetchInitialLimits() {
		try {
			const res = await fetch("/api/limits")
			if (res.ok) {
				const data = await res.json()
				if (data && data.limits) {
					for (const [k, v] of Object.entries(data.limits)) {
						if (this.currentLimits[k]) {
							this.currentLimits[k].min = v.min
							this.currentLimits[k].max = v.max
						}
					}
					this.editingLimits = JSON.parse(JSON.stringify(this.currentLimits))
					localStorage.setItem("arm_custom_limits", JSON.stringify(this.currentLimits))
					this.applyLimitsToUI(this.currentLimits)
				}
			}
		} catch (e) {
			console.warn("Não foi possível carregar limites do servidor:", e)
		}
	}

	onTelemetry(serverLimits) {
		if (this.isModalOpen) return
		if (!serverLimits || typeof serverLimits !== "object") return

		let changed = false
		for (const [k, v] of Object.entries(serverLimits)) {
			if (this.currentLimits[k] && v) {
				const minV = parseInt(v.min, 10)
				const maxV = parseInt(v.max, 10)
				if (this.currentLimits[k].min !== minV || this.currentLimits[k].max !== maxV) {
					this.currentLimits[k].min = minV
					this.currentLimits[k].max = maxV
					changed = true
				}
			}
		}

		if (changed) {
			this.editingLimits = JSON.parse(JSON.stringify(this.currentLimits))
			localStorage.setItem("arm_custom_limits", JSON.stringify(this.currentLimits))
			this.applyLimitsToUI(this.currentLimits)
		}
	}

	toRelative(absAngle) {
		const rel = absAngle - 90
		return (rel > 0 ? `+${rel}` : `${rel}`) + "°"
	}

	calculateEffectiveShoulder(masterMin, masterMax, slaveMin, slaveMax) {
		// Ombro Master (MG996R) e Ombro Slave (MG90S, Invertido: slave = 180 - master)
		// Para que o slave fique em [slaveMin, slaveMax]:
		// slaveMin <= 180 - master <= slaveMax
		// => master >= 180 - slaveMax
		// => master <= 180 - slaveMin
		const effMin = Math.max(masterMin, 180 - slaveMax)
		const effMax = Math.min(masterMax, 180 - slaveMin)
		return {
			min: Math.min(effMin, effMax),
			max: Math.max(effMin, effMax),
			isValid: effMin <= effMax,
		}
	}

	getPinForMotor(motorId) {
		if (window.pinManager && window.pinManager.currentMapping && window.pinManager.currentMapping[motorId] !== undefined) {
			return window.pinManager.currentMapping[motorId];
		}
		const spec = this.motorSpecs.find((s) => s.id === motorId);
		return spec ? spec.pin : null;
	}

	updatePinMapping(pins) {
		if (!pins) return;
		this.motorSpecs.forEach((spec) => {
			if (pins[spec.id] !== undefined) {
				spec.pin = pins[spec.id];
				const tag = document.getElementById(`limits-pin-tag-${spec.id}`);
				if (tag) {
					tag.textContent = `GPIO ${spec.pin} (D${spec.pin})`;
				}
			}
		});
	}

	openModal() {
		this.isModalOpen = true;
		if (window.pinManager && window.pinManager.currentMapping) {
			this.updatePinMapping(window.pinManager.currentMapping);
		}
		this.editingLimits = JSON.parse(JSON.stringify(this.currentLimits));
		this.renderMotorsList();
		this.updateShoulderInfo();
		if (this.modal) this.modal.classList.add("active");
	}

	closeModal() {
		this.isModalOpen = false;
		if (this.modal) this.modal.classList.remove("active");
	}

	renderMotorsList() {
		if (!this.container) return;
		this.container.innerHTML = "";

		this.motorSpecs.forEach((spec) => {
			const isShoulder = spec.axis === "ombro";
			const limits = this.editingLimits[spec.id] || { min: spec.defaultMin, max: spec.defaultMax };
			const activePin = this.getPinForMotor(spec.id) || spec.pin;

			const card = document.createElement("div");
			card.className = `limits-motor-card ${isShoulder ? "shoulder-coupled-card" : ""}`;
			card.id = `limit-card-${spec.id}`;

			// Cabeçalho do motor
			const header = document.createElement("div");
			header.className = "limits-motor-header";
			header.innerHTML = `
        <div class="limits-motor-title-group">
          <span class="limits-motor-name">${spec.name}</span>
          <div class="limits-tags">
            <span class="limits-tag limits-tag-servo">${spec.type}</span>
            <span class="limits-tag limits-tag-pin" id="limits-pin-tag-${spec.id}">GPIO ${activePin} (D${activePin})</span>
            ${isShoulder ? `<span class="limits-tag limits-tag-shoulder">Eixo Duplo</span>` : ""}
          </div>
        </div>
        <div class="limits-span-indicator" id="span-${spec.id}">
          Amplitude: <strong>${limits.max - limits.min}°</strong>
        </div>
      `;

			// Barra visual de amplitude
			const barContainer = document.createElement("div")
			barContainer.className = "limits-range-visualizer"
			barContainer.innerHTML = `
        <div class="limits-bar-track">
          <div class="limits-bar-active" id="bar-${spec.id}" style="left: ${(limits.min / 180) * 100}%; width: ${((limits.max - limits.min) / 180) * 100}%;"></div>
        </div>
        <div class="limits-bar-ticks">
          <span>0° (-90°)</span>
          <span>90° (0°)</span>
          <span>180° (+90°)</span>
        </div>
      `

			// Controles Min e Max
			const controls = document.createElement("div")
			controls.className = "limits-controls-grid"

			// Bloco Min
			const minCol = document.createElement("div")
			minCol.className = "limits-col"
			minCol.innerHTML = `
        <div class="limits-col-header">
          <label>Mínimo:</label>
          <div class="limits-readouts">
            <span class="limits-deg-abs" id="readout-min-${spec.id}">${limits.min}°</span>
            <span class="limits-deg-rel" id="readout-min-rel-${spec.id}">${this.toRelative(limits.min)}</span>
          </div>
        </div>
        <div class="limits-input-row">
          <input type="range" class="joint-slider limit-slider-min" min="0" max="180" value="${limits.min}" id="slider-min-${spec.id}">
          <input type="number" class="limits-number-input" min="0" max="180" value="${limits.min}" id="num-min-${spec.id}">
        </div>
      `

			// Bloco Max
			const maxCol = document.createElement("div")
			maxCol.className = "limits-col"
			maxCol.innerHTML = `
        <div class="limits-col-header">
          <label>Máximo:</label>
          <div class="limits-readouts">
            <span class="limits-deg-abs" id="readout-max-${spec.id}">${limits.max}°</span>
            <span class="limits-deg-rel" id="readout-max-rel-${spec.id}">${this.toRelative(limits.max)}</span>
          </div>
        </div>
        <div class="limits-input-row">
          <input type="range" class="joint-slider limit-slider-max" min="0" max="180" value="${limits.max}" id="slider-max-${spec.id}">
          <input type="number" class="limits-number-input" min="0" max="180" value="${limits.max}" id="num-max-${spec.id}">
        </div>
      `

			controls.appendChild(minCol)
			controls.appendChild(maxCol)

			card.appendChild(header)
			card.appendChild(barContainer)
			card.appendChild(controls)
			this.container.appendChild(card)

			// Event Listeners
			const sliderMin = minCol.querySelector(`#slider-min-${spec.id}`)
			const numMin = minCol.querySelector(`#num-min-${spec.id}`)
			const sliderMax = maxCol.querySelector(`#slider-max-${spec.id}`)
			const numMax = maxCol.querySelector(`#num-max-${spec.id}`)

			const updateValues = (newMin, newMax) => {
				newMin = Math.max(0, Math.min(180, parseInt(newMin, 10) || 0))
				newMax = Math.max(0, Math.min(180, parseInt(newMax, 10) || 0))
				if (newMin > newMax) {
					if (newMin === this.editingLimits[spec.id].min) {
						newMin = newMax
					} else {
						newMax = newMin
					}
				}

				this.editingLimits[spec.id].min = newMin
				this.editingLimits[spec.id].max = newMax

				sliderMin.value = newMin
				numMin.value = newMin
				sliderMax.value = newMax
				numMax.value = newMax

				document.getElementById(`readout-min-${spec.id}`).textContent = `${newMin}°`
				document.getElementById(`readout-min-rel-${spec.id}`).textContent = this.toRelative(newMin)
				document.getElementById(`readout-max-${spec.id}`).textContent = `${newMax}°`
				document.getElementById(`readout-max-rel-${spec.id}`).textContent = this.toRelative(newMax)

				document.getElementById(`span-${spec.id}`).innerHTML = `Amplitude: <strong>${newMax - newMin}°</strong>`

				const bar = document.getElementById(`bar-${spec.id}`)
				if (bar) {
					bar.style.left = `${(newMin / 180) * 100}%`
					bar.style.width = `${((newMax - newMin) / 180) * 100}%`
				}

				if (spec.axis === "ombro") {
					this.updateShoulderInfo()
				}
			}

			sliderMin.addEventListener("input", (e) => updateValues(e.target.value, this.editingLimits[spec.id].max))
			numMin.addEventListener("input", (e) => updateValues(e.target.value, this.editingLimits[spec.id].max))
			sliderMax.addEventListener("input", (e) => updateValues(this.editingLimits[spec.id].min, e.target.value))
			numMax.addEventListener("input", (e) => updateValues(this.editingLimits[spec.id].min, e.target.value))
		})
	}

	updateShoulderInfo() {
		if (!this.shoulderInfoBox) return

		const m = this.editingLimits["ombro_master"] || { min: 35, max: 145 }
		const s = this.editingLimits["ombro_slave"] || { min: 35, max: 145 }
		const eff = this.calculateEffectiveShoulder(m.min, m.max, s.min, s.max)

		this.shoulderInfoBox.innerHTML = `
      <div class="shoulder-info-content">
        <div class="shoulder-info-header">
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-cyan); width: 16px; height: 16px; fill: none; stroke: currentColor; display: inline-block; vertical-align: middle;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          <strong>Eixo do Ombro</strong>
        </div>
        <p class="shoulder-desc">
          O ombro é acionado simultaneamente por motores Master e Slave invertido (<code>slave = 180° - master</code>).
          Para proteger a carcaça e engrenagens contra esforço contrário, o curso efetivo útil resultante é a interseção dos dois limites:
        </p>
        <div class="shoulder-result-badge">
          Curso seguro coordenado: <strong>${eff.min}° a ${eff.max}°</strong>
          <span class="shoulder-rel-badge">(${this.toRelative(eff.min)} a ${this.toRelative(eff.max)}). Amplitude Útil: ${eff.max - eff.min}°</span>
        </div>
      </div>
    `
	}

	async saveLimits() {
		this.currentLimits = JSON.parse(JSON.stringify(this.editingLimits))
		localStorage.setItem("arm_custom_limits", JSON.stringify(this.currentLimits))

		try {
			const res = await fetch("/api/limits", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ limits: this.currentLimits }),
			})
			const data = await res.json()
			if (data && data.limits) {
				for (const [k, v] of Object.entries(data.limits)) {
					if (this.currentLimits[k]) {
						this.currentLimits[k].min = v.min
						this.currentLimits[k].max = v.max
					}
				}
			}
			this.applyLimitsToUI(this.currentLimits)
			this.closeModal()
			if (window.showToast) window.showToast("Limites de movimento salvos e sincronizados com sucesso!")
		} catch (e) {
			console.error("Erro ao salvar limites no servidor:", e)
			this.applyLimitsToUI(this.currentLimits)
			this.closeModal()
			if (window.showToast) window.showToast("Limites salvos localmente no navegador.")
		}
	}

	resetFactoryDefaults() {
		this.motorSpecs.forEach((spec) => {
			this.editingLimits[spec.id] = {
				min: spec.defaultMin,
				max: spec.defaultMax,
			}
		})
		this.renderMotorsList()
		this.updateShoulderInfo()
		if (window.showToast) window.showToast("Valores redefinidos para os limites recomendados de fábrica.")
	}

	getJointLimits() {
		// Retorna limites formatados por junta física (para sliders e IK)
		const m = this.currentLimits["ombro_master"] || { min: 35, max: 145 }
		const s = this.currentLimits["ombro_slave"] || { min: 35, max: 145 }
		const effShoulder = this.calculateEffectiveShoulder(m.min, m.max, s.min, s.max)

		return {
			base_rotacao: this.currentLimits["base_rotacao"] || { min: 15, max: 165 },
			ombro: { min: effShoulder.min, max: effShoulder.max },
			ombro_master: m,
			ombro_slave: s,
			cotovelo: this.currentLimits["cotovelo"] || { min: 25, max: 105 },
			punho: this.currentLimits["punho"] || { min: 35, max: 145 },
			garra_rotacao: this.currentLimits["garra_rotacao"] || { min: 0, max: 180 },
			garra_abertura: this.currentLimits["garra_abertura"] || { min: 45, max: 135 },
		}
	}

	applyLimitsToUI(limits) {
		const jointLimits = this.getJointLimits()

		// 1. Atualiza Sliders Manuais no HUD Direito
		const joints = ["base_rotacao", "ombro", "cotovelo", "punho", "garra_rotacao", "garra_abertura"]
		joints.forEach((joint) => {
			const lim = jointLimits[joint]
			if (!lim) return

			const slider = document.getElementById(`manual-slider-${joint}`)
			if (slider) {
				slider.min = lim.min
				slider.max = lim.max
				// Clamp valor se exceder novo limite
				let curVal = parseInt(slider.value, 10)
				if (curVal < lim.min) curVal = lim.min
				if (curVal > lim.max) curVal = lim.max
				slider.value = curVal
			}

			// Atualiza marcas de escala min e max exibidas
			const group = slider?.closest(".joint-control-group")
			if (group) {
				const limitsSpans = group.querySelectorAll(".scale-limit")
				if (limitsSpans.length >= 2) {
					limitsSpans[0].textContent = `${lim.min}°`
					limitsSpans[1].textContent = `${lim.max}°`
				}
			}
		})

		// 2. Atualiza limites dinâmicos no HomeManager se existir
		if (this.homeManager && typeof this.homeManager.renderSliders === "function" && this.homeManager.isModalOpen) {
			this.homeManager.renderSliders()
		}

		// 3. Atualiza limites na Cinemática Inversa do visualizador 3D
		if (this.arm && typeof this.arm.setLimits === "function") {
			this.arm.setLimits(jointLimits)
		}
	}
}

window.LimitsManager = LimitsManager
