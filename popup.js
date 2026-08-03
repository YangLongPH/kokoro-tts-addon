const browser = chrome;
let currentAudio = null;
let currentAudioBlob = null;
let currentAudioUrl = null;
let isGenerating = false;

const textInput = document.getElementById('textInput');
const modelSelect = document.getElementById('modelSelect');
const voiceSelect = document.getElementById('voiceSelect');
const speedInput = document.getElementById('speedInput');
const speedValue = document.getElementById('speedValue');
const langSelect = document.getElementById('langSelect');
const speakBtn = document.getElementById('speakBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const audioPlayer = document.getElementById('audioPlayer');
const audioControls = document.getElementById('audioControls');
const downloadBtn = document.getElementById('downloadBtn');
const replayBtn = document.getElementById('replayBtn');
const getSelectionBtn = document.getElementById('getSelection');
const getPageBtn = document.getElementById('getPage');
const clearTextBtn = document.getElementById('clearText');
const ttsApiUrlInput = document.getElementById('ttsApiUrl');
const ttsApiSecretInput = document.getElementById('ttsApiSecret');
const ttsModelSelectInput = document.getElementById('ttsModelSelect');
const localModelGroup = document.getElementById('localModelGroup');
const localVoiceGroup = document.getElementById('localVoiceGroup');
const localLangGroup = document.getElementById('localLangGroup');

let modelsData = {}; // key → { label, voices, voice_labels, languages, language_labels }

document.addEventListener('DOMContentLoaded', async () => {
    await loadPanelToggleState();
    await loadSettings(); // must run first — refreshMode() below depends on ttsApiUrl/ttsApiSecret
    await refreshMode();
    setupEventListeners();
});

// Cloud TTS (Piper, Vietnamese-only) needs no model/voice/language list from
// a server — it's a single fixed voice. Only fall back to querying
// localhost:8000 (and requiring it to be running) when Cloud TTS isn't
// configured. Without this, the popup got stuck on "Loading models…"
// forever and Generate Speech stayed disabled whenever the local server
// wasn't running, even though Cloud TTS alone was enough to generate speech.
function isCloudConfigured() {
    return !!(ttsApiUrlInput.value.trim() && ttsApiSecretInput.value.trim());
}

async function refreshMode() {
    if (isCloudConfigured()) {
        // Hide the local-server Model/Voice/Language groups entirely rather
        // than disabling them with a stale placeholder — a disabled,
        // greyed-out "Model" dropdown sitting right at the top was easily
        // mistaken for THE model picker being broken/unusable, when the
        // real one (ttsModelSelect, below) was just a less prominent
        // dropdown further down the form.
        localModelGroup.style.display = 'none';
        localVoiceGroup.style.display = 'none';
        localLangGroup.style.display = 'none';
        speakBtn.disabled = false;
        showStatus('Using Cloud TTS ✓', 'success');
    } else {
        localModelGroup.style.display = 'flex';
        localVoiceGroup.style.display = 'flex';
        localLangGroup.style.display = 'flex';
        await populateDropdownsFromServer();
        checkServerStatus();
    }
}

let _currentTab = null;

async function loadPanelToggleState() {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !tab?.id) return;
        let hostname;
        try { hostname = new URL(tab.url).hostname; } catch { return; }
        if (!hostname) return;
        _currentTab = tab;

        const key = `show::${hostname}`;
        const stored = await browser.storage.local.get({ [key]: false });
        document.getElementById('panelToggle').checked = stored[key];
    } catch (e) {
        console.error('loadPanelToggleState:', e);
    }
}

async function setPanelVisible(visible) {
    try {
        const tab = _currentTab;
        if (!tab?.url || !tab?.id) return;
        let hostname;
        try { hostname = new URL(tab.url).hostname; } catch { return; }
        if (!hostname) return;

        await browser.storage.local.set({ [`show::${hostname}`]: visible });
        try {
            await browser.tabs.sendMessage(tab.id, { action: 'setBtnGroupVisible', visible });
        } catch {
            // Content script not ready yet; state saved and will apply on next load
        }
    } catch (e) {
        console.error('setPanelVisible:', e);
    }
}

