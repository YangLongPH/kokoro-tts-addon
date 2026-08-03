const startBatchBtn = document.getElementById('startBatchBtn');
const stopBatchBtn = document.getElementById('stopBatchBtn');
const batchStatus = document.getElementById('batchStatus');
const batchProgressWrap = document.getElementById('batchProgressWrap');
const batchFill = document.getElementById('batchFill');
const batchProgressText = document.getElementById('batchProgressText');

const readAloudBtn = document.getElementById('readAloudBtn');
const pauseReadAloudBtn = document.getElementById('pauseReadAloudBtn');
const stopReadAloudBtn = document.getElementById('stopReadAloudBtn');
const preloadAheadInput = document.getElementById('preloadAheadInput');
const preloadAheadValue = document.getElementById('preloadAheadValue');
const contentSelectorInput = document.getElementById('contentSelectorInput');
const ignoreSelectorInput = document.getElementById('ignoreSelectorInput');
const saveReadAloudConfig = document.getElementById('saveReadAloudConfig');

const autoNextChapter = document.getElementById('autoNextChapter');
const nextChapterSelectorInput = document.getElementById('nextChapterSelectorInput');
const autoStopMinutesInput = document.getElementById('autoStopMinutesInput');
const autoStopStatusRow = document.getElementById('autoStopStatusRow');
const autoStopCountdownEl = document.getElementById('autoStopCountdown');
const autoStopClockEl = document.getElementById('autoStopClock');
const readAloudProgress = document.getElementById('readAloudProgress');
const raFill = document.getElementById('raFill');
const raPreload = document.getElementById('raPreload');
const raText = document.getElementById('raText');
const raPreloadLabel = document.getElementById('raPreloadLabel');
const raCacheText = document.getElementById('raCacheText');
const domainLabel = document.getElementById('domainLabel');
const closeBtn = document.getElementById('closeBtn');

const panelModelSelect = document.getElementById('panelModelSelect');
const panelVoiceSelect = document.getElementById('panelVoiceSelect');
const panelLangSelect = document.getElementById('panelLangSelect');
const panelSpeedInput = document.getElementById('panelSpeedInput');
const panelSpeedValue = document.getElementById('panelSpeedValue');
const ttsModelGroup = document.getElementById('ttsModelGroup');
const ttsModelSelectInput = document.getElementById('ttsModelSelect');
const localModelGroup = document.getElementById('localModelGroup');
const localVoiceLangRow = document.getElementById('localVoiceLangRow');

let currentDomain = null;
let modelsData = {};

const DOMAIN_KEY = (domain) => `cfg::${domain}`;
// Same key content.js writes the auto-stop countdown target (absolute
// epoch ms) to — this is the single source of truth for the live display
// below, independent of any message-passing timing.
const AUTO_STOP_KEY = (domain) => `_autoStopAt::${domain}`;

const DEFAULTS = {
    preloadAhead: 10,
    contentSelector: '',
    ignoreSelector: '',
    autoNextChapter: false,
    nextChapterSelector: '',
    autoStopMinutes: 30
};

function sendToContent(data) {
    window.parent.postMessage({ ...data, source: 'kokoro-panel' }, '*');
}

