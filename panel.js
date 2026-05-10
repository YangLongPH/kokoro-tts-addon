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

let currentDomain = null;

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
    // Request domain from content.js (in case onload already fired)
    sendToContent({ action: 'getPageDomain' });
});

function setupEventListeners() {
    closeBtn.addEventListener('click', () => sendToContent({ action: 'closePanel' }));

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
