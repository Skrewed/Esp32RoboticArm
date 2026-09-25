#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include <driver/i2s.h>
#include <Preferences.h>

/*
  ============================================================
  BRAÇO ROBÓTICO ESP32 - FIRMWARE REFATORADO V8.0
  7 SERVO MOTORES + CONVERSOR SN74HCT245N
  ÁUDIO I2S: 2x INMP441 (ENTRADA) + MAX98357A (SAÍDA)
  COMUNICAÇÃO HTTP REST + STREAMING DE ÁUDIO & MOVIMENTO
  ============================================================
  
  Mapeamento de Pinos Padrão (Conforme Descritivo Técnico):
  Servos MG90S:
    #1 D13 -> Garra Abertura (HCT245 A1>B1, pinos 2 e 18)
    #2 D14 -> Garra Rotação  (HCT245 A2>B2, pinos 3 e 17)
    #3 D18 -> Ombro Slave    (HCT245 A6>B6, pinos 7 e 13)
    #4 D19 -> Punho          (HCT245 A7>B7, pinos 8 e 12)

  Servos MG996R:
    #1 D27 -> Ombro Master   (HCT245 A3>B3, pinos 4 e 16)
    #2 D26 -> Cotovelo       (HCT245 A4>B4, pinos 5 e 15)
    #3 D25 -> Base Rotação   (HCT245 A5>B5, pinos 6 e 14)

  Microfones INMP441 (I2S Canal 0 - Entrada):
    WS  -> GPIO 33
    SCK -> GPIO 32
    SD  -> GPIO 35 (Input Only)

  Alto-falante MAX98357A (I2S Canal 1 - Saída):
    LRC  -> GPIO 21
    BCLK -> GPIO 22
    DIN  -> GPIO 23
  ============================================================
*/

// ==============================================================================
//  >>> CONFIGURAÇÕES DE REDE & IP DO ESP32 (ALTERE AQUI ANTES DE FAZER O FLASH) <<<
// ==============================================================================

// 1. CONEXÃO COM SEU ROTEADOR WI-FI (MODO STATION)
// Coloque o nome da sua rede (2.4 GHz) e a senha para o ESP32 conectar no seu roteador:
const char* STA_SSID     = "SUA_REDE_WIFI";       // <-- NOME DO SEU WI-FI (2.4GHz)
const char* STA_PASSWORD = "SUA_SENHA_WIFI";     // <-- SENHA DO SEU WI-FI

// Defina 'true' para fixar o IP do ESP32 na sua rede local, ou 'false' para obter IP dinâmico via DHCP:
const bool  USAR_IP_ESTATICO_STA = true;

// IP Estático desejado para o ESP32 na sua rede local:
IPAddress   ESP32_IP_FIXO(192, 168, 1, 150);      // <--- DEFINE O IP DO ESP32 AQUI (ex: 192.168.1.150)
IPAddress   ESP32_GATEWAY(192, 168, 1, 1);        // <--- IP DO SEU ROTEADOR (GATEWAY)
IPAddress   ESP32_SUBNET(255, 255, 255, 0);       // <--- MÁSCARA DE REDE (Padrão: 255.255.255.0)
IPAddress   ESP32_DNS(8, 8, 8, 8);                // <--- SERVIDOR DNS

// 2. REDE WI-FI PRÓPRIA CRIADA PELO ESP32 (MODO ACCESS POINT - AP)
// Caso o roteador não esteja disponível, o ESP32 gera sua própria rede direta:
const char* AP_SSID      = "BRACO_ESP32_AP";
const char* AP_PASSWORD  = "12345678";
IPAddress   AP_IP(192, 168, 4, 1);                // <--- IP padrão do ESP32 no modo Ponto de Acesso
IPAddress   AP_GATEWAY(192, 168, 4, 1);
IPAddress   AP_SUBNET(255, 255, 255, 0);

WebServer server(80);
// ==============================================================================

// ============================================================
// CONFIGURAÇÃO GERAL E SERVOS
// ============================================================

const int FREQUENCIA_SERVO_HZ = 50;
const int VELOCIDADE_PADRAO = 60;

bool sistemaHabilitado = true; // Habilitado para resposta imediata
const bool OMBRO_INVERTIDO = true;
int offsetOmbroSlave = 0;

enum MotorId {
  GARRA_ABERTURA = 0,
  GARRA_ROTACAO,
  PUNHO,
  COTOVELO,
  OMBRO_MASTER,
  OMBRO_SLAVE,
  BASE_ROTACAO,
  TOTAL_MOTORES
};

struct Motor {
  Servo driver;
  const char* nome;
  uint8_t pino;
  int anguloMinimo;
  int anguloMaximo;
  int pulsoMinimoUs;
  int pulsoMaximoUs;
  bool anexado;
  int anguloAtual;
  int anguloAlvo;
  int velocidade;
  unsigned long ultimoPassoMs;
};

// Posição Home Personalizável
struct HomeConfig {
  int base_rotacao;
  int ombro;
  int cotovelo;
  int punho;
  int garra_rotacao;
  int garra_abertura;
} posHome = { 90, 90, 90, 90, 90, 90 };