function setupEventListeners() {
    document.getElementById('panelToggle').addEventListener('change', (e) => {
        setPanelVisible(e.target.checked);
    });

    speedInput.addEventListener('input', (e) => {
        speedValue.textContent = e.target.value + 'x';
    });

    speakBtn.addEventListener('click', generateSpeech);
    stopBtn.addEventListener('click', stopSpeech);
    downloadBtn.addEventListener('click', downloadAudio);
    replayBtn.addEventListener('click', replayAudio);

    getSelectionBtn.addEventListener('click', async () => {
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: () => window.getSelection().toString().trim()
            });
            const text = results?.[0]?.result;
            if (text) { textInput.value = text; showStatus('Selected text captured!', 'success'); }
            else showStatus('No text selected', 'error');
        } catch (e) { showStatus('Failed to get selection', 'error'); }
    });

    getPageBtn.addEventListener('click', async () => {
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                func: () => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                        acceptNode: n => (n.parentElement?.tagName === 'SCRIPT' || n.parentElement?.tagName === 'STYLE')
                            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
                    });
                    let text = ''; let node;
                    while ((node = walker.nextNode())) { const t = node.textContent.trim(); if (t) text += t + ' '; }
                    return text.trim().substring(0, 5000);
                }
            });
            const text = results?.[0]?.result;
            if (text) { textInput.value = text; showStatus('Page text captured!', 'success'); }
            else showStatus('No text found', 'error');
        } catch (e) { showStatus('Failed to get page text', 'error'); }
    });

    clearTextBtn.addEventListener('click', () => {
        textInput.value = '';
        hideAudioControls();
    });

    modelSelect.addEventListener('change', () => {
        updateVoiceLangDropdowns(modelSelect.value);
        saveSettings();
    });

    [voiceSelect, speedInput, langSelect].forEach(el => el.addEventListener('change', saveSettings));
    [ttsApiUrlInput, ttsApiSecretInput].forEach(el => el.addEventListener('change', async () => {
        await saveSettings();
        await refreshMode();
    }));
    ttsModelSelectInput.addEventListener('change', saveSettings);

    audioPlayer.addEventListener('ended', resetUI);
    audioPlayer.addEventListener('loadstart', showAudioControls);
}

function showAudioControls() {
    audioControls.style.display = 'block';
    downloadBtn.disabled = !currentAudioBlob;
}

function hideAudioControls() {
    audioControls.style.display = 'none';
    cleanupAudioResources();
}

function downloadAudio() {
    if (!currentAudioBlob) { showStatus('No audio to download', 'error'); return; }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const voice = voiceSelect.options[voiceSelect.selectedIndex]?.text.replace(/[^a-zA-Z0-9]/g, '_') || 'tts';
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(currentAudioBlob),
        download: `kokoro_${voice}_${timestamp}.wav`
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showStatus('Downloaded!', 'success');
}

function replayAudio() {
    if (audioPlayer.src) { audioPlayer.currentTime = 0; audioPlayer.play(); }
}

function cleanupAudioResources() {
    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
    currentAudioBlob = null;
    audioPlayer.src = '';
    audioPlayer.style.display = 'none';
}

async function loadSettings() {
    try {
        const r = await browser.storage.local.get({ model: '', voice: '', speed: 1.0, language: '', ttsApiUrl: '', ttsApiSecret: '', ttsModel: 'piper_vi' });

        // Model
        const savedModel = r.model || modelSelect.options[0]?.value || '';
        if (Array.from(modelSelect.options).some(o => o.value === savedModel)) modelSelect.value = savedModel;
        updateVoiceLangDropdowns(modelSelect.value);

        // Voice & language (after dropdowns are repopulated for this model)
        if (r.voice && Array.from(voiceSelect.options).some(o => o.value === r.voice)) voiceSelect.value = r.voice;
        if (r.language && Array.from(langSelect.options).some(o => o.value === r.language)) langSelect.value = r.language;

        speedInput.value = r.speed;
        speedValue.textContent = r.speed + 'x';

        ttsApiUrlInput.value = r.ttsApiUrl;
        ttsApiSecretInput.value = r.ttsApiSecret;
        if (Array.from(ttsModelSelectInput.options).some(o => o.value === r.ttsModel)) {
            ttsModelSelectInput.value = r.ttsModel;
        }
    } catch (e) { console.error('Failed to load settings:', e); }
}

