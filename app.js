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

// Initialize CodeMirror Editor
const editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    mode: "text/x-csrc",
    theme: "dracula",
    lineNumbers: true,
    readOnly: false // Allows user to type or modify
});
editor.setValue(cCodeTemplate);

// DOM Elements Mapping
const btnRun = document.getElementById('btn-run');
const btnPause = document.getElementById('btn-pause');
const btnReset = document.getElementById('btn-reset');
const envMode = document.getElementById('env-mode');
const apiUrlInput = document.getElementById('api-url');
const terminal = document.getElementById('terminal-output');
const cloudStatusText = document.getElementById('cloud-status-text');
const currentFileHeader = document.getElementById('current-filename');
const btnSaveCode = document.getElementById('btn-save-code');
const saveIndicator = document.getElementById('save-indicator');

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
    'comp-power': `// Power Management\nvoid readBattery() {\n  float v = analogRead(32) * (3.3/4095.0) * 2;\n}`
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
    'comp-power': 'pow_mgmt.c'
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
    wdogKicked: true
};

// Mode specific baseline parameters
const envConfigs = {
    clean: { pm25Base: 15, aqiBase: 40, tempMod: 0, toxBase: 0 },
    urban: { pm25Base: 65, aqiBase: 120, tempMod: +2, toxBase: 10 },
    industrial: { pm25Base: 150, aqiBase: 210, tempMod: +5, toxBase: 35 },
    toxic: { pm25Base: 300, aqiBase: 400, tempMod: +10, toxBase: 90 }
};

// Logging standard console equivalent
function logSerial(msg, type = '') {
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
    document.getElementById('lcd-aqi').textContent  = state.aqi;
    document.getElementById('lcd-pm25').textContent = state.pm25.toFixed(1);
    document.getElementById('lcd-o2').textContent   = state.oxygen.toFixed(1);

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

// Hardware event tick emulation (runs 1Hz)
function tickSimulation() {
    const config = envConfigs[envMode.value];
    
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
    'comp-lcd':   '#a5d6ff', 'comp-pms5003': '#58a6ff'
};

function drawWires() {
    const board = document.querySelector('.board');
    const svg   = document.getElementById('wiring-layer');
    if (!board || !svg) return;
    svg.innerHTML = '';

    const mcu   = document.getElementById('comp-esp32');
    if (!mcu) return;
    const br    = board.getBoundingClientRect();
    const mr    = mcu.getBoundingClientRect();
    const mx    = mr.left + mr.width  / 2 - br.left;
    const my    = mr.top  + mr.height / 2 - br.top;

    const targets = ['comp-lcd','comp-sps30','comp-mq135','comp-dht22',
                     'comp-abd','comp-gps','comp-wifi','comp-gsm',
                     'comp-power','comp-fan','comp-chamber', 'comp-pms5003'];

    targets.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const er = el.getBoundingClientRect();
        const ex = er.left + er.width  / 2 - br.left;
        const ey = er.top  + er.height / 2 - br.top;

        const color = wireColors[id] || '#555';
        const dash  = isRunning ? '' : '6,4';

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', mx); line.setAttribute('y1', my);
        line.setAttribute('x2', ex); line.setAttribute('y2', ey);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-opacity', '0.55');
        if (dash) line.setAttribute('stroke-dasharray', dash);
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
        status: state.burnChamber ? 'emergency' : (state.fanSpeed > 0 ? 'purifying' : 'idle')
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
btnRun.addEventListener('click', () => {
    if (isRunning) return;
    isRunning = true;
    logSerial('ZENAB SYSTEM ONLINE', 'ok');
    logSerial('WIFI CONNECTED', 'ok');
    logSerial('GPS LOCKED', 'ok');
    const runLed = ledEl(); if (runLed) runLed.classList.add('active');
    document.getElementById('lcd-gps').textContent = 'ACTIVE';
    document.getElementById('lcd-net').textContent = 'CONNECTING...';
    drawWires();
    simInterval = setInterval(tickSimulation, 1000);
});

btnPause.addEventListener('click', () => {
    isRunning = false;
    clearInterval(simInterval);
    logSerial('Simulation PAUSED', 'warn');
    const pauseLed = ledEl(); if (pauseLed) pauseLed.classList.remove('active');
    drawWires();
});

btnReset.addEventListener('click', () => {
    isRunning = false;
    clearInterval(simInterval);
    const config = envConfigs[envMode.value];
    state.pm25 = config.pm25Base;
    state.pms25 = config.pm25Base;
    state.aqi = config.aqiBase;
    state.abdLevel = config.toxBase;
    state.fanSpeed = 0;
    state.burnChamber = false;
    cloudSyncCounter = 0;
    
    document.getElementById('lcd-aqi').textContent = '–';
    document.getElementById('lcd-pm25').textContent = '–';
    document.getElementById('lcd-o2').textContent = '–';
    document.getElementById('mod-pm25').textContent = '–';
    document.getElementById('mod-gas').textContent = '–';
    document.getElementById('mod-temp').textContent = '–';
    document.getElementById('mod-abd').textContent = '–';
    document.getElementById('mod-pms5003').textContent = '–';
    document.getElementById('mod-fan-val').textContent = 'OFF';
    document.getElementById('mod-chamber-val').textContent = 'OFF';
    document.getElementById('mod-power').textContent = 'Solar 100%';
    ['bar-pm25','bar-gas','bar-abd'].forEach(id => { const el = document.getElementById(id); if(el) el.style.setProperty('--fill','5%'); });
    document.getElementById('bar-battery').style.setProperty('--fill','100%');

    const led = ledEl(); if (led) led.classList.remove('active');
    document.getElementById('lcd-gps').textContent = 'WAIT';
    document.getElementById('lcd-net').textContent = 'DISCONNECTED';
    cloudStatusText.className = 'offline';
    cloudStatusText.textContent = 'Offline';
    
    terminal.innerHTML = '<div>&gt; ZENAB IDE Initialized.</div><div>&gt; Ready for simulation.</div>';
    drawWires();
});

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

apiUrlInput.addEventListener('input', updateDashboardLink);
window.addEventListener('load', updateDashboardLink);

envMode.addEventListener('change', () => {
    logSerial(`Environment changed to: ${envMode.options[envMode.selectedIndex].text}`);
    if (!isRunning) {
        const config = envConfigs[envMode.value];
        state.pm25 = config.pm25Base;
        state.aqi = config.aqiBase;
        updateUI();
    }
});

// Per-Component Code Selection Logic
function switchFile(id) {
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
document.querySelectorAll('.comp').forEach(comp => {
    comp.addEventListener('click', () => {
        switchFile(comp.id);
    });
});

btnSaveCode.addEventListener('click', saveCode);

// Starting routine
updateUI();
switchFile('main'); // Initial load
};
