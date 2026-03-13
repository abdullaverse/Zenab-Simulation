window.onload = function() {
const cCodeTemplate = `// ==========================================
// FILE: main.c
// ==========================================
#include <FreeRTOS.h>
#include <task.h>
#include "pms5003.h"
#include "sps30.h"
#include "mq135.h"
#include "dht22.h"
#include "gps_module.h"

// Task Handles
TaskHandle_t xSensorTask = NULL;
TaskHandle_t xCloudTask = NULL;

void setup() {
    Serial.begin(115200);
    initSystem();
    
    // Create Real-time Tasks
    xTaskCreate(vSensorTask, "SensorTask", 4096, NULL, 2, &xSensorTask);
    xTaskCreate(vCloudTask,  "CloudTask",  8192, NULL, 1, &xCloudTask);
    
    Serial.println("ZENAB RTOS CORE ONLINE");
}

// ── TASK: Sensor Acquistion (Priority 2) ──
void vSensorTask(void *pvParameters) {
    for(;;) {
        pms.update();      // UART
        sps30.read();      // I2C
        dht22.read();      // OneWire
        mq135.read();      // ADC
        
        feedWatchdog();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

// ── TASK: Cloud Transmission (Priority 1) ──
void vCloudTask(void *pvParameters) {
    for(;;) {
        if (WiFi.status() == WL_CONNECTED) {
            serializeJSON();
            mqtt.publish("zenab/telemetry", jsonBuffer);
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

// ==========================================
// FILE: drv_pms5003.c (UART)
// ==========================================
#include "pms5003.h"
bool pms_read() {
    byte buffer[32];
    if (Serial2.available() >= 32) {
        Serial2.readBytes(buffer, 32);
        // Frame validation (0x42, 0x4D)
        if (buffer[0] == 0x42 && buffer[1] == 0x4D) {
            uint16_t pm25 = (buffer[6] << 8) | buffer[7];
            currentData.pm25 = pm25;
            return true;
        }
    }
    return false;
}

// ==========================================
// FILE: drv_sps30.c (I2C)
// ==========================================
#include <Wire.h>
void sps30_init() {
    Wire.beginTransmission(0x69);
    Wire.write(0x00); // Start measurement
    Wire.endTransmission();
}

// ==========================================
// FILE: drv_mq135.c (ADC)
// ==========================================
float get_ppm() {
    int raw = analogRead(34);
    float volt = (raw / 4095.0) * 3.3;
    float rs = ((3.3 - volt) / volt) * 10; // Rl=10k
    return pow(10, (log10(rs/Ro) - b) / m);
}
`;

const btnSaveCode = document.getElementById('btn-save-code');
const saveIndicator = document.getElementById('save-indicator');

// Initialize CodeMirror Editor only if textarea exists
const codeTextArea = document.getElementById('code-editor');
let editor = null;
if (codeTextArea) {
    editor = CodeMirror.fromTextArea(codeTextArea, {
        mode: "text/x-csrc",
        theme: "dracula",
        lineNumbers: true,
        readOnly: false
    });
    editor.setValue(cCodeTemplate);
}

// DOM Elements Mapping
const btnRun = document.getElementById('btn-run');
const btnPause = document.getElementById('btn-pause');
const btnReset = document.getElementById('btn-reset');
const envMode = document.getElementById('env-mode');
const apiUrlInput = document.getElementById('api-url');
const terminal = document.getElementById('terminal-output');
const cloudStatusText = document.getElementById('cloud-status-text');
const currentFileHeader = document.getElementById('current-filename');

// Virtual File System (Hardware Drivers)
let currentFileId = 'main';
const virtualFS = {
    'main': cCodeTemplate,
    'comp-sps30': `// SPS30 I2C Driver\n#include <Wire.h>\nvoid readSPS30() {\n  Wire.beginTransmission(0x69);\n  // Read PM2.5 data...\n  Wire.endTransmission();\n}`,
    'comp-pms5003': `// PMS5003 UART Driver\nvoid readPMS5003() {\n  if(Serial2.available() >= 32) {\n    // Parse packet...\n  }\n}`,
    'comp-mq135': `// MQ135 ADC Driver\nvoid readMQ135() {\n  int val = analogRead(34);\n  float ppm = calculatePPM(val);\n}`,
    'comp-dht22': `// DHT22 OneWire Driver\nvoid readDHT22() {\n  float temp = dht.readTemperature();\n  float hum = dht.readHumidity();\n}`,
    'comp-gps': `// GPS NEO-6M Driver\nvoid readGPS() {\n  while(Serial1.available()) {\n    gps.encode(Serial1.read());\n  }\n}`,
    'comp-abd': `// ABD Toxic Sensor\nvoid checkABD() {\n  if(analogRead(35) > threshold) {\n    triggerAlarm();\n  }\n}`,
    'comp-esp32': `// System Core (ESP32)\nvoid initSystem() {\n  setupWiFi();\n  startRTOS();\n}`,
    'comp-wifi': `// WiFi Stack\nvoid connectWiFi() {\n  WiFi.begin(SSID, PASS);\n}`,
    'comp-fan': `// Smart Fan PWM Control\nvoid setFan(int speed) {\n  ledcWrite(0, speed);\n}`,
    'comp-chamber': `// Burn Chamber Control\nvoid toggleChamber(bool on) {\n  digitalWrite(19, on ? HIGH : LOW);\n}`,
    'comp-power': `// Power Management\nvoid readBattery() {\n  float v = analogRead(32) * (3.3/4095.0) * 2;\n}`,
    'comp-aps': `// ==========================================\n// FILE: drv_aps.c (APS Sensor - I2C/ADC)\n// ==========================================\n#include "aps_sensor.h"\n#include "sps30.h"\n#include "mq135.h"\n\n// APS: Air Purification Sensor Driver\n// Monitors post-filtration air quality\n\nfloat aps_pm_out = 0.0f;\nfloat aps_efficiency = 0.0f;\nchar  aps_status[16] = "CLEAN AIR";\n\nfloat readPurificationEfficiency() {\n    float pm_in  = sps30.getPM25();   // Pre-filter PM (SPS30)\n    float pm_out = aps_pm_sensor.read(); // Post-filter PM\n    if (pm_in > 0.0f)\n        return (1.0f - (pm_out / pm_in)) * 100.0f;\n    return 0.0f;\n}\n\nAirStatus classifyAir(float pm_out, float gas_ppm) {\n    if (pm_out < 15.0f && gas_ppm < 50.0f) {\n        strcpy(aps_status, "CLEAN AIR");\n        return CLEAN_AIR;\n    }\n    if (pm_out < 50.0f) {\n        strcpy(aps_status, "MODERATE AIR");\n        return MODERATE_AIR;\n    }\n    // Trigger ABD thermal oxidation chamber\n    strcpy(aps_status, "HARMFUL AIR");\n    triggerABDChamber();\n    return HARMFUL_AIR;\n}\n\nvoid vAPSTask(void *pvParameters) {\n    for(;;) {\n        aps_efficiency = readPurificationEfficiency();\n        float gas_ppm  = mq135.readPPM();\n        AirStatus st   = classifyAir(aps_pm_out, gas_ppm);\n        sendTelemetry("aps", aps_efficiency, aps_pm_out, st);\n        vTaskDelay(pdMS_TO_TICKS(1000));\n    }\n}`
};

// File extensions mapping
const fileNames = {
    'main': 'main.c',
    'comp-sps30': 'drv_sps30.c',
    'comp-pms5003': 'drv_pms5003.c',
    'comp-mq135': 'drv_mq135.c',
    'comp-dht22': 'drv_dht22.c',
    'comp-gps': 'drv_gps.c',
    'comp-abd': 'drv_abd.c',
    'comp-esp32': 'system_core.c',
    'comp-wifi': 'comm_wifi.c',
    'comp-fan': 'act_fan.c',
    'comp-chamber': 'act_chamber.c',
    'comp-power': 'pow_mgmt.c',
    'comp-aps': 'drv_aps.c'
};

// IDE Simulation State
let isRunning = false;
let simInterval = null;
let cloudSyncCounter = 0;

let state = {
    pm25: 15,
    aqi: 40,
    temp: 25,
    humidity: 50,
    oxygen: 21.0,
    abdLevel: 0, 
    fanSpeed: 0,
    burnChamber: false,
    powerSource: 'solar',
    batteryPct: 100,
    pms25: 12,
    lat: 12.9716,
    lon: 77.5946,
    cpuLoad: 2.5,
    heapFree: 244,
    wdogKicked: true,
    // APS (Air Purification Sensor) state
    apsEfficiency: 95,      // Purification efficiency %
    apsPmOut: 5.0,          // PM2.5 post-filtration µg/m³
    apsGasLevel: 'Low',     // Low / Moderate / High
    apsStatus: 'CLEAN AIR', // CLEAN AIR / MODERATE AIR / HARMFUL AIR
    apsStageProgress: 0     // 0-5 stages active (for filtration flow animation)
};

// Mode specific baseline parameters
const envConfigs = {
    clean:      { pm25Base: 15,  aqiBase: 40,  tempMod: 0,   toxBase: 0,  apsEffBase: 95 },
    urban:      { pm25Base: 65,  aqiBase: 120, tempMod: +2,  toxBase: 10, apsEffBase: 76 },
    industrial: { pm25Base: 150, aqiBase: 210, tempMod: +5,  toxBase: 35, apsEffBase: 55 },
    toxic:      { pm25Base: 300, aqiBase: 400, tempMod: +10, toxBase: 90, apsEffBase: 28 }
};

// Logging standard console equivalent
function logSerial(msg, type = '') {
    if (!terminal) return;
    const div = document.createElement('div');
    div.textContent = `> ${msg}`;
    if (type) div.className = `t-${type}`;
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
}

// Updating DOM Canvas elements
const ledEl = () => document.querySelector('#comp-esp32 .comp-led');

function updateUI() {
    if (!isRunning) return;

    // LCD
    const lcdAqi = document.getElementById('lcd-aqi');
    if (lcdAqi) lcdAqi.textContent  = state.aqi;
    const lcdPm25 = document.getElementById('lcd-pm25');
    if (lcdPm25) lcdPm25.textContent = state.pm25.toFixed(1);
    const lcdO2 = document.getElementById('lcd-o2');
    if (lcdO2) lcdO2.textContent   = state.oxygen.toFixed(1);

    // Canvas live badges (circuit board)
    const setV = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const pm25Str  = `${state.pm25.toFixed(1)} µg/m³`;
    const gasStr   = `${(state.abdLevel * 2.5).toFixed(0)} ppm`;
    const tempStr  = `${state.temp.toFixed(1)}°C ${state.humidity.toFixed(0)}%RH`;
    const abdStr   = state.abdLevel > 50 ? '⚠ TOXIC' : 'Safe';
    const powerStr = `${state.powerSource === 'solar' ? '☀ Solar' : '🔋 Bat'} ${state.batteryPct.toFixed(0)}%`;
    // Circuit board badges
    setV('mod-pm25', pm25Str);
    setV('mod-gas',  gasStr);
    setV('mod-temp', tempStr);
    setV('mod-abd',  abdStr);
    setV('mod-pms5003', `${state.pms25.toFixed(1)} µg/m³`);
    setV('mod-power', powerStr);
    setV('mod-wifi', '📡 TX');
    setV('mod-gsm',  state.burnChamber ? '⚠ Alert' : 'Standby');
    setV('mod-gps',  `${state.lat.toFixed(2)}, ${state.lon.toFixed(2)}`);
    // Telemetry pane values
    setV('tele-pm25',  pm25Str);
    setV('tele-gas',   gasStr);
    setV('tele-pms',   `${state.pms25.toFixed(1)} µg/m³`);
    setV('tele-temp',  tempStr);
    setV('tele-abd',   state.abdLevel > 50 ? '⚠ TOXIC DETECTED' : 'Safe');
    setV('tele-power', powerStr);
    setV('tele-fan',   state.fanSpeed > 50 ? 'HIGH (PWM 100%)' : state.fanSpeed > 0 ? 'LOW (PWM 50%)' : 'OFF');
    setV('tele-burn',  state.burnChamber ? '🔥 ACTIVE' : 'OFF');
    setV('tele-gps',   `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`);

    // System Diagnostics
    setV('tele-cpu',   `${state.cpuLoad.toFixed(1)}%`);
    setV('tele-heap',  `${state.heapFree} KB`);
    setV('tele-wdog',  state.wdogKicked ? 'KICKED ✓' : '⚠ STALE');

    // Progress bars
    const bar = (id, pct) => { const el = document.getElementById(id); if (el) el.style.setProperty('--fill', Math.min(100, pct) + '%'); };
    bar('bar-pm25',   (state.pm25 / 300) * 100);
    bar('bar-gas',    (state.abdLevel / 100) * 100);
    bar('bar-pms',    (state.pms25 / 300) * 100);
    bar('bar-abd',    (state.abdLevel / 100) * 100);
    bar('bar-battery', state.batteryPct);
    bar('bar-cpu',     state.cpuLoad);

    // Fan circuit board card
    const fanCard = document.getElementById('comp-fan');
    const fanVal  = document.getElementById('mod-fan-val');
    if (fanCard && fanVal) {
        fanCard.classList.remove('comp-active', 'fan-fast', 'fan-slow');
        if (state.fanSpeed > 50) {
            fanCard.classList.add('comp-active', 'fan-fast');
            fanVal.textContent = 'HIGH';
        } else if (state.fanSpeed > 0) {
            fanCard.classList.add('comp-active', 'fan-slow');
            fanVal.textContent = 'LOW';
        } else {
            fanVal.textContent = 'OFF';
        }
    }

    // Burn Chamber circuit board card
    const burnCard = document.getElementById('comp-chamber');
    const burnVal  = document.getElementById('mod-chamber-val');
    if (burnCard && burnVal) {
        burnCard.classList.toggle('comp-alarm', state.burnChamber);
        burnVal.textContent = state.burnChamber ? '🔥 ACTIVE' : 'OFF';
    }

    // ABD board alarm highlight
    const abdCard = document.getElementById('tele-card-abd');
    if (abdCard) abdCard.classList.toggle('alarm', state.abdLevel > 50);
    const abdBoardCard = document.getElementById('comp-abd');
    if (abdBoardCard) {
        abdBoardCard.classList.toggle('comp-alarm', state.abdLevel > 50);
    }
}

// APS Specific UI updates (called after tickSimulation APS logic)
function updateAPSUI() {
    if (!isRunning) return;
    const setV = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const bar   = (id, pct) => { const el = document.getElementById(id); if (el) el.style.setProperty('--fill', Math.min(100, Math.max(0, pct)) + '%'); };

    // Determine status properties
    const statusMap = {
        'CLEAN AIR':    { emoji: '✅', color: '#3fb950', cls: 'aps-clean',    icon: 'green' },
        'MODERATE AIR': { emoji: '⚠️', color: '#d29922', cls: 'aps-moderate', icon: 'yellow' },
        'HARMFUL AIR':  { emoji: '☠️', color: '#f85149', cls: 'aps-harmful',  icon: 'red' }
    };
    const info = statusMap[state.apsStatus] || statusMap['CLEAN AIR'];

    // Update circuit board APS component
    const apsComp = document.getElementById('comp-aps');
    if (apsComp) {
        apsComp.classList.remove('aps-clean', 'aps-moderate', 'aps-harmful', 'comp-alarm');
        apsComp.classList.add(info.cls);
        if (state.apsStatus === 'HARMFUL AIR') apsComp.classList.add('comp-alarm');
    }
    setV('mod-aps-status', `${info.emoji} ${state.apsStatus}`);
    setV('mod-aps-eff',    `Eff: ${state.apsEfficiency.toFixed(1)}%`);

    // Update telemetry cards
    setV('tele-aps-pm',  `${state.apsPmOut.toFixed(1)} µg/m³`);
    setV('tele-aps-gas', state.apsGasLevel);
    setV('tele-aps-eff', `${state.apsEfficiency.toFixed(1)}%`);
    setV('tele-aps-status', state.apsStatus);

    // Update progress bars
    bar('bar-aps-pm',  (state.apsPmOut / 75) * 100);     // scale: 75 µg/m³ = 100%
    bar('bar-aps-eff',  state.apsEfficiency);              // direct percentage

    // Color-code the APS status telemetry card
    const statusCard = document.getElementById('tele-card-aps-status');
    if (statusCard) {
        statusCard.classList.remove('aps-tele-clean', 'aps-tele-moderate', 'aps-tele-harmful');
        statusCard.classList.add(`aps-tele-${info.cls.replace('aps-', '')}`);
    }

    // Update status badge
    const badge = document.getElementById('aps-status-badge');
    if (badge) {
        badge.textContent = `${info.emoji} ${state.apsStatus}`;
        badge.style.background = info.color + '22'; // 13% opacity
        badge.style.color       = info.color;
        badge.style.borderColor = info.color + '66';
    }

    // Filtration flow stage highlights
    for (let i = 1; i <= 5; i++) {
        const stage = document.getElementById(`fstage-${i}`);
        if (stage) {
            stage.classList.toggle('active', i <= state.apsStageProgress);
        }
    }

    // Gas level color for APS gas card
    const gasCard = document.getElementById('tele-card-aps-gas');
    if (gasCard) {
        gasCard.classList.remove('aps-tele-clean', 'aps-tele-moderate', 'aps-tele-harmful');
        if      (state.apsGasLevel === 'Low')      gasCard.classList.add('aps-tele-clean');
        else if (state.apsGasLevel === 'Moderate') gasCard.classList.add('aps-tele-moderate');
        else                                       gasCard.classList.add('aps-tele-harmful');
    }
}

// Hardware event tick emulation (runs 1Hz)
function tickSimulation() {
    const modeVal = envMode ? envMode.value : 'urban';
    const config = envConfigs[modeVal];
    if (!config) return;
    
    // Realistic Noise Injection
    state.pm25 += (Math.random() - 0.5) * 5 + (config.pm25Base - state.pm25) * 0.1;
    state.pms25 += (Math.random() - 0.5) * 4 + (config.pm25Base - state.pms25) * 0.12; // Pms5003 variation
    state.aqi = Math.max(0, Math.round(state.pm25 * 1.5 + (Math.random() * 10 - 5)));
    state.temp = 25 + config.tempMod + (Math.random() * 2 - 1);
    state.abdLevel += (config.toxBase - state.abdLevel) * 0.2 + (Math.random() * 5);
    
    // Simulating fan clearing air
    if (state.fanSpeed > 0) {
        state.pm25 *= 0.95; 
    }

    // IoT Module interactions & Logic mirror
    if (state.pm25 > 100) state.fanSpeed = 100;
    else if (state.pm25 > 50) state.fanSpeed = 50;
    else state.fanSpeed = 0;

    if (state.abdLevel > 50) {
        if (!state.burnChamber) {
            logSerial('EMERGENCY: Toxic Gas! Activating burn chamber.', 'err');
        }
        state.burnChamber = true;
    } else {
        state.burnChamber = false;
    }

    updateUI();

    // ── APS Multi-Stage Purification Logic ──
    const apsEffTarget = config.apsEffBase + (Math.random() * 6 - 3);
    // Efficiency degrades slightly as pollution rises, recovers slowly
    state.apsEfficiency += (apsEffTarget - state.apsEfficiency) * 0.15 + (Math.random() * 2 - 1);
    state.apsEfficiency  = Math.max(5, Math.min(99, state.apsEfficiency));

    // Post-filter PM output (what passes through all filtration stages)
    const rawPmOut = state.pm25 * (1 - state.apsEfficiency / 100);
    state.apsPmOut += (rawPmOut - state.apsPmOut) * 0.25 + (Math.random() * 0.8 - 0.4);
    state.apsPmOut  = Math.max(0, state.apsPmOut);

    // Gas level classification from ABD sensor
    if      (state.abdLevel < 20)  state.apsGasLevel = 'Low';
    else if (state.abdLevel < 55)  state.apsGasLevel = 'Moderate';
    else                           state.apsGasLevel = 'High';

    // APS Air Quality Classification
    const prevStatus = state.apsStatus;
    if (state.apsPmOut < 15 && state.apsGasLevel === 'Low') {
        state.apsStatus = 'CLEAN AIR';
    } else if (state.apsPmOut < 50 && state.apsGasLevel !== 'High') {
        state.apsStatus = 'MODERATE AIR';
    } else {
        state.apsStatus = 'HARMFUL AIR';
        // Trigger ABD thermal oxidation on HARMFUL status
        if (!state.burnChamber && prevStatus !== 'HARMFUL AIR') {
            logSerial('APS ALERT: HARMFUL AIR detected! Triggering ABD thermal oxidation.', 'err');
        }
        state.burnChamber = true;
    }

    // Filtration stage animation (progress 1-5 based on efficiency)
    state.apsStageProgress = Math.max(1, Math.round((state.apsEfficiency / 100) * 5));

    updateAPSUI();

    // System Simulation Logic
    state.cpuLoad = 2.0 + (Math.random() * 5); // OS Idle Load
    if (cloudSyncCounter === 0) { // Spike during Cloud Sync
        state.cpuLoad += 45 + (Math.random() * 20);
        state.heapFree -= (Math.random() * 10); // JSON buffering
    } else {
        state.heapFree += (244 - state.heapFree) * 0.1; // "GC" cleanup
    }
    state.wdogKicked = true; // Auto-kick for now

    cloudSyncCounter++;
    if (cloudSyncCounter >= 5) {
        transmitData();
        cloudSyncCounter = 0;
    }
}

// Wire color per component type
const wireColors = {
    'comp-sps30': '#58a6ff', 'comp-mq135': '#58a6ff',
    'comp-dht22': '#58a6ff', 'comp-abd':   '#f85149',
    'comp-gps':   '#d29922', 'comp-wifi':  '#d29922',
    'comp-gsm':   '#d29922', 'comp-power': '#3fb950',
    'comp-fan':   '#4a90d9', 'comp-chamber': '#f85149',
    'comp-lcd':   '#a5d6ff', 'comp-pms5003': '#58a6ff',
    'comp-aps':   '#00d4ff'
};

function drawWires() {
    const board = document.querySelector('.board') || document.querySelector('.gallery-board');
    const svg   = document.getElementById('wiring-layer');
    if (!board || !svg) return;
    svg.innerHTML = '';

    const mcu   = document.getElementById('comp-esp32');
    if (!mcu) return;
    const br    = board.getBoundingClientRect();
    const mr    = mcu.getBoundingClientRect();
    const mx    = (mr.left + mr.width / 2) - br.left;
    const my    = (mr.top + mr.height / 2) - br.top;

    const targets = ['comp-lcd','comp-sps30','comp-mq135','comp-dht22',
                     'comp-abd','comp-gps','comp-wifi','comp-gsm',
                     'comp-power','comp-fan','comp-chamber', 'comp-pms5003', 'comp-aps'];

    targets.forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.offsetParent === null) return; // Skip hidden
        const er = el.getBoundingClientRect();
        const ex = (er.left + er.width / 2) - br.left;
        const ey = (er.top + er.height / 2) - br.top;

        const color = wireColors[id] || '#555';
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        
        line.setAttribute('x1', mx); line.setAttribute('y1', my);
        line.setAttribute('x2', ex); line.setAttribute('y2', ey);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', isRunning ? '2.5' : '1.5');
        line.setAttribute('stroke-opacity', isRunning ? '1' : '0.5');
        
        if (isRunning) {
            line.setAttribute('stroke-dasharray', '5,5');
            line.style.animation = 'dash 10s linear infinite';
        } else {
            line.setAttribute('stroke-dasharray', '2,4');
        }
        
        svg.appendChild(line);
    });
}
window.addEventListener('resize', drawWires);
setTimeout(drawWires, 100);  // draw after DOM layout settles