async function saveSettings() {
    try {
        await browser.storage.local.set({
            model: modelSelect.value,
            voice: voiceSelect.value,
            speed: parseFloat(speedInput.value),
            language: langSelect.value,
            ttsApiUrl: ttsApiUrlInput.value.trim().replace(/\/$/, ''),
            ttsApiSecret: ttsApiSecretInput.value.trim(),
            ttsModel: ttsModelSelectInput.value
        });
    } catch (e) { console.error('Failed to save settings:', e); }
}

async function checkServerStatus() {
    try {
        const r = await fetch('http://localhost:8000/health');
        showStatus(r.ok ? 'Server connected ✓' : 'Server not responding', r.ok ? 'success' : 'error');
    } catch (e) {
        showStatus('Server not running — start python server.py first', 'error');
    }
}

async function populateDropdownsFromServer() {
    try {
        const r = await fetch('http://localhost:8000/health');
        if (!r.ok) { speakBtn.disabled = true; return; }
        const data = await r.json();
        modelsData = data.models || {};

        modelSelect.innerHTML = '';
        for (const [key, info] of Object.entries(modelsData)) {
            modelSelect.appendChild(Object.assign(document.createElement('option'), {
                value: key, textContent: info.label || key
            }));
        }
        if (data.default_model && modelsData[data.default_model]) {
            modelSelect.value = data.default_model;
        }
        updateVoiceLangDropdowns(modelSelect.value);
    } catch (e) {
        showStatus('Cannot connect to TTS server', 'error');
        speakBtn.disabled = true;
    }
}

function updateVoiceLangDropdowns(modelKey) {
    const info = modelsData[modelKey];
    if (!info) return;

    voiceSelect.innerHTML = '';
    info.voices.forEach(v => {
        voiceSelect.appendChild(Object.assign(document.createElement('option'), {
            value: v, textContent: (info.voice_labels || {})[v] || v
        }));
    });

    langSelect.innerHTML = '';
    info.languages.forEach(l => {
        langSelect.appendChild(Object.assign(document.createElement('option'), {
            value: l, textContent: (info.language_labels || {})[l] || l
        }));
    });
}

async function generateSpeech() {
    const text = textInput.value.trim();
    if (!text) { showStatus('Please enter some text', 'error'); return; }
    if (isGenerating) return;

    cleanupAudioResources();
    hideAudioControls();
    isGenerating = true;
    speakBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    showStatus('Generating speech...', 'loading');

    try {
        const cloudUrl = ttsApiUrlInput.value.trim().replace(/\/$/, '');
        const cloudSecret = ttsApiSecretInput.value.trim();
        const speed = parseFloat(speedInput.value);

        const response = (cloudUrl && cloudSecret)
            ? await fetch(`${cloudUrl}/tts/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-tts-secret': cloudSecret },
                body: JSON.stringify({ text, speed, model: ttsModelSelectInput.value })
            })
            : await fetch('http://localhost:8000/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text, model: modelSelect.value, voice: voiceSelect.value,
                    speed, language: langSelect.value
                })
            });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const audioBlob = await response.blob();
        currentAudioBlob = audioBlob;
        currentAudioUrl = URL.createObjectURL(audioBlob);
        audioPlayer.src = currentAudioUrl;
        audioPlayer.style.display = 'block';
        audioPlayer.play();
        currentAudio = audioPlayer;
        showStatus('Speech generated! 🎉', 'success');
        showAudioControls();
    } catch (e) {
        showStatus('Failed: ' + e.message, 'error');
        cleanupAudioResources();
    } finally {
        isGenerating = false;
        if (!currentAudio || currentAudio.paused) resetUI();
    }
}

function stopSpeech() {
    if (currentAudio && !currentAudio.paused) { currentAudio.pause(); currentAudio.currentTime = 0; }
    resetUI();
    showStatus('Stopped', 'success');
}

function resetUI() {
    speakBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    isGenerating = false;
}

function showStatus(message, type) {
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    if (type === 'success') setTimeout(() => { status.style.display = 'none'; }, 3000);
}