Motor motores[TOTAL_MOTORES] = {
  { Servo(), "garra_abertura", 13, 45, 135, 1000, 2000, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "garra_rotacao",  14, 0,  180, 1000, 2000, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "punho",          19, 35, 145, 1000, 2000, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "cotovelo",       26, 25, 105,  500, 2500, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "ombro_master",   27, 35, 145,  500, 2500, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "ombro_slave",    18, 35, 145,  500, 2500, false, 90, 90, VELOCIDADE_PADRAO, 0 },
  { Servo(), "base_rotacao",   25, 15, 165,  500, 2500, false, 90, 90, VELOCIDADE_PADRAO, 0 }
};

// Declarações prévias
int calcularAnguloOmbroSlave(int anguloMaster);

// ============================================================
// PERSISTÊNCIA NÃO-VOLÁTIL (NVS FLASH) DO ESP32
// ============================================================
Preferences prefs;

void carregarConfiguracoesNVS() {
  prefs.begin("braco_cfg", false);
  posHome.base_rotacao   = prefs.getInt("home_b",  posHome.base_rotacao);
  posHome.ombro          = prefs.getInt("home_o",  posHome.ombro);
  posHome.cotovelo       = prefs.getInt("home_c",  posHome.cotovelo);
  posHome.punho          = prefs.getInt("home_p",  posHome.punho);
  posHome.garra_rotacao  = prefs.getInt("home_gr", posHome.garra_rotacao);
  posHome.garra_abertura = prefs.getInt("home_ga", posHome.garra_abertura);

  for (int i = 0; i < TOTAL_MOTORES; i++) {
    char kMin[16], kMax[16], kPin[16];
    snprintf(kMin, sizeof(kMin), "lim_min_%d", i);
    snprintf(kMax, sizeof(kMax), "lim_max_%d", i);
    snprintf(kPin, sizeof(kPin), "pin_%d", i);
    motores[i].anguloMinimo = prefs.getInt(kMin, motores[i].anguloMinimo);
    motores[i].anguloMaximo = prefs.getInt(kMax, motores[i].anguloMaximo);
    int p = prefs.getInt(kPin, -1);
    if (p >= 0 && p <= 39) {
      motores[i].pino = (uint8_t)p;
    }
  }
  prefs.end();

  // Sincroniza posições iniciais dos motores com o Home carregado da NVS
  motores[BASE_ROTACAO].anguloAtual   = posHome.base_rotacao;
  motores[BASE_ROTACAO].anguloAlvo    = posHome.base_rotacao;
  motores[OMBRO_MASTER].anguloAtual   = posHome.ombro;
  motores[OMBRO_MASTER].anguloAlvo    = posHome.ombro;
  motores[OMBRO_SLAVE].anguloAtual    = calcularAnguloOmbroSlave(posHome.ombro);
  motores[OMBRO_SLAVE].anguloAlvo     = motores[OMBRO_SLAVE].anguloAtual;
  motores[COTOVELO].anguloAtual       = posHome.cotovelo;
  motores[COTOVELO].anguloAlvo        = posHome.cotovelo;
  motores[PUNHO].anguloAtual          = posHome.punho;
  motores[PUNHO].anguloAlvo           = posHome.punho;
  motores[GARRA_ROTACAO].anguloAtual  = posHome.garra_rotacao;
  motores[GARRA_ROTACAO].anguloAlvo   = posHome.garra_rotacao;
  motores[GARRA_ABERTURA].anguloAtual = posHome.garra_abertura;
  motores[GARRA_ABERTURA].anguloAlvo  = posHome.garra_abertura;

  Serial.printf("[NVS] Home Carregada: B=%d, O=%d, C=%d, P=%d, GR=%d, GA=%d\n",
    posHome.base_rotacao, posHome.ombro, posHome.cotovelo,
    posHome.punho, posHome.garra_rotacao, posHome.garra_abertura);
}

void salvarHomeNVS() {
  prefs.begin("braco_cfg", false);
  prefs.putInt("home_b",  posHome.base_rotacao);
  prefs.putInt("home_o",  posHome.ombro);
  prefs.putInt("home_c",  posHome.cotovelo);
  prefs.putInt("home_p",  posHome.punho);
  prefs.putInt("home_gr", posHome.garra_rotacao);
  prefs.putInt("home_ga", posHome.garra_abertura);
  prefs.end();
  Serial.printf("[NVS] Home Salva na Flash: B=%d, O=%d, C=%d, P=%d, GR=%d, GA=%d\n",
    posHome.base_rotacao, posHome.ombro, posHome.cotovelo,
    posHome.punho, posHome.garra_rotacao, posHome.garra_abertura);
}

void salvarLimitesNVS() {
  prefs.begin("braco_cfg", false);
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    char kMin[16], kMax[16];
    snprintf(kMin, sizeof(kMin), "lim_min_%d", i);
    snprintf(kMax, sizeof(kMax), "lim_max_%d", i);
    prefs.putInt(kMin, motores[i].anguloMinimo);
    prefs.putInt(kMax, motores[i].anguloMaximo);
  }
  prefs.end();
  Serial.println("[NVS] Limites angulares salvos na Flash!");
}

