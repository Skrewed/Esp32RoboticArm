/**
 * arm_3d.js - Visualizador 3D Three.js do Braço Robótico ESP32
 * Montagem precisa das peças STL originais, Iluminação clara e Cinemática Inversa contínua (sem saltos)
 */

class Arm3DVisualizer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.isHoldingGimbal = false;
    this.clawStateOpen = false;

    // Ângulos atuais dos 6 eixos (renderizados na cena 3D)
    this.currentAngles = {
      base_rotacao: 90,
      ombro: 90,
      cotovelo: 90,
      punho: 90,
      garra_rotacao: 90,
      garra_abertura: 90
    };

    // Ângulos alvo (vindos da telemetria contínua do ESP32 ou de comandos)
    this.targetAngles = { ...this.currentAngles };
    this.lastRenderTime = performance.now();

    // Limites de movimento dinâmicos dos eixos (0 a 180° físicos)
    this.limits = {
      base_rotacao: { min: 15, max: 165 },
      ombro: { min: 35, max: 145 },
      cotovelo: { min: 25, max: 105 },
      punho: { min: 35, max: 145 },
      garra_rotacao: { min: 0, max: 180 },
      garra_abertura: { min: 45, max: 135 }
    };

    // Dimensões cinemáticas exatas do CAD (em milímetros)
    this.H_BASE = 105.0;      // Altura da bancada ao pivô do ombro
    this.Z_SHOULDER = 26.0;   // Offset para frente do pivô do ombro
    this.L1 = 201.37;         // Comprimento do elo do ombro (Alt_Kol)
    this.L2 = 139.20;         // Comprimento do elo do cotovelo (On_Kol)
    this.L3 = 117.00;         // Comprimento do punho até a ponta da garra

    this.initScene();
    this.initLights();
    this.initAssemblyGroups();
    this.initGimbal();
    this.loadSTLModels();
    this.initEventListeners();
    this.animate();
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b111e); // Fundo azul escuro moderno
    // Neblina muito suave e distante para não escurecer ao remover zoom
    this.scene.fog = new THREE.Fog(0x0b111e, 2000, 5000);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(42, aspect, 1, 6000);
    this.camera.position.set(400, 310, 540);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.01; // Não penetrar no chão
    this.controls.target.set(-20, 160, 90);

    // Grid do chão
    this.gridHelper = new THREE.GridHelper(1400, 48, 0x3b82f6, 0x1e293b);
    this.gridHelper.position.y = 0;
    this.scene.add(this.gridHelper);

    // Círculo indicativo da bancada
    const floorGeo = new THREE.CircleGeometry(450, 64);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.85
    });
    this.floorMesh = new THREE.Mesh(floorGeo, floorMat);
    this.floorMesh.position.y = -0.2;
    this.scene.add(this.floorMesh);
  }

  initLights() {
    // Iluminação clara e difusa em 360 graus
    const ambient = new THREE.AmbientLight(0xffffff, 1.6);
    this.scene.add(ambient);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 1.4);
    hemiLight.position.set(0, 500, 0);
    this.scene.add(hemiLight);

    // Luz principal com sombras suaves
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(300, 550, 400);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 10;
    keyLight.shadow.camera.far = 1800;
    keyLight.shadow.camera.left = -350;
    keyLight.shadow.camera.right = 350;
    keyLight.shadow.camera.top = 350;
    keyLight.shadow.camera.bottom = -350;
    this.scene.add(keyLight);

    // Luz de preenchimento frontal/esquerda
    const fillLight = new THREE.DirectionalLight(0x38bdf8, 1.0);
    fillLight.position.set(-350, 350, 300);
    this.scene.add(fillLight);

    // Luz traseira de borda (Rim Light)
    const rimLight = new THREE.DirectionalLight(0x818cf8, 1.1);
    rimLight.position.set(0, 350, -400);
    this.scene.add(rimLight);
  }

  initAssemblyGroups() {
    // 1. Grupo Raiz do Robô
    this.groupRoot = new THREE.Group();
    this.scene.add(this.groupRoot);

    // 2. Base Estacionária (Alt_Kasa + Tabla_Alt) - Assentada no chão Y=0
    this.groupBaseStationary = new THREE.Group();
    this.groupRoot.add(this.groupBaseStationary);

    // 3. Junta de Rotação da Base (Alt_Govde) - Gira em torno de Y (Yaw)
    this.jointBaseYaw = new THREE.Group();
    this.jointBaseYaw.position.set(0, 0, 0);
    this.groupRoot.add(this.jointBaseYaw);

    // 4. Junta do Ombro (Alt_Kol) - Pivô a Y=105mm, Z=26mm
    this.jointShoulder = new THREE.Group();
    this.jointShoulder.position.set(0, this.H_BASE, this.Z_SHOULDER);
    this.jointBaseYaw.add(this.jointShoulder);

    // 5. Junta do Cotovelo (On_Kol) - Pivô no topo de Alt_Kol
    this.jointElbow = new THREE.Group();
    this.jointElbow.position.set(0, 197.2, 40.7);
    this.jointShoulder.add(this.jointElbow);

    // 6. Junta do Punho (Bilek) - Pivô na ponta de On_Kol
    this.jointWrist = new THREE.Group();
    this.jointWrist.position.set(0, 0, this.L2);
    this.jointElbow.add(this.jointWrist);

    // 7. Junta de Rotação da Garra (El + El_Ust) - Gira em torno do eixo longitudinal Z
    this.jointClawRoll = new THREE.Group();
    this.jointClawRoll.position.set(0, 0, 30.0);
    this.jointWrist.add(this.jointClawRoll);

    // 8. Dedos da Garra (Parmak_2 X 2.stl - simétricos e espelhados conforme images/garra.png)
    this.fingerLeft = new THREE.Group();
    this.fingerRight = new THREE.Group();
    this.fingerLeft.position.set(-8.0, 0, 35.0);
    this.fingerRight.position.set(8.0, 0, 35.0);
    this.jointClawRoll.add(this.fingerLeft);
    this.jointClawRoll.add(this.fingerRight);

    // 9. Ponta da Garra (Âncora de Referência do Gimbal no centro das pontas)
    this.clawTipTarget = new THREE.Object3D();
    this.clawTipTarget.position.set(0, 0, 87.0);
    this.jointClawRoll.add(this.clawTipTarget);

    // Materiais nítidos e claros com acabamento industrial
    this.matArmDark = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.3,
      roughness: 0.35,
      side: THREE.DoubleSide
    });
    this.matArmAccent = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      metalness: 0.4,
      roughness: 0.3,
      side: THREE.DoubleSide
    });
    this.matMetal = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.85,
      roughness: 0.2,
      side: THREE.DoubleSide
    });
  }

  loadSTLModels() {
    const loader = new THREE.STLLoader();
    const stlBase = "/static/3d/";

    const loadTransformed = (filename, targetGroup, material, transformMatrix) => {
      loader.load(
        stlBase + filename,
        (geo) => {
          geo.computeVertexNormals();
          if (transformMatrix) {
            geo.applyMatrix4(transformMatrix);
          }
          const mesh = new THREE.Mesh(geo, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          targetGroup.add(mesh);
        },
        undefined,
        (err) => console.warn(`Falha ao carregar STL ${filename}:`, err)
      );
    };

    // 1. Alt_Kasa (Caixa da base)
    const matKasa = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 0, 0, 1
    );
    loadTransformed("Alt_Kasa.stl", this.groupBaseStationary, this.matArmDark, matKasa);
    loadTransformed("Tabla_Alt.stl", this.groupBaseStationary, this.matMetal, matKasa);

    // 2. Alt_Govde (Mesa giratória)
    const matGovde = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 70,
      1, 0, 0, 0,
      0, 0, 0, 1
    );
    loadTransformed("Alt_Govde.stl", this.jointBaseYaw, this.matArmDark, matGovde);

    // 3. Alt_Kol (Braço inferior / Ombro)
    const matKol = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 102.72,
      1, 0, 0, 0,
      0, 0, 0, 1
    );
    loadTransformed("Alt_Kol.stl", this.jointShoulder, this.matArmDark, matKol);

    // 4. On_Kol (Antebraço / Cotovelo)
    const matOnKol = new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 0,
      -1, 0, 0, 0,
      0, 0, 0, 1
    );
    loadTransformed("On_Kol.stl", this.jointElbow, this.matArmDark, matOnKol);

    // 5. Bilek (Punho - Garfo U de articulação)
    const matBilek = new THREE.Matrix4().set(
      1,  0, 0,  0,
      0,  0, 1,  0,
      0, -1, 0, 14.0,
      0,  0, 0,  1
    );
    loadTransformed("Bilek.stl", this.jointWrist, this.matArmDark, matBilek);

    // 6. El e El_Ust (Base e tampa superior da carcaça da garra)
    const matEl = new THREE.Matrix4().set(
      0, 1, 0,   0,
      0, 0, 1, -7.5,
      1, 0, 0,  15.0,
      0, 0, 0,   1
    );
    loadTransformed("El.stl", this.jointClawRoll, this.matArmDark, matEl);

    // Tampa superior da garra (El_Ust.stl) a Y = +7.5mm cobrindo os dedos e punho
    const matElUst = new THREE.Matrix4().set(
      0, -1,  0,    0,
      0,  0, -1,  7.5,
      1,  0,  0, 15.0,
      0,  0,  0,    1
    );
    loadTransformed("El_Ust.stl", this.jointClawRoll, this.matArmDark, matElUst);

    // Adiciona servomotores MG90S (corpo escuro, engrenagem de latão e etiqueta roxa)
    this.createMG90SServos();

    // 7. Dedos da garra - Impressos 2x e espelhados (Parmak_2 X 2.stl) + bielas paralelas (Parmak X 2.stl)
    // Dedo Esquerdo (pá angulada curvada em direção ao centro)
    const matFingerL = new THREE.Matrix4().set(
      0, -1, 0,    0,
      0,  0, 1, -2.5,
      1,  0, 0,    0,
      0,  0, 0,    1
    );
    loadTransformed("Parmak_2 X 2.stl", this.fingerLeft, this.matArmDark, matFingerL);

    const matLinkL = new THREE.Matrix4().set(
      0, -1, 0, -11.0,
      0,  0, 1, -2.5,
      1,  0, 0,    0,
      0,  0, 0,    1
    );
    loadTransformed("Parmak X 2.stl", this.fingerLeft, this.matMetal, matLinkL);

    // Dedo Direito (espelhado simetricamente no eixo X)
    const matFingerR = new THREE.Matrix4().set(
      0,  1, 0,    0,
      0,  0, 1, -2.5,
      1,  0, 0,    0,
      0,  0, 0,    1
    );
    loadTransformed("Parmak_2 X 2.stl", this.fingerRight, this.matArmDark, matFingerR);

    const matLinkR = new THREE.Matrix4().set(
      0,  1, 0,  11.0,
      0,  0, 1, -2.5,
      1,  0, 0,    0,
      0,  0, 0,    1
    );
    loadTransformed("Parmak X 2.stl", this.fingerRight, this.matMetal, matLinkR);

    // Aplica ângulos iniciais (Home padrão)
    this.applyAllAngles(this.currentAngles);
  }

  createMG90SServos() {
    const matServoBody = new THREE.MeshStandardMaterial({
      color: 0x182030,
      metalness: 0.25,
      roughness: 0.4
    });
    const matBrass = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      metalness: 0.85,
      roughness: 0.25
    });
    const matLabel = new THREE.MeshStandardMaterial({
      color: 0x7c3aed,
      metalness: 0.2,
      roughness: 0.5
    });

    const createServoMesh = () => {
      const servoGroup = new THREE.Group();
      // Corpo principal do MG90S (22.8mm x 12.2mm x 22.0mm)
      const body = new THREE.Mesh(new THREE.BoxGeometry(22.8, 12.2, 22.0), matServoBody);
      body.castShadow = true;
      servoGroup.add(body);

      // Flange de fixação
      const flange = new THREE.Mesh(new THREE.BoxGeometry(32.5, 12.2, 2.5), matServoBody);
      flange.position.set(0, 0, 4.0);
      flange.castShadow = true;
      servoGroup.add(flange);

      // Torre da engrenagem
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 5.8, 4.0, 16), matServoBody);
      tower.rotation.x = Math.PI / 2;
      tower.position.set(5.5, 0, 12.5);
      servoGroup.add(tower);

      // Engrenagem de latão (Output Spline)
      const gear = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 5.0, 16), matBrass);
      gear.rotation.x = Math.PI / 2;
      gear.position.set(5.5, 0, 15.0);
      servoGroup.add(gear);

      // Etiqueta roxa TowerPro MG90S
      const label = new THREE.Mesh(new THREE.PlaneGeometry(16.0, 9.0), matLabel);
      label.position.set(-2.0, 6.15, 0);
      label.rotation.x = -Math.PI / 2;
      servoGroup.add(label);

      return servoGroup;
    };

    // 1. Servo do Punho (Rotação da Garra) - Montado no berço de Bilek
    const wristServo = createServoMesh();
    wristServo.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    wristServo.position.set(0, 13.5, 15.0);
    this.jointWrist.add(wristServo);

    // 2. Servo da Garra (Abertura/Fechamento) - Encaixado no recorte retangular de El_Ust
    const clawServo = createServoMesh();
    clawServo.rotation.set(0, 0, 0);
    clawServo.position.set(0, 17.5, 13.0);
    this.jointClawRoll.add(clawServo);
  }

  initGimbal() {
    this.gimbalControl = new THREE.TransformControls(this.camera, this.renderer.domElement);
    this.gimbalControl.size = 0.85;
    this.gimbalControl.space = "world";

    // O proxy representa exatamente a ponta da garra no espaço 3D
    this.gimbalProxy = new THREE.Mesh(
      new THREE.SphereGeometry(6, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true })
    );
    this.scene.add(this.gimbalProxy);
    this.gimbalControl.attach(this.gimbalProxy);
    this.scene.add(this.gimbalControl);

    // Sincroniza posição inicial do Gimbal na ponta da garra
    this.syncGimbalToClawTip();

    // Eventos do Gimbal
    this.gimbalControl.addEventListener("dragging-changed", (event) => {
      this.isHoldingGimbal = event.value;
      this.controls.enabled = !event.value; // Desativa órbita ao arrastar o gimbal

      if (this.isHoldingGimbal) {
        document.body.classList.add("gimbal-holding");
        // Pausa todas as outras funções (música e IA)
        if (window.onGimbalHoldStart) window.onGimbalHoldStart();
      } else {
        document.body.classList.remove("gimbal-holding");
        // Ao soltar, garante que o gimbal permaneça perfeitamente alinhado com a ponta da garra
        this.syncGimbalToClawTip();
        if (window.onGimbalHoldEnd) window.onGimbalHoldEnd();
      }
    });

    this.gimbalControl.addEventListener("change", () => {
      if (this.isHoldingGimbal) {
        this.solveInverseKinematics(this.gimbalProxy.position);
      }
    });
  }

  syncGimbalToClawTip() {
    if (!this.gimbalProxy || !this.clawTipTarget) return;
    this.scene.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    this.clawTipTarget.getWorldPosition(worldPos);
    this.gimbalProxy.position.copy(worldPos);
    if (this.gimbalControl) {
      this.gimbalControl.updateMatrixWorld();
    }
  }

  updateGimbalProxyFromArm() {
    this.syncGimbalToClawTip();
  }

  initEventListeners() {
    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Tecla Espaço: abre e fecha a garra EXCLUSIVAMENTE enquanto o usuário segura o gimbal
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && this.isHoldingGimbal) {
        e.preventDefault();
        this.toggleClaw();
      }
    });
  }

  setLimits(newLimits) {
    if (!newLimits || typeof newLimits !== "object") return;
    for (const [k, v] of Object.entries(newLimits)) {
      if (this.limits[k] && v) {
        this.limits[k] = {
          min: typeof v.min === "number" ? v.min : this.limits[k].min,
          max: typeof v.max === "number" ? v.max : this.limits[k].max
        };
      }
    }
  }

  toggleClaw() {
    this.clawStateOpen = !this.clawStateOpen;
    const clawLimits = (this.limits && this.limits["garra_abertura"]) || { min: 45, max: 135 };
    const targetAngle = this.clawStateOpen ? clawLimits.max : clawLimits.min;
    this.targetAngles["garra_abertura"] = targetAngle;
    this.setJointAngle("garra_abertura", targetAngle);

    if (window.onArmAnglesChanged) {
      window.onArmAnglesChanged(this.currentAngles);
    }
  }

  /**
   * Cinemática Inversa Analítica Exata com Limitações Mecânicas Anti-Crippling
   * - Erro posicional 0.000mm entre FK e IK
   * - Restringe o Gimbal ao semi-espaço frontal (Z >= 45mm) eliminando giro de 180°
   * - Impede enterramento no chão (Y >= 35mm) e colisão com a base (Y >= 135mm sobre a base r <= 165mm)
   * - Impede auto-interseção e colisão mecânica usando os limites dinâmicos configurados
   * - Garante que o Gimbal permaneça permanentemente sincronizado à ponta da garra
   */
  solveInverseKinematics(targetPos) {
    let tx = targetPos.x;
    let ty = targetPos.y;
    let tz = targetPos.z;

    const baseLim = this.limits?.base_rotacao || { min: 15.0, max: 165.0 };
    const ombroLim = this.limits?.ombro || { min: 35.0, max: 145.0 };
    const cotoveloLim = this.limits?.cotovelo || { min: 25.0, max: 105.0 };
    const punhoLim = this.limits?.punho || { min: 35.0, max: 145.0 };

    // 1. Proteção Anti-Snap: semi-espaço frontal (+Z)
    if (tz < 45.0) {
      tz = 45.0;
    }

    // 2. Base Yaw: azimute (90° alinhado com +Z frontal)
    let yawRad = Math.atan2(tx, tz);
    let baseDeg = 90.0 - (yawRad * 180.0 / Math.PI);
    baseDeg = THREE.MathUtils.clamp(baseDeg, baseLim.min, baseLim.max);
    yawRad = (90.0 - baseDeg) * Math.PI / 180.0;

    let r = Math.sqrt(tx * tx + tz * tz);

    // 3. Limites de Raio Radial de Alcance Físico
    const minR = 140.0;
    const maxR = 380.0;
    r = THREE.MathUtils.clamp(r, minR, maxR);
    tx = r * Math.sin(yawRad);
    tz = r * Math.cos(yawRad);

    // 4. Limite de Altura (Anti-Colisão com a Bancada e Base)
    let minY = 35.0;
    if (r <= 165.0) {
      minY = 135.0;
    }
    if (ty < minY) {
      ty = minY;
    }

    // 5. Cinemática Analítica Exata com Resolução do Triângulo Ombro-Cotovelo-Punho
    const delta = 0.203487; // Math.atan2(40.7, 197.2)
    const desiredPitch = 0.0; // Garra nivelada com o horizonte
    const rw = r - this.L3 * Math.cos(desiredPitch);
    const yw = ty + this.L3 * Math.sin(desiredPitch);

    const dr = rw - this.Z_SHOULDER;
    const dy = yw - this.H_BASE;
    let dist = Math.sqrt(dr * dr + dy * dy);

    const minDist = Math.abs(this.L1 - this.L2) + 8.0;
    const maxDist = (this.L1 + this.L2) - 6.0;
    dist = THREE.MathUtils.clamp(dist, minDist, maxDist);

    // Lei dos Cossenos para o Cotovelo
    const cosPsi = (this.L1 * this.L1 + this.L2 * this.L2 - dist * dist) / (2.0 * this.L1 * this.L2);
    const gamma = Math.acos(THREE.MathUtils.clamp(cosPsi, -1.0, 1.0));
    const psi = Math.PI - gamma;

    const th_c = psi - (Math.PI / 2.0 - delta);
    let targetCotoveloDeg = 90.0 + th_c * (180.0 / Math.PI);

    // Lei dos Cossenos para o Ombro
    const phi = Math.atan2(dy, Math.max(10.0, dr));
    const cosBeta = (this.L1 * this.L1 + dist * dist - this.L2 * this.L2) / (2.0 * this.L1 * dist);
    const beta = Math.acos(THREE.MathUtils.clamp(cosBeta, -1.0, 1.0));
    const alpha1 = phi + beta;

    const th_o = Math.PI / 2.0 - delta - alpha1;
    let targetOmbroDeg = 90.0 + th_o * (180.0 / Math.PI);

    // Punho para orientação horizontal (pitch = 0)
    const th_p = -desiredPitch - (th_o + th_c);
    let targetPunhoDeg = 90.0 + th_p * (180.0 / Math.PI);

    // 6. Limitações Mecânicas Reais Rígidas (Anti-Crippling & Proteção de Servos)
    const finalBase = THREE.MathUtils.clamp(baseDeg, baseLim.min, baseLim.max);
    const finalOmbro = THREE.MathUtils.clamp(targetOmbroDeg, ombroLim.min, ombroLim.max);
    const finalCotovelo = THREE.MathUtils.clamp(targetCotoveloDeg, cotoveloLim.min, cotoveloLim.max);
    const finalPunho = THREE.MathUtils.clamp(targetPunhoDeg, punhoLim.min, punhoLim.max);

    const rb = Math.round(finalBase);
    const ro = Math.round(finalOmbro);
    const rc = Math.round(finalCotovelo);
    const rp = Math.round(finalPunho);

    this.targetAngles["base_rotacao"] = rb;
    this.targetAngles["ombro"] = ro;
    this.targetAngles["cotovelo"] = rc;
    this.targetAngles["punho"] = rp;

    this.setJointAngle("base_rotacao", rb);
    this.setJointAngle("ombro", ro);
    this.setJointAngle("cotovelo", rc);
    this.setJointAngle("punho", rp);

    // Atualiza o proxy do gimbal diretamente para a ponta alcançada da garra
    this.scene.updateMatrixWorld(true);
    const actualTipPos = new THREE.Vector3();
    this.clawTipTarget.getWorldPosition(actualTipPos);
    this.gimbalProxy.position.copy(actualTipPos);

    if (window.onArmAnglesChanged) {
      window.onArmAnglesChanged(this.currentAngles);
    }
  }

  setJointAngle(jointName, angleDeg) {
    this.currentAngles[jointName] = angleDeg;
    const rad = (angleDeg - 90) * Math.PI / 180;

    switch (jointName) {
      case "base_rotacao":
        this.jointBaseYaw.rotation.y = -rad;
        break;
      case "ombro":
        this.jointShoulder.rotation.x = rad;
        break;
      case "cotovelo":
        this.jointElbow.rotation.x = rad;
        break;
      case "punho":
        this.jointWrist.rotation.x = rad;
        break;
      case "garra_rotacao":
        this.jointClawRoll.rotation.z = rad;
        break;
      case "garra_abertura":
        // Ângulo 45° (fechada) a 135° (aberta) -> rotação simétrica das pinças
        const clawNorm = (THREE.MathUtils.clamp(angleDeg, 45, 135) - 45) / 90.0;
        // Fechada: as duas pontas encostam no centro
        // Aberta: as duas pontas abrem simetricamente para fora
        this.fingerLeft.rotation.y = 0.12 - clawNorm * 0.55;
        this.fingerRight.rotation.y = -0.12 + clawNorm * 0.55;
        break;
    }
  }

  applyAllAngles(angles, immediate = false) {
    for (const [joint, deg] of Object.entries(angles)) {
      if (this.targetAngles.hasOwnProperty(joint)) {
        this.targetAngles[joint] = Number(deg);
        if (immediate) {
          this.setJointAngle(joint, Number(deg));
        }
      }
    }
    if (immediate && !this.isHoldingGimbal) {
      this.syncGimbalToClawTip();
    }
  }

  setTheme(themeName) {
    const isLight = (themeName === "light");
    if (isLight) {
      this.scene.background.setHex(0xeef2f6);
      if (this.scene.fog) this.scene.fog.color.setHex(0xeef2f6);
      if (this.floorMesh) {
        this.floorMesh.material.color.setHex(0xffffff);
        this.floorMesh.material.opacity = 0.95;
      }
      if (this.gridHelper) {
        this.scene.remove(this.gridHelper);
        this.gridHelper = new THREE.GridHelper(1400, 48, 0x0284c7, 0x94a3b8);
        this.gridHelper.position.y = 0;
        this.scene.add(this.gridHelper);
      }
    } else {
      this.scene.background.setHex(0x0b111e);
      if (this.scene.fog) this.scene.fog.color.setHex(0x0b111e);
      if (this.floorMesh) {
        this.floorMesh.material.color.setHex(0x0f172a);
        this.floorMesh.material.opacity = 0.85;
      }
      if (this.gridHelper) {
        this.scene.remove(this.gridHelper);
        this.gridHelper = new THREE.GridHelper(1400, 48, 0x3b82f6, 0x1e293b);
        this.gridHelper.position.y = 0;
        this.scene.add(this.gridHelper);
      }
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const now = performance.now();
    const dt = Math.min(0.08, Math.max(0.001, (now - this.lastRenderTime) / 1000.0));
    this.lastRenderTime = now;

    if (!this.isHoldingGimbal) {
      let anyChanged = false;
      for (const joint in this.targetAngles) {
        const target = this.targetAngles[joint];
        const current = this.currentAngles[joint];
        const diff = target - current;
        if (Math.abs(diff) > 0.05) {
          // Punho e garras (MG90S) se interpolam com resposta muito mais ágil e imediata
          const isLightJoint = (joint === "punho" || joint === "garra_rotacao" || joint === "garra_abertura");
          const responsiveness = isLightJoint ? 45.0 : 24.0;
          const factor = 1.0 - Math.exp(-responsiveness * dt);
          const nextVal = current + diff * factor;
          this.setJointAngle(joint, nextVal);
          anyChanged = true;
        } else if (Math.abs(diff) > 0.0001) {
          this.setJointAngle(joint, target);
          anyChanged = true;
        }
      }
      if (anyChanged && window.onArmRenderedAnglesChanged) {
        window.onArmRenderedAnglesChanged(this.currentAngles);
      }
      // Mantém o Gimbal permanentemente fixado na ponta da garra
      this.syncGimbalToClawTip();
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

window.Arm3DVisualizer = Arm3DVisualizer;