function formatDuration(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Reads the auto-stop target timestamp straight from storage (the same key
// content.js writes/clears) and renders it — no reliance on postMessage
// timing, so this stays correct even if the panel is opened/reopened mid-
// countdown or reloaded independently of the content script's lifecycle.
async function refreshAutoStopDisplay() {
    if (!currentDomain) { autoStopStatusRow.style.display = 'none'; return; }
    const key = AUTO_STOP_KEY(currentDomain);
    const stored = await chrome.storage.local.get({ [key]: 0 });
    const autoStopAt = stored[key];
    const remainingMs = autoStopAt - Date.now();

    if (!autoStopAt || remainingMs <= 0) {
        autoStopStatusRow.style.display = 'none';
        return;
    }

    autoStopStatusRow.style.display = 'flex';
    autoStopCountdownEl.textContent = `⏱ ${formatDuration(remainingMs)} còn lại`;
    autoStopClockEl.textContent = `dừng lúc ${new Date(autoStopAt).toLocaleTimeString('vi-VN')}`;
}

window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== 'kokoro-content') return;
    const { action } = e.data;

    if (action === 'pageInfo') {
        currentDomain = e.data.domain;
        domainLabel.textContent = currentDomain;
        await loadSettings(currentDomain);
        await refreshAutoStopDisplay(); // show immediately if a countdown is already running (e.g. panel reopened mid-session)
        if (e.data.batchRunning) {
            startBatchBtn.style.display = 'none';
            stopBatchBtn.style.display = 'block';
            batchProgressWrap.style.display = 'block';
            showBatchStatus('Batch running…', 'loading');
        }

    } else if (action === 'readAloudProgress') {
        const { current, total, preloaded, totalCached } = e.data;
        readAloudProgress.style.display = 'block';
        const pct = total > 0 ? (current / total) * 100 : 0;
        const preloadPct = total > 0 ? Math.min((current + preloaded) / total * 100, 100) : 0;
        raFill.style.width = pct + '%';
        raPreload.style.width = preloadPct + '%';
        raText.textContent = `${current} / ${total} sentences`;
        raPreloadLabel.textContent = preloaded > 0 ? `+${preloaded} preloaded` : '';
        raCacheText.textContent = `${totalCached ?? 0} / ${total} cache`;

    } else if (action === 'readAloudDone') {
        raText.textContent = 'Complete!';
        raFill.style.width = '100%';
        raPreloadLabel.textContent = '';
        raCacheText.textContent = '';
        setTimeout(() => {
            readAloudProgress.style.display = 'none';
            readAloudBtn.style.display = 'block';
            pauseReadAloudBtn.style.display = 'none';
            pauseReadAloudBtn.textContent = '⏸️ Pause';
            stopReadAloudBtn.style.display = 'none';
        }, 2000);

    } else if (action === 'batchAutoStarted') {
        startBatchBtn.style.display = 'none';
        stopBatchBtn.style.display = 'block';
        batchProgressWrap.style.display = 'block';
        batchFill.style.width = '0%';
        batchProgressText.textContent = 'Starting…';
        showBatchStatus('Batch running…', 'loading');

    } else if (action === 'readAloudAutoStarted') {
        readAloudBtn.style.display = 'none';
        pauseReadAloudBtn.style.display = 'block';
        pauseReadAloudBtn.textContent = '⏸️ Pause';
        stopReadAloudBtn.style.display = 'block';
        readAloudProgress.style.display = 'block';

    } else if (action === 'batchProgress') {
        const pct = e.data.progress || 0;
        batchProgressWrap.style.display = 'block';
        batchFill.style.width = pct + '%';
        batchProgressText.textContent = `Converting: ${pct}%`;
        showBatchStatus(`Processing chapter… ${pct}%`, 'loading');

    } else if (action === 'batchDone') {
        batchFill.style.width = '100%';
        batchProgressText.textContent = 'Saved! Next chapter in 3s… (Stop to cancel)';
        showBatchStatus('Chapter saved! Navigating in 3s…', 'success');

    } else if (action === 'batchStopped') {
        startBatchBtn.style.display = 'block';
        stopBatchBtn.style.display = 'none';
        batchProgressWrap.style.display = 'none';
        showBatchStatus('Batch stopped', 'info');

    } else if (action === 'batchError') {
        startBatchBtn.style.display = 'block';
        stopBatchBtn.style.display = 'none';
        showBatchStatus(`Error: ${e.data.error}`, 'error');
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadSpeed(); // independent of local-server/cloud mode — always load
    await refreshCloudMode();
    sendToContent({ action: 'getPageDomain' });
    setInterval(refreshAutoStopDisplay, 1000);
});

// React instantly (not up-to-1s-delayed) when content.js sets/clears the
// countdown target — e.g. right when auto-stop fires or the user hits Stop.
// Also react if Cloud TTS get configured/cleared from the popup while this
// panel is already open.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (currentDomain && AUTO_STOP_KEY(currentDomain) in changes) {
        refreshAutoStopDisplay();
    }
    if ('ttsApiUrl' in changes || 'ttsApiSecret' in changes) {
        refreshCloudMode();
    }
});

async function loadSpeed() {
    const stored = await chrome.storage.local.get({ speed: 1.0 });
    panelSpeedInput.value = stored.speed;
    panelSpeedValue.textContent = stored.speed + 'x';
}