// Emulated Communication Module (WiFi/MQTT Stack Post)
let mqttClient = null;

async function transmitData() {
    const endpoint = apiUrlInput.value.trim();
    if (!endpoint) return;

    const payload = {
        device: "ZENAB_TREE_01",
        pm25: Number(state.pm25.toFixed(2)),
        pm25_pms: Number(state.pms25.toFixed(2)),
        aqi: state.aqi,
        temperature: Number(state.temp.toFixed(2)),
        humidity: Number(state.humidity.toFixed(2)),
        oxygen: Number(state.oxygen.toFixed(2)),
        latitude: state.lat,
        longitude: state.lon,
        power: state.powerSource,
        status: state.burnChamber ? 'emergency' : (state.fanSpeed > 0 ? 'purifying' : 'idle'),
        // APS telemetry data
        aps_pm_out: Number(state.apsPmOut.toFixed(2)),
        aps_gas_level: state.apsGasLevel,
        aps_efficiency: Number(state.apsEfficiency.toFixed(1)),
        aps_status: state.apsStatus
    };

    try {
        if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://') || endpoint.startsWith('mqtt://')) {
            // MQTT Transmission — only reconnect if URL changed or client gone
            if (!mqttClient || mqttEndpoint !== endpoint) {
                if (mqttClient) mqttClient.end(true);
                mqttEndpoint = endpoint;
                logSerial(`[MQTT] Connecting to ${endpoint}...`);
                mqttClient = mqtt.connect(endpoint);
                mqttClient.on('connect', () => logSerial(`[MQTT] Connected ✓`, 'ok'));
                mqttClient.on('error',   (err) => logSerial(`[MQTT ERR] ${err.message}`, 'err'));
            }

            if (mqttClient.connected) {
                logSerial(`[MQTT] Publishing to topic zenab/data...`);
                mqttClient.publish('zenab/data', JSON.stringify(payload));
                logSerial(`[MQTT OK] DATA SENT TO CLOUD`, 'ok');
                logSerial(`AQI=${state.aqi} STATUS=${payload.status.toUpperCase()}`, 'ok');
                document.getElementById('lcd-net').textContent = 'MQTT ✓';
                cloudStatusText.textContent = 'MQTT Sync ✓';
                cloudStatusText.className = 'online';
            } else {
                throw new Error("MQTT Client not connected yet");
            }
        } else {
            // HTTP Transmission
            logSerial(`[HTTP] Transmitting to Cloud API...`);
            
            // Simple fetch POST to target API, CORS issues might appear depending on destination
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                mode: 'cors', 
                body: JSON.stringify(payload)
            }).catch(e => { throw new Error('Network error'); });

            logSerial(`[HTTP OK] DATA SENT TO CLOUD`, 'ok');
            logSerial(`AQI=${state.aqi} STATUS=${payload.status.toUpperCase()}`, 'ok');
            document.getElementById('lcd-net').textContent = 'HTTP ✓';
            cloudStatusText.textContent = 'HTTP Sync ✓';
            cloudStatusText.className = 'online';
        }
    } catch (err) {
        logSerial(`[CLOUD FAIL] ${err.message}`, 'warn');
        logSerial(`GSM FALLBACK active.`, 'err');
        document.getElementById('lcd-net').textContent = 'GSM ↩';
        cloudStatusText.textContent = 'Fail – GSM backup';
        cloudStatusText.className = 'offline';
    }
}