void salvarPinosNVS() {
  prefs.begin("braco_cfg", false);
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    char kPin[16];
    snprintf(kPin, sizeof(kPin), "pin_%d", i);
    prefs.putInt(kPin, (int)motores[i].pino);
  }
  prefs.end();
  Serial.println("[NVS] Mapeamento de pinos salvo na Flash!");
}

// ============================================================
// CONFIGURAÇÃO DO I2S (MICROFONE INMP441 + ALTO-FALANTE MAX98357A)
// ============================================================

#define I2S_SAMPLE_RATE 16000

// Canal 0: Entrada (2x INMP441 Microfones Estéreo)
#define I2S_MIC_PORT I2S_NUM_0
#define PIN_I2S_MIC_WS  33
#define PIN_I2S_MIC_SCK 32
#define PIN_I2S_MIC_SD  35

// Canal 1: Saída (MAX98357A Amplificador)
#define I2S_SPK_PORT I2S_NUM_1
#define PIN_I2S_SPK_LRC  21
#define PIN_I2S_SPK_BCLK 22
#define PIN_I2S_SPK_DIN  23

bool i2sIniciado = false;

void configurarI2S() {
  // 1. Configuração do Microfone INMP441 (I2S_NUM_0)
  i2s_config_t i2s_mic_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t mic_pins = {
    .bck_io_num = PIN_I2S_MIC_SCK,
    .ws_io_num = PIN_I2S_MIC_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_I2S_MIC_SD
  };

  esp_err_t errMic = i2s_driver_install(I2S_MIC_PORT, &i2s_mic_config, 0, NULL);
  if (errMic == ESP_OK) {
    i2s_set_pin(I2S_MIC_PORT, &mic_pins);
  }

  // 2. Configuração do Alto-falante MAX98357A (I2S_NUM_1)
  i2s_config_t i2s_spk_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t spk_pins = {
    .bck_io_num = PIN_I2S_SPK_BCLK,
    .ws_io_num = PIN_I2S_SPK_LRC,
    .data_out_num = PIN_I2S_SPK_DIN,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  esp_err_t errSpk = i2s_driver_install(I2S_SPK_PORT, &i2s_spk_config, 0, NULL);
  if (errSpk == ESP_OK) {
    i2s_set_pin(I2S_SPK_PORT, &spk_pins);
  }

  i2sIniciado = (errMic == ESP_OK && errSpk == ESP_OK);
  Serial.printf("I2S Inicializado: Mic=%d, Spk=%d\n", errMic, errSpk);
}

// ============================================================
// CONTROLE DE SERVOS
// ============================================================

int limitarAngulo(int motorId, int angulo) {
  return constrain(angulo, motores[motorId].anguloMinimo, motores[motorId].anguloMaximo);
}

int converterAnguloParaPulso(int motorId, int angulo) {
  angulo = limitarAngulo(motorId, angulo);
  return map(angulo, motores[motorId].anguloMinimo, motores[motorId].anguloMaximo,
             motores[motorId].pulsoMinimoUs, motores[motorId].pulsoMaximoUs);
}

void escreverAngulo(int motorId, int angulo) {
  int pulso = converterAnguloParaPulso(motorId, angulo);
  motores[motorId].driver.writeMicroseconds(pulso);
}

void anexarMotorSeNecessario(int motorId, int primeiroAngulo) {
  if (motores[motorId].anexado) return;

  primeiroAngulo = limitarAngulo(motorId, primeiroAngulo);
  motores[motorId].driver.setPeriodHertz(FREQUENCIA_SERVO_HZ);
  motores[motorId].driver.attach(motores[motorId].pino, 500, 2500);

  motores[motorId].anexado = true;
  motores[motorId].anguloAtual = primeiroAngulo;
  motores[motorId].anguloAlvo = primeiroAngulo;
  motores[motorId].ultimoPassoMs = millis();
  escreverAngulo(motorId, primeiroAngulo);
}

void definirAlvoMotor(int motorId, int angulo, int velocidade) {
  angulo = limitarAngulo(motorId, angulo);
  velocidade = constrain(velocidade, 1, 300);

  if (!motores[motorId].anexado) {
    anexarMotorSeNecessario(motorId, angulo);
    return;
  }

  // Motores leves MG90S (Garra e Punho) operam com maior dinamismo e velocidade
  if (motorId == PUNHO || motorId == GARRA_ROTACAO || motorId == GARRA_ABERTURA) {
    velocidade = constrain(velocidade * 2, 1, 300);
  }

  motores[motorId].anguloAlvo = angulo;
  motores[motorId].velocidade = velocidade;
}

int calcularAnguloOmbroSlave(int anguloMaster) {
  int anguloSlave = OMBRO_INVERTIDO ? (180 - anguloMaster) : anguloMaster;
  anguloSlave += offsetOmbroSlave;
  return limitarAngulo(OMBRO_SLAVE, anguloSlave);
}

void definirAlvoOmbro(int angulo, int velocidade) {
  // Acoplamento coordenado dos 2 motores do ombro para evitar forçamento mecânico
  // Ombro Master (MG996R) e Ombro Slave (MG90S Invertido: slave = 180 - master + offset)
  // Para que o slave fique em [slave_min, slave_max], o master deve respeitar:
  // master >= 180 + offset - slave_max  e  master <= 180 + offset - slave_min
  int effMin = max(motores[OMBRO_MASTER].anguloMinimo, 180 + offsetOmbroSlave - motores[OMBRO_SLAVE].anguloMaximo);
  int effMax = min(motores[OMBRO_MASTER].anguloMaximo, 180 + offsetOmbroSlave - motores[OMBRO_SLAVE].anguloMinimo);
  if (effMin > effMax) {
    effMin = motores[OMBRO_MASTER].anguloMinimo;
    effMax = motores[OMBRO_MASTER].anguloMaximo;
  }
  int master = constrain(angulo, effMin, effMax);
  int slave = calcularAnguloOmbroSlave(master);
  definirAlvoMotor(OMBRO_MASTER, master, velocidade);
  definirAlvoMotor(OMBRO_SLAVE, slave, velocidade);
}

void atualizarMovimentos() {
  unsigned long agora = millis();
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (!motores[i].anexado || motores[i].anguloAtual == motores[i].anguloAlvo) {
      continue;
    }
    int vel = max(1, motores[i].velocidade);
    // Para micro-servos (garra e punho), o intervalo mínimo de passo é 2ms
    bool ehMicroServo = (i == PUNHO || i == GARRA_ROTACAO || i == GARRA_ABERTURA);
    unsigned long minIntervalo = ehMicroServo ? 2UL : 4UL;
    unsigned long intervalo = max(minIntervalo, 1000UL / (unsigned long)vel);
    if (agora - motores[i].ultimoPassoMs < intervalo) {
      continue;
    }
    motores[i].ultimoPassoMs = agora;

    // Passo acelerado para micro-servos quando a velocidade solicitada for alta (>= 100)
    int passo = 1;
    if (ehMicroServo && vel >= 100) {
      int diff = abs(motores[i].anguloAlvo - motores[i].anguloAtual);
      if (diff >= 2) passo = 2;
    }

    if (motores[i].anguloAtual < motores[i].anguloAlvo) {
      motores[i].anguloAtual = min(motores[i].anguloAlvo, motores[i].anguloAtual + passo);
    } else {
      motores[i].anguloAtual = max(motores[i].anguloAlvo, motores[i].anguloAtual - passo);
    }
    escreverAngulo(i, motores[i].anguloAtual);
  }
}