// Cloud TTS (Piper VN / VN phiên âm / VN+EN / Google — set via popup's URL
// + secret fields) needs no local-server model/voice/lang list at all — a
// fixed 4-option model picker instead. Only fall back to querying
// localhost:8000 (and requiring it to be running) when Cloud TTS isn't
// configured — same reasoning as popup.js's refreshMode(), which this
// mirrors, since without it the panel got stuck depending on the local
// server even when only Cloud TTS was actually in use.
async function isCloudConfigured() {
    const stored = await chrome.storage.local.get({ ttsApiUrl: '', ttsApiSecret: '' });
    return !!(stored.ttsApiUrl && stored.ttsApiSecret);
}

async function refreshCloudMode() {
    if (await isCloudConfigured()) {
        ttsModelGroup.style.display = 'flex';
        ttsModelGroup.style.flexDirection = 'column';
        localModelGroup.style.display = 'none';
        localVoiceLangRow.style.display = 'none';

        const stored = await chrome.storage.local.get({ ttsModel: 'piper_vi' });
        if (Array.from(ttsModelSelectInput.options).some(o => o.value === stored.ttsModel)) {
            ttsModelSelectInput.value = stored.ttsModel;
        }
    } else {
        ttsModelGroup.style.display = 'none';
        localModelGroup.style.display = 'flex';
        localVoiceLangRow.style.display = 'grid';
        await populateModelsFromServer();
    }
}

async function populateModelsFromServer() {
    try {
        const r = await fetch('http://localhost:8000/health');
        if (!r.ok) return;
        const data = await r.json();
        modelsData = data.models || {};

        panelModelSelect.innerHTML = '';
        for (const [key, info] of Object.entries(modelsData)) {
            panelModelSelect.appendChild(Object.assign(document.createElement('option'), {
                value: key, textContent: info.label || key
            }));
        }
        if (data.default_model && modelsData[data.default_model]) {
            panelModelSelect.value = data.default_model;
        }

        const stored = await chrome.storage.local.get({ model: '', voice: '', language: '' });
        if (stored.model && Array.from(panelModelSelect.options).some(o => o.value === stored.model)) {
            panelModelSelect.value = stored.model;
        }
        updateVoiceLangDropdowns(panelModelSelect.value);
        if (stored.voice && Array.from(panelVoiceSelect.options).some(o => o.value === stored.voice)) {
            panelVoiceSelect.value = stored.voice;
        }
        if (stored.language && Array.from(panelLangSelect.options).some(o => o.value === stored.language)) {
            panelLangSelect.value = stored.language;
        }
    } catch (e) {
        console.error('Failed to load models:', e);
    }
}

function updateVoiceLangDropdowns(modelKey) {
    const info = modelsData[modelKey];
    if (!info) return;

    panelVoiceSelect.innerHTML = '';
    info.voices.forEach(v => {
        panelVoiceSelect.appendChild(Object.assign(document.createElement('option'), {
            value: v, textContent: (info.voice_labels || {})[v] || v
        }));
    });

    panelLangSelect.innerHTML = '';
    info.languages.forEach(l => {
        panelLangSelect.appendChild(Object.assign(document.createElement('option'), {
            value: l, textContent: (info.language_labels || {})[l] || l
        }));
    });
}

async function saveTTSSettings() {
    await chrome.storage.local.set({
        model: panelModelSelect.value,
        voice: panelVoiceSelect.value,
        speed: parseFloat(panelSpeedInput.value),
        language: panelLangSelect.value
    });
}

