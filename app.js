const cCodeTemplate = `// ==========================================
// FILE: main.c
// ZENAB AI Outdoor Air Purification
// IoT Digital Twin Firmware
// ==========================================
#include <WiFi.h>
#include <PubSubClient.h>
#include "sensor_manager.h"
#include "communication.h"
#include "gps_module.h"
#include "power_system.h"
#include "control_logic.h"
#include "cloud_sync.h"

void setup() {
    Serial.begin(115200);
    initPowerSystem();
    initializeSensors();
    connectWiFi();
    initGPS();
    Serial.println("ZENAB SYSTEM ONLINE");
}

void loop() {
    readAllSensorsEvery1Sec();
    calculateAQI();
    runControlLogic();
    transmitDataCloud();
    delay(1000); 
}

// ==========================================
// FILE: control_logic.c
// ==========================================
#include "control_logic.h"
#include "sensor_manager.h"
#include "communication.h"

#define FAN_PIN 18
#define HEATER_PIN 19
#define BUZZER_PIN 21

void runControlLogic() {
    if (currentData.pm25 > 100) {
        increaseFanSpeed(); 
    }
    
    // ABD toxic gas check
    if (currentData.abdTriggered) {
        activateBurnChamber();
        sendEmergencyAlert();
    }

    // APS pollution pattern optimization
    if (currentData.apsPatternDetected) {
        optimizeAirflow();
    }
}

// ==========================================
// FILE: sensor_manager.c
// ==========================================
// Implements SPS30, MQ135, DHT22, ABD, APS
// ...

// ==========================================
// FILE: communication.c
// ==========================================
// Handles fallback logic: WiFi -> GSM -> BLE
// ...

// ==========================================
// FILE: cloud_sync.c
// ==========================================
// Transmits JSON to HTTP/MQTT endpoints
// ...

// ==========================================
// FILE: gps_module.c
// ==========================================
// Interacts with NEO-6M to fetch coords
// ...

// ==========================================
// FILE: power_system.c
// ==========================================
// Simulates Solar + Battery state
// ...
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
    lat: 12.9716,
    lon: 77.5946
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
    setV('mod-power', powerStr);
    setV('mod-wifi', '📡 TX');
    setV('mod-gsm',  state.burnChamber ? '⚠ Alert' : 'Standby');
    // Telemetry pane values
    setV('tele-pm25',  pm25Str);
    setV('tele-gas',   gasStr);
    setV('tele-temp',  tempStr);
    setV('tele-abd',   state.abdLevel > 50 ? '⚠ TOXIC DETECTED' : 'Safe');
    setV('tele-power', powerStr);
    setV('tele-fan',   state.fanSpeed > 50 ? 'HIGH (PWM 100%)' : state.fanSpeed > 0 ? 'LOW (PWM 50%)' : 'OFF');
    setV('tele-burn',  state.burnChamber ? '🔥 ACTIVE' : 'OFF');
    setV('tele-gps',   `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`);

    // Progress bars
    const bar = (id, pct) => { const el = document.getElementById(id); if (el) el.style.setProperty('--fill', Math.min(100, pct) + '%'); };
    bar('bar-pm25',   (state.pm25 / 300) * 100);
    bar('bar-gas',    (state.abdLevel / 100) * 100);
    bar('bar-abd',    (state.abdLevel / 100) * 100);
    bar('bar-battery', state.batteryPct);

    // Fan circuit board card
    const fanCard = document.getElementById('comp-fan');
    const fanVal  = document.getElementById('mod-fan-val');
    if (fanCard && fanVal) {
        if (state.fanSpeed > 50) { fanCard.className = 'comp comp-act act-fan comp-active fan-fast'; fanVal.textContent = 'HIGH'; }
        else if (state.fanSpeed > 0) { fanCard.className = 'comp comp-act act-fan comp-active fan-slow'; fanVal.textContent = 'LOW'; }
        else { fanCard.className = 'comp comp-act act-fan'; fanVal.textContent = 'OFF'; }
    }

    // Burn Chamber circuit board card
    const burnCard = document.getElementById('comp-chamber');
    const burnVal  = document.getElementById('mod-chamber-val');
    if (burnCard && burnVal) {
        burnCard.className = state.burnChamber ? 'comp comp-act act-burn comp-alarm' : 'comp comp-act act-burn';
        burnVal.textContent = state.burnChamber ? '🔥 ACTIVE' : 'OFF';
    }

    // ABD board alarm highlight
    const abdCard = document.getElementById('tele-card-abd');
    if (abdCard) abdCard.className = state.abdLevel > 50 ? 'tele-card alarm' : 'tele-card';
    const abdBoardCard = document.getElementById('comp-abd');
    if (abdBoardCard) {
        abdBoardCard.className = state.abdLevel > 50
            ? 'comp comp-sensor left-mid comp-alarm'
            : 'comp comp-sensor left-mid';
    }
}

// Hardware event tick emulation (runs 1Hz)
function tickSimulation() {
    const config = envConfigs[envMode.value];
    
    // Realistic Noise Injection
    state.pm25 += (Math.random() - 0.5) * 5 + (config.pm25Base - state.pm25) * 0.1;
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
    'comp-lcd':   '#a5d6ff'
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
                     'comp-power','comp-fan','comp-chamber'];

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

// Starting routine
updateUI();