void pararMovimentos() {
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (motores[i].anexado) {
      motores[i].anguloAlvo = motores[i].anguloAtual;
    }
  }
}

void desanexarTodos() {
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (motores[i].anexado) {
      motores[i].driver.detach();
      motores[i].anexado = false;
    }
    pinMode(motores[i].pino, OUTPUT);
    digitalWrite(motores[i].pino, LOW);
  }
}

void anexarTodosNaHome() {
  definirAlvoMotor(BASE_ROTACAO, posHome.base_rotacao, 35);
  definirAlvoOmbro(posHome.ombro, 35);
  definirAlvoMotor(COTOVELO, posHome.cotovelo, 35);
  definirAlvoMotor(PUNHO, posHome.punho, 35);
  definirAlvoMotor(GARRA_ROTACAO, posHome.garra_rotacao, 35);
  definirAlvoMotor(GARRA_ABERTURA, posHome.garra_abertura, 35);
}

// ============================================================
// REMAPEAMENTO DINÂMICO DE PINOS
// ============================================================

void remapearPino(int motorId, uint8_t novoPino) {
  if (motorId < 0 || motorId >= TOTAL_MOTORES) return;
  if (motores[motorId].pino == novoPino) return;

  if (motores[motorId].anexado) {
    motores[motorId].driver.detach();
    motores[motorId].anexado = false;
  }
  motores[motorId].pino = novoPino;
  pinMode(novoPino, OUTPUT);
  digitalWrite(novoPino, LOW);
  anexarMotorSeNecessario(motorId, motores[motorId].anguloAtual);
}

// ============================================================
// RESPOSTAS JSON E CORS
// ============================================================

void adicionarCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Content-Length");
}

void enviarJson(int statusHttp, const String& json) {
  adicionarCors();
  server.send(statusHttp, "application/json", json);
}

// ============================================================
// ROTAS HTTP
// ============================================================
// TELEMETRIA ULTRA-RÁPIDA (30-50Hz) PARA SINCRONISMO 3D
// ============================================================