function setupEventListeners() {
    closeBtn.addEventListener('click', () => sendToContent({ action: 'closePanel' }));

    panelSpeedInput.addEventListener('input', () => {
        panelSpeedValue.textContent = parseFloat(panelSpeedInput.value).toFixed(1) + 'x';
        saveTTSSettings();
    });

    panelModelSelect.addEventListener('change', () => {
        updateVoiceLangDropdowns(panelModelSelect.value);
        saveTTSSettings();
    });

    [panelVoiceSelect, panelLangSelect].forEach(el => el.addEventListener('change', saveTTSSettings));

    ttsModelSelectInput.addEventListener('change', () => {
        chrome.storage.local.set({ ttsModel: ttsModelSelectInput.value });
    });

    preloadAheadInput.addEventListener('input', () => {
        preloadAheadValue.textContent = preloadAheadInput.value;
    });

    saveReadAloudConfig.addEventListener('click', async () => {
        const cfg = {
            preloadAhead: parseInt(preloadAheadInput.value),
            contentSelector: contentSelectorInput.value.trim(),
            ignoreSelector: ignoreSelectorInput.value.trim(),
            autoNextChapter: autoNextChapter.checked,
            nextChapterSelector: nextChapterSelectorInput.value.trim(),
            autoStopMinutes: parseInt(autoStopMinutesInput.value) || 0
        };

        // Save per-domain config
        if (currentDomain) {
            await chrome.storage.local.set({ [DOMAIN_KEY(currentDomain)]: cfg });
        }
        // Also update global defaults (preloadAhead)
        await chrome.storage.local.set({ preloadAhead: cfg.preloadAhead });

        const orig = saveReadAloudConfig.textContent;
        saveReadAloudConfig.textContent = `✓ Saved (${currentDomain || 'global'})`;
        setTimeout(() => { saveReadAloudConfig.textContent = orig; }, 2000);
    });

    readAloudBtn.addEventListener('click', () => {
        sendToContent({
            action: 'startReadAloud',
            preloadAhead: parseInt(preloadAheadInput.value),
            contentSelector: contentSelectorInput.value.trim(),
            ignoreSelector: ignoreSelectorInput.value.trim(),
            autoStopMinutes: parseInt(autoStopMinutesInput.value) || 0,
        });
        readAloudBtn.style.display = 'none';
        pauseReadAloudBtn.style.display = 'block';
        stopReadAloudBtn.style.display = 'block';
    });

    pauseReadAloudBtn.addEventListener('click', () => {
        const isPaused = pauseReadAloudBtn.textContent.startsWith('⏸');
        sendToContent({ action: isPaused ? 'pauseReadAloud' : 'resumeReadAloud' });
        pauseReadAloudBtn.textContent = isPaused ? '▶️ Resume' : '⏸️ Pause';
    });

    stopReadAloudBtn.addEventListener('click', () => {
        sendToContent({ action: 'stopReadAloud' });
        readAloudBtn.style.display = 'block';
        pauseReadAloudBtn.style.display = 'none';
        pauseReadAloudBtn.textContent = '⏸️ Pause';
        stopReadAloudBtn.style.display = 'none';
    });

    startBatchBtn.addEventListener('click', () => {
        sendToContent({
            action: 'startBatch',
            contentSelector: contentSelectorInput.value.trim(),
            ignoreSelector: ignoreSelectorInput.value.trim(),
            nextChapterSelector: nextChapterSelectorInput.value.trim(),
        });
        startBatchBtn.style.display = 'none';
        stopBatchBtn.style.display = 'block';
        batchProgressWrap.style.display = 'block';
        batchFill.style.width = '0%';
        batchProgressText.textContent = 'Submitting…';
        showBatchStatus('Starting batch mode…', 'loading');
    });

    stopBatchBtn.addEventListener('click', () => {
        sendToContent({ action: 'stopBatch' });
        startBatchBtn.style.display = 'block';
        stopBatchBtn.style.display = 'none';
        batchProgressWrap.style.display = 'none';
        batchStatus.style.display = 'none';
    });
}

function showBatchStatus(msg, type) {
    batchStatus.className = `status ${type}`;
    batchStatus.style.display = 'block';
    batchStatus.textContent = msg;
}

async function loadSettings(domain) {
    try {
        const key = DOMAIN_KEY(domain);
        // Load domain config + global preloadAhead fallback
        const stored = await chrome.storage.local.get({
            [key]: null,
            preloadAhead: DEFAULTS.preloadAhead
        });

        const cfg = stored[key] ?? {
            ...DEFAULTS,
            preloadAhead: stored.preloadAhead
        };

        preloadAheadInput.value = cfg.preloadAhead;
        preloadAheadValue.textContent = cfg.preloadAhead;
        contentSelectorInput.value = cfg.contentSelector;
        ignoreSelectorInput.value = cfg.ignoreSelector;
        autoNextChapter.checked = cfg.autoNextChapter;
        nextChapterSelectorInput.value = cfg.nextChapterSelector;
        autoStopMinutesInput.value = cfg.autoStopMinutes ?? DEFAULTS.autoStopMinutes;

        // Tint label green if domain has saved config, grey if using defaults
        domainLabel.style.color = stored[key]
            ? 'rgba(100,255,218,0.8)'
            : 'rgba(255,255,255,0.35)';
        domainLabel.textContent = stored[key]
            ? `${domain} ✓`
            : `${domain} (defaults)`;

    } catch (e) { console.error('Failed to load settings:', e); }
}
