const browser = chrome;
let currentAudio = null;
let currentAudioBlob = null;
let currentAudioUrl = null;
let isGenerating = false;

const textInput = document.getElementById('textInput');
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

const VOICE_DISPLAY_NAMES = { 'vi_default': 'Vietnamese (Default)' };
const LANGUAGE_DISPLAY_NAMES = {
    'vi': '🇻🇳 Vietnamese', 'en': '🇺🇸 English', 'fr': '🇫🇷 French',
    'es': '🇪🇸 Spanish',   'de': '🇩🇪 German',  'it': '🇮🇹 Italian',
    'pt': '🇧🇷 Portuguese', 'zh-cn': '🇨🇳 Chinese', 'ja': '🇯🇵 Japanese',
    'ko': '🇰🇷 Korean',    'hi': '🇮🇳 Hindi',
};

document.addEventListener('DOMContentLoaded', async () => {
    await toggleBtnGroupForCurrentTab();
    await populateDropdownsFromServer();
    await loadSettings();
    setupEventListeners();
    checkServerStatus();
});

async function toggleBtnGroupForCurrentTab() {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !tab?.id) return;
        let hostname;
        try { hostname = new URL(tab.url).hostname; } catch { return; }
        if (!hostname) return;

        const key = `show::${hostname}`;
        const stored = await browser.storage.local.get({ [key]: false });
        const visible = !stored[key];
        await browser.storage.local.set({ [key]: visible });

        try {
            await browser.tabs.sendMessage(tab.id, { action: 'setBtnGroupVisible', visible });
        } catch {
            // Content script not ready yet; state saved and will apply on next load
        }
    } catch (e) {
        console.error('toggleBtnGroupForCurrentTab:', e);
    }
}

function setupEventListeners() {
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

    [voiceSelect, speedInput, langSelect].forEach(el => el.addEventListener('change', saveSettings));

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
        const r = await browser.storage.local.get({ voice: 'vi_default', speed: 1.0, language: 'vi' });
        if (Array.from(voiceSelect.options).some(o => o.value === r.voice)) voiceSelect.value = r.voice;
        speedInput.value = r.speed;
        speedValue.textContent = r.speed + 'x';
        if (Array.from(langSelect.options).some(o => o.value === r.language)) langSelect.value = r.language;
    } catch (e) { console.error('Failed to load settings:', e); }
}

async function saveSettings() {
    try {
        await browser.storage.local.set({
            voice: voiceSelect.value,
            speed: parseFloat(speedInput.value),
            language: langSelect.value
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
        voiceSelect.innerHTML = '';
        langSelect.innerHTML = '';
        const voiceLabels = data.voice_labels || {};
        data.available_voices.forEach(v => {
            voiceSelect.appendChild(Object.assign(document.createElement('option'), {
                value: v, textContent: voiceLabels[v] || VOICE_DISPLAY_NAMES[v] || v
            }));
        });
        const langLabels = data.language_labels || {};
        data.available_languages.forEach(l => {
            langSelect.appendChild(Object.assign(document.createElement('option'), {
                value: l, textContent: langLabels[l] || LANGUAGE_DISPLAY_NAMES[l] || l
            }));
        });
    } catch (e) {
        showStatus('Cannot connect to TTS server', 'error');
        speakBtn.disabled = true;
    }
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
        const response = await fetch('http://localhost:8000/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text, voice: voiceSelect.value,
                speed: parseFloat(speedInput.value), language: langSelect.value
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