void handleTelemetry() {
  adicionarCors();
  bool emMovimento = false;
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (motores[i].anexado && motores[i].anguloAtual != motores[i].anguloAlvo) {
      emMovimento = true;
      break;
    }
  }
  char buf[160];
  snprintf(buf, sizeof(buf),
    "{\"sucesso\":true,\"b\":%d,\"o\":%d,\"c\":%d,\"p\":%d,\"gr\":%d,\"ga\":%d,\"m\":%d}",
    motores[BASE_ROTACAO].anexado ? motores[BASE_ROTACAO].anguloAtual : 90,
    motores[OMBRO_MASTER].anexado ? motores[OMBRO_MASTER].anguloAtual : 90,
    motores[COTOVELO].anexado ? motores[COTOVELO].anguloAtual : 90,
    motores[PUNHO].anexado ? motores[PUNHO].anguloAtual : 90,
    motores[GARRA_ROTACAO].anexado ? motores[GARRA_ROTACAO].anguloAtual : 90,
    motores[GARRA_ABERTURA].anexado ? motores[GARRA_ABERTURA].anguloAtual : 90,
    emMovimento ? 1 : 0
  );
  server.send(200, "application/json", buf);
}

void handleStatus() {
  String json = "{";
  json += "\"sucesso\":true,";
  json += "\"sistema\":\"braco_robotico_v8\",";
  json += "\"habilitado\":" + String(sistemaHabilitado ? "true" : "false") + ",";
  json += "\"i2s_ativo\":" + String(i2sIniciado ? "true" : "false") + ",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"ip_sta\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "desconectado") + "\",";
  json += "\"ip_ativo\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString()) + "\",";
  json += "\"motores\":[";
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (i > 0) json += ",";
    json += "{\"nome\":\"" + String(motores[i].nome) + "\",";
    json += "\"pino\":" + String(motores[i].pino) + ",";
    json += "\"anexado\":" + String(motores[i].anexado ? "true" : "false") + ",";
    json += "\"atual\":" + String(motores[i].anexado ? motores[i].anguloAtual : 90) + ",";
    json += "\"alvo\":" + String(motores[i].anexado ? motores[i].anguloAlvo : 90) + "}";
  }
  json += "]}";
  enviarJson(200, json);
}

void handleMove() {
  if (!sistemaHabilitado) {
    enviarJson(409, "{\"sucesso\":false,\"erro\":\"SYSTEM_DISABLED\"}");
    return;
  }
  int velocidade = VELOCIDADE_PADRAO;
  if (server.hasArg("speed")) {
    velocidade = server.arg("speed").toInt();
  }

  // Parse dos parâmetros via query/form
  if (server.hasArg("base_rotacao")) definirAlvoMotor(BASE_ROTACAO, server.arg("base_rotacao").toInt(), velocidade);
  if (server.hasArg("ombro")) definirAlvoOmbro(server.arg("ombro").toInt(), velocidade);
  if (server.hasArg("cotovelo")) definirAlvoMotor(COTOVELO, server.arg("cotovelo").toInt(), velocidade);
  if (server.hasArg("punho")) definirAlvoMotor(PUNHO, server.arg("punho").toInt(), velocidade);
  if (server.hasArg("garra_rotacao")) definirAlvoMotor(GARRA_ROTACAO, server.arg("garra_rotacao").toInt(), velocidade);
  if (server.hasArg("garra_abertura")) definirAlvoMotor(GARRA_ABERTURA, server.arg("garra_abertura").toInt(), velocidade);

  // Suporte robusto a corpo JSON bruto no POST (ex: {"base_rotacao": 90, "speed": 50})
  if (server.hasArg("plain")) {
    String corpo = server.arg("plain");
    auto extrair = [&](const char* chave) -> int {
      int idx = corpo.indexOf(chave);
      if (idx < 0) return -999;
      int col = corpo.indexOf(":", idx);
      if (col < 0) return -999;
      int fim = corpo.indexOf(",", col);
      if (fim < 0) fim = corpo.indexOf("}", col);
      if (fim < 0) fim = corpo.length();
      String val = corpo.substring(col + 1, fim);
      val.trim();
      return val.toInt();
    };
    int sp = extrair("\"speed\"");
    if (sp > 0) velocidade = sp;
    int v = extrair("\"base_rotacao\""); if (v != -999) definirAlvoMotor(BASE_ROTACAO, v, velocidade);
    v = extrair("\"ombro\""); if (v != -999) definirAlvoOmbro(v, velocidade);
    v = extrair("\"cotovelo\""); if (v != -999) definirAlvoMotor(COTOVELO, v, velocidade);
    v = extrair("\"punho\""); if (v != -999) definirAlvoMotor(PUNHO, v, velocidade);
    v = extrair("\"garra_rotacao\""); if (v != -999) definirAlvoMotor(GARRA_ROTACAO, v, velocidade);
    v = extrair("\"garra_abertura\""); if (v != -999) definirAlvoMotor(GARRA_ABERTURA, v, velocidade);
  }

  enviarJson(200, "{\"sucesso\":true,\"mensagem\":\"Movimento atualizado\"}");
}

void handleHome() {
  if (!sistemaHabilitado) {
    enviarJson(409, "{\"sucesso\":false,\"erro\":\"SYSTEM_DISABLED\"}");
    return;
  }
  anexarTodosNaHome();
  enviarJson(200, "{\"sucesso\":true,\"mensagem\":\"Movendo para Home\"}");
}