// Attach Event Observers
if (btnRun) {
    btnRun.addEventListener('click', () => {
        if (isRunning) return;
        isRunning = true;
        logSerial('ZENAB SYSTEM ONLINE', 'ok');
        logSerial('WIFI CONNECTED', 'ok');
        logSerial('GPS LOCKED', 'ok');
        const runLed = ledEl(); if (runLed) runLed.classList.add('active');
        const gpsLcd = document.getElementById('lcd-gps');
        if (gpsLcd) gpsLcd.textContent = 'ACTIVE';
        const netLcd = document.getElementById('lcd-net');
        if (netLcd) netLcd.textContent = 'CONNECTING...';
        drawWires();
        simInterval = setInterval(tickSimulation, 1000);
    });
}

if (btnPause) {
    btnPause.addEventListener('click', () => {
        isRunning = false;
        clearInterval(simInterval);
        logSerial('Simulation PAUSED', 'warn');
        const pauseLed = ledEl(); if (pauseLed) pauseLed.classList.remove('active');
        drawWires();
    });
}

if (btnReset) {
    btnReset.addEventListener('click', () => {
        isRunning = false;
        clearInterval(simInterval);
        const config = envMode ? envConfigs[envMode.value] : envConfigs['urban'];
        state.pm25 = config.pm25Base;
        state.pms25 = config.pm25Base;
        state.aqi = config.aqiBase;
        state.abdLevel = config.toxBase;
        state.fanSpeed = 0;
        state.burnChamber = false;
        cloudSyncCounter = 0;
        
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setVal('lcd-aqi', '–');
        setVal('lcd-pm25', '–');
        setVal('lcd-o2', '–');
        setVal('mod-pm25', '–');
        setVal('mod-gas', '–');
        setVal('mod-temp', '–');
        setVal('mod-abd', '–');
        setVal('mod-pms5003', '–');
        setVal('mod-fan-val', 'OFF');
        setVal('mod-chamber-val', 'OFF');
        setVal('mod-power', 'Solar 100%');
        
        ['bar-pm25','bar-gas','bar-abd'].forEach(id => { const el = document.getElementById(id); if(el) el.style.setProperty('--fill','5%'); });
        const batBar = document.getElementById('bar-battery');
        if (batBar) batBar.style.setProperty('--fill','100%');

        const led = ledEl(); if (led) led.classList.remove('active');
        setVal('lcd-gps', 'WAIT');
        setVal('lcd-net', 'DISCONNECTED');
        if (cloudStatusText) {
            cloudStatusText.className = 'offline';
            cloudStatusText.textContent = 'Offline';
        }
        
        if (terminal) {
            terminal.innerHTML = '<div>&gt; ZENAB IDE Initialized.</div><div>&gt; Ready for simulation.</div>';
        }
        drawWires();
    });
}

