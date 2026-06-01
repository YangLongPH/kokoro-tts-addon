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

let currentDomain = null;
let modelsData = {};

const DOMAIN_KEY = (domain) => `cfg::${domain}`;

const DEFAULTS = {
    preloadAhead: 10,
    contentSelector: '',
    ignoreSelector: '',
    autoNextChapter: false,
    nextChapterSelector: ''
};

function sendToContent(data) {
    window.parent.postMessage({ ...data, source: 'kokoro-panel' }, '*');
}

window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== 'kokoro-content') return;
    const { action } = e.data;

    if (action === 'pageInfo') {
        currentDomain = e.data.domain;
        domainLabel.textContent = currentDomain;
        await loadSettings(currentDomain);

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

    } else if (action === 'readAloudAutoStarted') {
        readAloudBtn.style.display = 'none';
        pauseReadAloudBtn.style.display = 'block';
        pauseReadAloudBtn.textContent = '⏸️ Pause';
        stopReadAloudBtn.style.display = 'block';
        readAloudProgress.style.display = 'block';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    populateModelsFromServer();
    sendToContent({ action: 'getPageDomain' });
});

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

        const stored = await chrome.storage.local.get({ model: '', voice: '', speed: 1.0, language: '' });
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
        panelSpeedInput.value = stored.speed;
        panelSpeedValue.textContent = stored.speed + 'x';
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

    preloadAheadInput.addEventListener('input', () => {
        preloadAheadValue.textContent = preloadAheadInput.value;
    });

    saveReadAloudConfig.addEventListener('click', async () => {
        const cfg = {
            preloadAhead: parseInt(preloadAheadInput.value),
            contentSelector: contentSelectorInput.value.trim(),
            ignoreSelector: ignoreSelectorInput.value.trim(),
            autoNextChapter: autoNextChapter.checked,
            nextChapterSelector: nextChapterSelectorInput.value.trim()
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
            ignoreSelector: ignoreSelectorInput.value.trim()
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

        // Tint label green if domain has saved config, grey if using defaults
        domainLabel.style.color = stored[key]
            ? 'rgba(100,255,218,0.8)'
            : 'rgba(255,255,255,0.35)';
        domainLabel.textContent = stored[key]
            ? `${domain} ✓`
            : `${domain} (defaults)`;

    } catch (e) { console.error('Failed to load settings:', e); }
}