void handleHomeConfig() {
  if (server.method() == HTTP_POST) {
    if (server.hasArg("base_rotacao")) posHome.base_rotacao = server.arg("base_rotacao").toInt();
    if (server.hasArg("ombro")) posHome.ombro = server.arg("ombro").toInt();
    if (server.hasArg("cotovelo")) posHome.cotovelo = server.arg("cotovelo").toInt();
    if (server.hasArg("punho")) posHome.punho = server.arg("punho").toInt();
    if (server.hasArg("garra_rotacao")) posHome.garra_rotacao = server.arg("garra_rotacao").toInt();
    if (server.hasArg("garra_abertura")) posHome.garra_abertura = server.arg("garra_abertura").toInt();

    // Suporte a JSON no corpo HTTP bruto (plain)
    if (server.hasArg("plain")) {
      String corpo = server.arg("plain");
      auto extrair = [&](const char* chave) -> int {
        int idx = corpo.indexOf(chave);
        if (idx < 0) return -999;
        int col = corpo.indexOf(":", idx);
        if (col < 0) return -999;
        int fim = corpo.indexOf(",", col);
        if (fim < 0) fim = corpo.indexOf("}", col);
        if (fim < 0) fim = corpo.length();
        String val = corpo.substring(col + 1, fim);
        val.trim();
        return val.toInt();
      };
      int v = extrair("\"base_rotacao\""); if (v != -999) posHome.base_rotacao = v;
      v = extrair("\"ombro\""); if (v != -999) posHome.ombro = v;
      v = extrair("\"cotovelo\""); if (v != -999) posHome.cotovelo = v;
      v = extrair("\"punho\""); if (v != -999) posHome.punho = v;
      v = extrair("\"garra_rotacao\""); if (v != -999) posHome.garra_rotacao = v;
      v = extrair("\"garra_abertura\""); if (v != -999) posHome.garra_abertura = v;
    }

    salvarHomeNVS();
  }
  String json = "{";
  json += "\"base_rotacao\":" + String(posHome.base_rotacao) + ",";
  json += "\"ombro\":" + String(posHome.ombro) + ",";
  json += "\"cotovelo\":" + String(posHome.cotovelo) + ",";
  json += "\"punho\":" + String(posHome.punho) + ",";
  json += "\"garra_rotacao\":" + String(posHome.garra_rotacao) + ",";
  json += "\"garra_abertura\":" + String(posHome.garra_abertura);
  json += "}";
  enviarJson(200, json);
}

void handlePins() {
  if (server.method() == HTTP_POST) {
    if (server.hasArg("garra_abertura")) remapearPino(GARRA_ABERTURA, server.arg("garra_abertura").toInt());
    if (server.hasArg("garra_rotacao"))  remapearPino(GARRA_ROTACAO,  server.arg("garra_rotacao").toInt());
    if (server.hasArg("ombro_slave"))    remapearPino(OMBRO_SLAVE,    server.arg("ombro_slave").toInt());
    if (server.hasArg("punho"))          remapearPino(PUNHO,          server.arg("punho").toInt());
    if (server.hasArg("base_rotacao"))   remapearPino(BASE_ROTACAO,   server.arg("base_rotacao").toInt());
    if (server.hasArg("cotovelo"))       remapearPino(COTOVELO,       server.arg("cotovelo").toInt());
    if (server.hasArg("ombro_master"))   remapearPino(OMBRO_MASTER,   server.arg("ombro_master").toInt());

    // Suporte a JSON no corpo HTTP bruto (plain)
    if (server.hasArg("plain")) {
      String corpo = server.arg("plain");
      auto extrair = [&](const char* chave) -> int {
        int idx = corpo.indexOf(chave);
        if (idx < 0) return -999;
        int col = corpo.indexOf(":", idx);
        if (col < 0) return -999;
        int fim = corpo.indexOf(",", col);
        if (fim < 0) fim = corpo.indexOf("}", col);
        if (fim < 0) fim = corpo.length();
        String val = corpo.substring(col + 1, fim);
        val.trim();
        return val.toInt();
      };
      int v = extrair("\"garra_abertura\""); if (v != -999) remapearPino(GARRA_ABERTURA, v);
      v = extrair("\"garra_rotacao\""); if (v != -999) remapearPino(GARRA_ROTACAO, v);
      v = extrair("\"ombro_slave\""); if (v != -999) remapearPino(OMBRO_SLAVE, v);
      v = extrair("\"punho\""); if (v != -999) remapearPino(PUNHO, v);
      v = extrair("\"base_rotacao\""); if (v != -999) remapearPino(BASE_ROTACAO, v);
      v = extrair("\"cotovelo\""); if (v != -999) remapearPino(COTOVELO, v);
      v = extrair("\"ombro_master\""); if (v != -999) remapearPino(OMBRO_MASTER, v);
    }

    salvarPinosNVS();
  }
  String json = "{";
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (i > 0) json += ",";
    json += "\"" + String(motores[i].nome) + "\":" + String(motores[i].pino);
  }
  json += "}";
  enviarJson(200, json);
}