// Update dashboard link based on API URL
function updateDashboardLink() {
    const url = apiUrlInput.value.trim();
    const dashLink = document.getElementById('dashboard-link');
    if (dashLink && url.startsWith('http')) {
        try {
            const origin = new URL(url).origin;
            dashLink.href = origin;
        } catch (e) {
            dashLink.href = "#";
        }
    } else if (dashLink) {
        dashLink.href = "#";
    }
}

if (apiUrlInput) apiUrlInput.addEventListener('input', updateDashboardLink);
window.addEventListener('load', updateDashboardLink);

if (envMode) {
    envMode.addEventListener('change', () => {
        logSerial(`Environment changed to: ${envMode.options[envMode.selectedIndex].text}`);
        if (!isRunning) {
            const config = envConfigs[envMode.value];
            state.pm25 = config.pm25Base;
            state.aqi = config.aqiBase;
            updateUI();
        }
    });
}

// Per-Component Code Selection Logic
function switchFile(id) {
    if (!editor) return; // Skip if no editor present (gallery page)
    // 1. Save current content
    virtualFS[currentFileId] = editor.getValue();
    
    // 2. Update Selection UI
    document.querySelectorAll('.comp').forEach(c => c.classList.remove('comp-selected'));
    const selectedComp = document.getElementById(id);
    if (selectedComp) selectedComp.classList.add('comp-selected');
    
    // 3. Load next content
    currentFileId = id;
    currentFileHeader.textContent = fileNames[id] || 'unknown.c';
    editor.setValue(virtualFS[id] || `// Driver for ${id}\nvoid init() {\n\n}`);
    
    logSerial(`Switched to: ${fileNames[id]}`, 'idx');
}

// Global Save Logic
function saveCode() {
    virtualFS[currentFileId] = editor.getValue();
    saveIndicator.textContent = 'Saving...';
    saveIndicator.className = 'save-indicator working';
    
    setTimeout(() => {
        saveIndicator.textContent = 'Hardware Updated ✓';
        saveIndicator.className = 'save-indicator success';
        logSerial(`FIRMWARE UPDATED: ${fileNames[currentFileId]} flashed to device.`, 'ok');
        
        // Brief spike in CPU load for "flashing"
        state.cpuLoad += 30;
        updateUI();

        setTimeout(() => {
            saveIndicator.textContent = 'Ready';
            saveIndicator.className = 'save-indicator';
        }, 3000);
    }, 800);
}

// Add click listeners to canvas components
const compRoots = document.querySelectorAll('.comp');
if (compRoots.length > 0) {
    compRoots.forEach(comp => {
        comp.addEventListener('click', (e) => {
            // Only switch file if in IDE (where editor exists)
            if (editor) switchFile(comp.id);
        });
    });
}

if (btnSaveCode) btnSaveCode.addEventListener('click', saveCode);

// Starting routine
updateUI();
if (document.getElementById('comp-esp32') && codeTextArea) {
    switchFile('main'); // Initial load
}

// ═══════════════════════════════════════════════════════
//  MAXIMIZE / EXPAND FEATURE
// ═══════════════════════════════════════════════════════