void handleLimits() {
  if (server.method() == HTTP_POST) {
    auto atualizarLimite = [&](int motorId, const char* minKey, const char* maxKey) {
      if (server.hasArg(minKey)) {
        motores[motorId].anguloMinimo = constrain(server.arg(minKey).toInt(), 0, 180);
      }
      if (server.hasArg(maxKey)) {
        motores[motorId].anguloMaximo = constrain(server.arg(maxKey).toInt(), 0, 180);
      }
      if (motores[motorId].anguloMinimo > motores[motorId].anguloMaximo) {
        int temp = motores[motorId].anguloMinimo;
        motores[motorId].anguloMinimo = motores[motorId].anguloMaximo;
        motores[motorId].anguloMaximo = temp;
      }
    };

    atualizarLimite(GARRA_ABERTURA, "garra_abertura_min", "garra_abertura_max");
    atualizarLimite(GARRA_ROTACAO,  "garra_rotacao_min",  "garra_rotacao_max");
    atualizarLimite(PUNHO,          "punho_min",          "punho_max");
    atualizarLimite(COTOVELO,       "cotovelo_min",       "cotovelo_max");
    atualizarLimite(OMBRO_MASTER,   "ombro_master_min",   "ombro_master_max");
    atualizarLimite(OMBRO_SLAVE,    "ombro_slave_min",    "ombro_slave_max");
    atualizarLimite(BASE_ROTACAO,   "base_rotacao_min",   "base_rotacao_max");

    if (server.hasArg("plain")) {
      String corpo = server.arg("plain");
      auto extrair = [&](const char* chave) -> int {
        int idx = corpo.indexOf(chave);
        if (idx < 0) return -999;
        int col = corpo.indexOf(":", idx);
        if (col < 0) return -999;
        int fim = corpo.indexOf(",", col);
        if (fim < 0) fim = corpo.indexOf("}", col);
        if (fim < 0) fim = corpo.length();
        String val = corpo.substring(col + 1, fim);
        val.trim();
        return val.toInt();
      };

      for (int i = 0; i < TOTAL_MOTORES; i++) {
        String kMin = String("\"") + motores[i].nome + "_min\"";
        String kMax = String("\"") + motores[i].nome + "_max\"";
        int vMin = extrair(kMin.c_str());
        int vMax = extrair(kMax.c_str());
        if (vMin != -999) motores[i].anguloMinimo = constrain(vMin, 0, 180);
        if (vMax != -999) motores[i].anguloMaximo = constrain(vMax, 0, 180);
        if (motores[i].anguloMinimo > motores[i].anguloMaximo) {
          int t = motores[i].anguloMinimo;
          motores[i].anguloMinimo = motores[i].anguloMaximo;
          motores[i].anguloMaximo = t;
        }
      }
    }

    salvarLimitesNVS();
  }

  String json = "{\"sucesso\":true,\"limits\":{";
  for (int i = 0; i < TOTAL_MOTORES; i++) {
    if (i > 0) json += ",";
    json += "\"" + String(motores[i].nome) + "\":{";
    json += "\"min\":" + String(motores[i].anguloMinimo) + ",";
    json += "\"max\":" + String(motores[i].anguloMaximo) + "}";
  }
  json += "}}";
  enviarJson(200, json);
}

void handleAudioUpload() {
  // Callback chamado durante o recebimento do upload de áudio.
  // Os chunks PCM recebidos são enviados diretamente para o I2S do alto-falante.
  if (!i2sIniciado) {
    return;
  }

  HTTPUpload& upload = server.upload();

  if (upload.status == UPLOAD_FILE_WRITE && upload.currentSize > 0) {
    size_t bytesEscritos = 0;
    esp_err_t resultado = i2s_write(
      I2S_SPK_PORT,
      upload.buf,
      upload.currentSize,
      &bytesEscritos,
      portMAX_DELAY
    );

    if (resultado != ESP_OK || bytesEscritos != upload.currentSize) {
      Serial.printf(
        "[Áudio TX] Falha ao escrever no I2S. erro=%d, recebido=%u, escrito=%u\n",
        resultado,
        (unsigned int)upload.currentSize,
        (unsigned int)bytesEscritos
      );
    }
  }

}

void handleAudioStream() {
  // Esta função é chamada uma única vez ao final da requisição HTTP.
  // O áudio em si é processado por handleAudioUpload().
  if (!i2sIniciado) {
    enviarJson(500, "{\"sucesso\":false,\"erro\":\"I2S_NOT_READY\"}");
    return;
  }

  enviarJson(200, "{\"sucesso\":true,\"mensagem\":\"Audio recebido\"}");
}