const modalOverlay  = document.getElementById('comp-modal-overlay');
const modalBody     = document.getElementById('modal-body');
const modalTitle    = document.getElementById('modal-comp-title');
const modalIcon     = document.getElementById('modal-comp-icon');
const modalPinLabel = document.getElementById('modal-pin-label');
const modalCloseBtn = document.getElementById('modal-close-btn');

let activeModalComp   = null;   // currently maximized component id
let modalRefreshTimer = null;   // setInterval handle for live refresh

// ── Per-component metadata & telemetry builder ──────────────────────────────
const compMeta = {
    'comp-esp32': {
        title: 'Arduino UNO',
        icon: 'fa-solid fa-microchip',
        iconColor: '#4a90d9',
        pin: 'ATmega328P · Core',
        buildTelemetry: () => [
            { label: 'CPU Load',      icon: 'fa-solid fa-gauge',       value: `${state.cpuLoad.toFixed(1)} %`,   accent: state.cpuLoad > 60 ? 'red' : 'green',  bar: state.cpuLoad,          barClass: state.cpuLoad > 60 ? 'bar-red' : 'bar-green' },
            { label: 'Heap Free',     icon: 'fa-solid fa-memory',      value: `${state.heapFree.toFixed(0)} KB`, accent: 'blue',  bar: (state.heapFree / 244) * 100, barClass: 'bar-green' },
            { label: 'Watchdog',      icon: 'fa-solid fa-clock-rotate-left', value: state.wdogKicked ? 'KICKED ✓' : '⚠ STALE', accent: state.wdogKicked ? 'green' : 'red' },
            { label: 'AQI (LCD)',     icon: 'fa-solid fa-chart-line',  value: state.aqi,                          accent: state.aqi > 200 ? 'red' : state.aqi > 100 ? 'yellow' : 'green', bar: (state.aqi / 400) * 100, barClass: state.aqi > 200 ? 'bar-red' : 'bar-yellow' },
        ]
    },
    'comp-sps30': {
        title: 'SPS30 – PM Sensor',
        icon: 'fa-solid fa-wind',
        iconColor: '#58a6ff',
        pin: 'I2C · Pins 21, 22',
        buildTelemetry: () => [
            { label: 'PM2.5',         icon: 'fa-solid fa-wind',        value: `${state.pm25.toFixed(1)} µg/m³`,  accent: state.pm25 > 100 ? 'red' : state.pm25 > 50 ? 'yellow' : 'blue', bar: (state.pm25 / 300) * 100, barClass: state.pm25 > 100 ? 'bar-red' : 'bar-yellow' },
            { label: 'AQI (derived)', icon: 'fa-solid fa-chart-bar',   value: `${state.aqi}`,                    accent: state.aqi > 200 ? 'red' : 'blue', bar: (state.aqi / 400) * 100, barClass: 'bar-yellow' },
        ]
    },
    'comp-pms5003': {
        title: 'PMS5003 – PM Sensor',
        icon: 'fa-solid fa-microchip',
        iconColor: '#58a6ff',
        pin: 'UART · Pins 27, 26',
        buildTelemetry: () => [
            { label: 'PM2.5 (PMS)', icon: 'fa-solid fa-wind',  value: `${state.pms25.toFixed(1)} µg/m³`, accent: state.pms25 > 100 ? 'red' : 'blue', bar: (state.pms25 / 300) * 100, barClass: 'bar-yellow' },
        ]
    },
    'comp-mq135': {
        title: 'MQ135 – Gas Sensor',
        icon: 'fa-solid fa-smog',
        iconColor: '#d29922',
        pin: 'ADC · Pin 34',
        buildTelemetry: () => {
            const ppm = (state.abdLevel * 2.5).toFixed(0);
            return [
                { label: 'Gas / VOC (ppm)', icon: 'fa-solid fa-smog', value: `${ppm} ppm`, accent: state.abdLevel > 50 ? 'red' : state.abdLevel > 20 ? 'yellow' : 'green', bar: (state.abdLevel / 100) * 100, barClass: state.abdLevel > 50 ? 'bar-red' : 'bar-yellow' },
                { label: 'APS Gas Level', icon: 'fa-solid fa-flask', value: state.apsGasLevel, accent: state.apsGasLevel === 'High' ? 'red' : state.apsGasLevel === 'Moderate' ? 'yellow' : 'green' },
            ];
        }
    },
    'comp-dht22': {
        title: 'DHT22 – Temp / Humidity',
        icon: 'fa-solid fa-temperature-half',
        iconColor: '#db7b19',
        pin: 'GPIO · Pin 4',
        buildTelemetry: () => [
            { label: 'Temperature', icon: 'fa-solid fa-thermometer-half', value: `${state.temp.toFixed(1)} °C`, accent: state.temp > 35 ? 'red' : 'orange' },
            { label: 'Humidity',    icon: 'fa-solid fa-droplet',          value: `${state.humidity.toFixed(0)} %RH`, accent: 'blue' },
        ]
    },
    'comp-abd': {
        title: 'ABD – Toxic Gas Chamber',
        icon: 'fa-solid fa-skull-crossbones',
        iconColor: '#f85149',
        pin: 'ADC · Pin 35',
        buildTelemetry: () => [
            { label: 'Toxic Level', icon: 'fa-solid fa-biohazard',  value: state.abdLevel > 50 ? '⚠ TOXIC' : 'Safe', accent: state.abdLevel > 50 ? 'red' : 'green', bar: (state.abdLevel / 100) * 100, barClass: 'bar-red' },
            { label: 'Raw ABD',     icon: 'fa-solid fa-gauge-high', value: `${state.abdLevel.toFixed(1)}`,           accent: state.abdLevel > 50 ? 'red' : 'yellow' },
            { label: 'Burn Chamber', icon: 'fa-solid fa-fire-burner', value: state.burnChamber ? '🔥 ACTIVE' : 'STANDBY', accent: state.burnChamber ? 'red' : 'green' },
        ]
    },
    'comp-gps': {
        title: 'GPS NEO-6M',
        icon: 'fa-solid fa-location-dot',
        iconColor: '#3fb950',
        pin: 'UART · Pins 16, 17',
        buildTelemetry: () => [
            { label: 'Latitude',  icon: 'fa-solid fa-map-pin',        value: state.lat.toFixed(6),  accent: 'green' },
            { label: 'Longitude', icon: 'fa-solid fa-map-pin',        value: state.lon.toFixed(6),  accent: 'green' },
            { label: 'Fix',       icon: 'fa-solid fa-satellite-dish', value: isRunning ? 'LOCKED ✓' : '– NO FIX', accent: isRunning ? 'green' : 'yellow' },
        ]
    },
    'comp-wifi': {
        title: 'ESP8266 – WiFi Module',
        icon: 'fa-solid fa-wifi',
        iconColor: '#d29922',
        pin: 'UART · SoftSerial',
        buildTelemetry: () => [
            { label: 'Status',    icon: 'fa-solid fa-wifi',           value: isRunning ? '📡 TX Active' : 'IDLE', accent: isRunning ? 'green' : 'yellow' },
            { label: 'Protocol',  icon: 'fa-solid fa-tower-broadcast', value: 'MQTT / HTTP',                      accent: 'blue' },
            { label: 'Cloud',     icon: 'fa-solid fa-cloud',          value: isRunning ? 'Transmitting' : 'Offline', accent: isRunning ? 'green' : 'red' },
        ]
    },
    'comp-fan': {
        title: 'Smart Fan – PWM Actuator',
        icon: 'fa-solid fa-fan',
        iconColor: '#58a6ff',
        pin: 'PWM · Pin 18',
        buildTelemetry: () => [
            { label: 'Speed',    icon: 'fa-solid fa-fan',      value: state.fanSpeed > 50 ? 'HIGH (100%)' : state.fanSpeed > 0 ? 'LOW (50%)' : 'OFF', accent: state.fanSpeed > 50 ? 'blue' : state.fanSpeed > 0 ? 'yellow' : 'green' },
            { label: 'PWM Duty', icon: 'fa-solid fa-gauge',    value: `${state.fanSpeed} %`, accent: 'blue', bar: state.fanSpeed, barClass: 'bar-green' },
        ]
    },
    'comp-chamber': {
        title: 'Burn Chamber – Actuator',
        icon: 'fa-solid fa-fire-burner',
        iconColor: '#f85149',
        pin: 'GPIO · Pin 19',
        buildTelemetry: () => [
            { label: 'Chamber State', icon: 'fa-solid fa-fire', value: state.burnChamber ? '🔥 ACTIVE' : 'OFF', accent: state.burnChamber ? 'red' : 'green' },
            { label: 'Triggered By',  icon: 'fa-solid fa-triangle-exclamation', value: state.burnChamber ? 'APS / ABD Alarm' : 'None', accent: state.burnChamber ? 'red' : 'green' },
        ]
    },
    'comp-power': {
        title: 'Power Management (Solar)',
        icon: 'fa-solid fa-solar-panel',
        iconColor: '#3fb950',
        pin: 'VIN · ADC Pin 32',
        buildTelemetry: () => [
            { label: 'Source',  icon: 'fa-solid fa-solar-panel', value: state.powerSource === 'solar' ? '☀ Solar' : '🔋 Battery', accent: 'green' },
            { label: 'Battery', icon: 'fa-solid fa-battery-full', value: `${state.batteryPct.toFixed(0)} %`, accent: state.batteryPct < 20 ? 'red' : 'green', bar: state.batteryPct, barClass: 'bar-green' },
        ]
    },
    'comp-gsm': {
        title: 'SIM900A – GSM Module',
        icon: 'fa-solid fa-tower-broadcast',
        iconColor: '#d29922',
        pin: 'UART · GSM',
        buildTelemetry: () => [
            { label: 'Status',   icon: 'fa-solid fa-signal',    value: state.burnChamber ? '⚠ ALERT TX' : 'Standby', accent: state.burnChamber ? 'red' : 'yellow' },
            { label: 'Fallback', icon: 'fa-solid fa-retweet',   value: 'GSM 2G Backup',                               accent: 'yellow' },
        ]
    },
    'comp-aps': {
        title: 'APS – Air Purification Sensor',
        icon: 'fa-solid fa-lungs',
        iconColor: '#00d4ff',
        pin: 'I2C/ADC · A0, A1',
        buildTelemetry: () => {
            const statusColors = { 'CLEAN AIR': { accent: 'green', pillBg: '#3fb950', barC: 'bar-green' }, 'MODERATE AIR': { accent: 'yellow', pillBg: '#d29922', barC: 'bar-yellow' }, 'HARMFUL AIR': { accent: 'red', pillBg: '#f85149', barC: 'bar-red' } };
            const sc = statusColors[state.apsStatus] || statusColors['CLEAN AIR'];
            return [
                { label: 'Air Quality Status',     icon: 'fa-solid fa-shield-halved', value: state.apsStatus,                        accent: sc.accent },
                { label: 'Purification Efficiency',icon: 'fa-solid fa-gauge-high',    value: `${state.apsEfficiency.toFixed(1)} %`,  accent: 'cyan', bar: state.apsEfficiency, barClass: 'bar-cyan' },
                { label: 'PM2.5 Post-Filter',      icon: 'fa-solid fa-wind',          value: `${state.apsPmOut.toFixed(1)} µg/m³`,  accent: state.apsPmOut > 50 ? 'red' : state.apsPmOut > 15 ? 'yellow' : 'cyan', bar: (state.apsPmOut / 75) * 100, barClass: sc.barC },
                { label: 'VOC / Gas Level',        icon: 'fa-solid fa-smog',          value: state.apsGasLevel,                     accent: state.apsGasLevel === 'High' ? 'red' : state.apsGasLevel === 'Moderate' ? 'yellow' : 'green' },
                { label: 'Filtration Stages Active', icon: 'fa-solid fa-filter',     value: `${state.apsStageProgress} / 5`,        accent: 'cyan', bar: (state.apsStageProgress / 5) * 100, barClass: 'bar-cyan' },
            ];
        }
    }
};

// ── Modal renderer ──────────────────────────────────────────────────────────
function buildModalBody(compId) {
    const meta = compMeta[compId];
    if (!meta) return;

    const tele = meta.buildTelemetry();
    
    let leftColHtml = `
        <div class="modal-tele-section-title"><i class="fa-solid fa-chart-line" style="margin-right:8px"></i>Live Diagnostic Telemetry</div>
        <div class="modal-tele-grid">`;

    tele.forEach(row => {
        const barHtml = row.bar !== undefined
            ? `<div class="modal-bar-wrap"><div class="modal-bar-fill ${row.barClass || ''}" style="width:${Math.min(100, Math.max(0, row.bar)).toFixed(1)}%"></div></div>`
            : '';
        leftColHtml += `
            <div class="modal-tele-row accent-${row.accent || 'blue'}">
                <div class="modal-tele-label">
                    <i class="${row.icon}"></i>
                    ${row.label}
                </div>
                <div class="modal-tele-value">${row.value}</div>
                ${barHtml}
            </div>`;
    });
    leftColHtml += `</div>`;

    // Driver code snippet
    const driverCode = (virtualFS[compId] || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    let rightColHtml = `
        <div class="modal-tele-section-title"><i class="fa-solid fa-code" style="margin-right:8px"></i>Firmware Driver Integration</div>
        <div class="modal-code-block">${driverCode.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        <div style="margin-top:15px; font-size: 0.75rem; color: var(--muted); background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
            <i class="fa-solid fa-info-circle" style="color: var(--blue); margin-right: 6px;"></i>
            This component operates as an autonomous node in the Zenab RTOS environment, processing at 1Hz frequency.
        </div>
    `;

    modalBody.innerHTML = `
        <div class="modal-details-grid">
            <div class="modal-left-col">${leftColHtml}</div>
            <div class="modal-right-col">${rightColHtml}</div>
        </div>
    `;
}

// ── Open / close ─────────────────────────────────────────────────────────────
function openModal(compId) {
    const meta = compMeta[compId];
    if (!meta) return;
    activeModalComp = compId;

    // Header
    modalIcon.className     = meta.icon;
    modalIcon.style.color   = meta.iconColor;
    modalTitle.textContent  = meta.title;
    modalPinLabel.textContent = meta.pin;

    // Body
    buildModalBody(compId);

    // Show
    modalOverlay.classList.add('modal-open');

    // Live refresh every 1 s
    clearInterval(modalRefreshTimer);
    modalRefreshTimer = setInterval(() => {
        if (activeModalComp) buildModalBody(activeModalComp);
    }, 1000);
}

function closeModal() {
    modalOverlay.classList.remove('modal-open');
    clearInterval(modalRefreshTimer);
    activeModalComp = null;
}

// ── Event wiring ─────────────────────────────────────────────────────────────
// Close button
modalCloseBtn.addEventListener('click', closeModal);

// Click outside modal card
modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
});

// ESC key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeModalComp) closeModal();
});

// Delegate maximize button clicks
const clickRoot = document.querySelector('.board') || document.querySelector('.gallery-grid');
if (clickRoot) {
    clickRoot.addEventListener('click', (e) => {
        const btn = e.target.closest('.comp-maximize-btn');
        if (!btn) return;
        e.stopPropagation();          
        const compId = btn.dataset.comp;
        if (compId) openModal(compId);
    });
}

}; // end window.onload