void handleMicCapture() {
  if (!i2sIniciado) {
    enviarJson(500, "{\"sucesso\":false,\"erro\":\"I2S_NOT_READY\"}");
    return;
  }

  // Captura PCM estéreo cru dos microfones INMP441.
  // 16 kHz x 16 bits x 2 canais = 64000 bytes/s.
  // Um buffer de 16000 bytes corresponde a aproximadamente 0,25 s.
  const size_t BUFFER_SIZE = 16000;

  uint8_t* audioBuf = (uint8_t*)malloc(BUFFER_SIZE);
  if (!audioBuf) {
    enviarJson(500, "{\"sucesso\":false,\"erro\":\"OUT_OF_MEMORY\"}");
    return;
  }

  size_t bytesLidos = 0;
  esp_err_t resultado = i2s_read(
    I2S_MIC_PORT,
    audioBuf,
    BUFFER_SIZE,
    &bytesLidos,
    pdMS_TO_TICKS(600)
  );

  if (resultado != ESP_OK || bytesLidos == 0) {
    Serial.printf(
      "[Áudio RX] Falha na captura. erro=%d, bytes=%u\n",
      resultado,
      (unsigned int)bytesLidos
    );
    free(audioBuf);
    enviarJson(500, "{\"sucesso\":false,\"erro\":\"MIC_READ_FAILED\"}");
    return;
  }

  adicionarCors();
  server.sendHeader("Content-Disposition", "attachment; filename=\"mic.raw\"");

  // WebServer do Arduino-ESP32 3.x não possui send(code, type, char*, length).
  // Primeiro informamos o tamanho, enviamos os cabeçalhos e depois o buffer binário.
  server.setContentLength(bytesLidos);
  server.send(200, "application/octet-stream", "");
  server.sendContent(reinterpret_cast<const char*>(audioBuf), bytesLidos);

  free(audioBuf);
}

void handleOptions() {
  adicionarCors();
  server.send(204);
}

void configurarRotas() {
  server.on("/telemetry", HTTP_GET, handleTelemetry);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/move", HTTP_GET, handleMove);
  server.on("/move", HTTP_POST, handleMove);
  server.on("/home", HTTP_GET, handleHome);
  server.on("/home", HTTP_POST, handleHome);
  server.on("/home/config", HTTP_GET, handleHomeConfig);
  server.on("/home/config", HTTP_POST, handleHomeConfig);
  server.on("/pins", HTTP_GET, handlePins);
  server.on("/pins", HTTP_POST, handlePins);
  server.on("/limits", HTTP_GET, handleLimits);
  server.on("/limits", HTTP_POST, handleLimits);
  server.on("/habilitar", HTTP_GET, []() { sistemaHabilitado = true; enviarJson(200, "{\"sucesso\":true}"); });
  server.on("/desabilitar", HTTP_GET, []() { sistemaHabilitado = false; desanexarTodos(); enviarJson(200, "{\"sucesso\":true}"); });
  server.on("/stop", HTTP_GET, []() { pararMovimentos(); enviarJson(200, "{\"sucesso\":true}"); });
  server.on("/audio/stream", HTTP_POST, handleAudioStream, handleAudioUpload);
  server.on("/mic/capture", HTTP_GET, handleMicCapture);

  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      handleOptions();
    } else {
      enviarJson(404, "{\"sucesso\":false,\"erro\":\"NOT_FOUND\"}");
    }
  });
}

// ============================================================
// SETUP E LOOP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== BRAÇO ROBÓTICO ESP32 V8.0 INICIALIZANDO ===");

  // Carregar configurações salvas na memória flash não-volátil (NVS)
  carregarConfiguracoesNVS();

  // Iniciar I2S de áudio
  configurarI2S();

  // Inicializar Wi-Fi em modo dual (AP + Station)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.print("[Wi-Fi AP] Ponto de acesso próprio ativo: ");
  Serial.print(AP_SSID);
  Serial.print(" | IP: ");
  Serial.println(WiFi.softAPIP());

  if (strlen(STA_SSID) > 0 && strcmp(STA_SSID, "SUA_REDE_WIFI") != 0) {
    if (USAR_IP_ESTATICO_STA) {
      WiFi.config(ESP32_IP_FIXO, ESP32_GATEWAY, ESP32_SUBNET, ESP32_DNS);
    }
    WiFi.begin(STA_SSID, STA_PASSWORD);
    Serial.print("[Wi-Fi STA] Conectando a ");
    Serial.print(STA_SSID);
    
    int tentativas = 0;
    while (WiFi.status() != WL_CONNECTED && tentativas < 20) {
      delay(500);
      Serial.print(".");
      tentativas++;
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[Wi-Fi STA] Conectado com sucesso!");
      Serial.print("[Wi-Fi STA] IP ATRIBUÍDO AO ESP32: ");
      Serial.println(WiFi.localIP());
    } else {
      Serial.println("\n[Wi-Fi STA] Falha ao conectar no Wi-Fi Station.");
      Serial.print("[Wi-Fi STA] Conecte diretamente no AP: ");
      Serial.print(AP_SSID);
      Serial.print(" (IP: ");
      Serial.print(WiFi.softAPIP());
      Serial.println(")");
    }
  }

  configurarRotas();
  server.begin();
  Serial.println("Servidor HTTP do ESP32 ativo na porta 80.");
}

void loop() {
  server.handleClient();
  atualizarMovimentos();
}
