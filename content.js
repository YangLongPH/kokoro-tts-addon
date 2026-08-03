// Content script for Kokoro TTS addon
// This script is injected into every webpage to provide in-page TTS features.

(function() {
    'use strict';
    const browser = chrome;
    
    let audioPlayerIframe = null;
    let panelIframe = null;
    let _updatePlayPauseBtn = null; // set by injectPanel once button is created

    // ─── In-page panel iframe ──────────────────────────────────────────────────

    function injectPanel() {
        if (document.getElementById('kokoro-panel-iframe')) return;

        // Iframe — starts off-screen, slides in when opened
        panelIframe = document.createElement('iframe');
        panelIframe.id = 'kokoro-panel-iframe';
        panelIframe.src = chrome.runtime.getURL('panel.html');
        panelIframe.setAttribute('allowtransparency', 'true');
        Object.assign(panelIframe.style, {
            position: 'fixed', top: '0', right: '0',
            width: '320px', height: '100vh',
            border: 'none', zIndex: '2147483645',
            background: 'transparent', colorScheme: 'normal',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s ease',
        });
        document.body.appendChild(panelIframe);

        // Send domain to panel once iframe is ready
        panelIframe.addEventListener('load', () => {
            sendToPanel({ action: 'pageInfo', domain: location.hostname, batchRunning: batchActive });
        });

        // Button group — lives in the page, always reliable
        let panelOpen = false;

        const btnGroup = document.createElement('div');
        btnGroup.id = 'kokoro-btn-group';
        Object.assign(btnGroup.style, {
            position: 'fixed', top: '50%', right: '0',
            transform: 'translateY(-50%)',
            display: 'flex', flexDirection: 'column', gap: '2px',
            zIndex: '2147483647',
            transition: 'right 0.3s ease',
        });

        const btnBase = {
            width: '36px',
            background: 'linear-gradient(135deg, #1a1a2e, #0f3460)',
            border: '1px solid rgba(100,255,218,0.3)',
            borderRight: 'none',
            color: '#fff', fontSize: '18px', cursor: 'pointer',
            padding: '0', lineHeight: '1',
            boxShadow: '-2px 0 8px rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        };

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'kokoro-toggle-btn';
        toggleBtn.textContent = '🎙️';
        Object.assign(toggleBtn.style, {
            ...btnBase,
            height: '52px',
            borderRadius: '8px 0 0 0',
        });
        toggleBtn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            panelIframe.style.transform = panelOpen ? 'translateX(0)' : 'translateX(100%)';
            btnGroup.style.right = panelOpen ? '320px' : '0';
            toggleBtn.textContent = panelOpen ? '✕' : '🎙️';
        });

        const playPauseBtn = document.createElement('button');
        playPauseBtn.id = 'kokoro-playpause-btn';
        playPauseBtn.textContent = '▶️';
        playPauseBtn.title = 'Start / Pause reading';
        Object.assign(playPauseBtn.style, {
            ...btnBase,
            height: '52px',
            borderRadius: '0',
            fontSize: '16px',
        });

        function updatePlayPauseBtn() {
            if (!readAloudActive || readAloudPaused) {
                playPauseBtn.textContent = '▶️';
                playPauseBtn.title = readAloudPaused ? 'Resume reading' : 'Start reading';
            } else {
                playPauseBtn.textContent = '⏸️';
                playPauseBtn.title = 'Pause reading';
            }
        }

        playPauseBtn.addEventListener('click', async () => {
            if (!readAloudActive) {
                // Load config for current domain then start
                const domainKey = `cfg::${location.hostname}`;
                const stored = await chrome.storage.local.get({
                    [domainKey]: null,
                    preloadAhead: 10
                });
                const cfg = stored[domainKey] ?? { preloadAhead: stored.preloadAhead, contentSelector: '', ignoreSelector: '', autoStopMinutes: 30 };
                startReadAloud(cfg.preloadAhead, cfg.contentSelector, cfg.ignoreSelector, cfg.autoStopMinutes);
                updatePlayPauseBtn();
            } else if (!readAloudPaused) {
                readAloudPaused = true;
                if (currentReadAudio) currentReadAudio.pause();
                updatePlayPauseBtn();
            } else {
                readAloudPaused = false;
                if (currentReadAudio) currentReadAudio.play().catch(() => {});
                updatePlayPauseBtn();
            }
        });

        const nextChapterBtn = document.createElement('button');
        nextChapterBtn.id = 'kokoro-nextchapter-btn';
        nextChapterBtn.textContent = '⏭️';
        nextChapterBtn.title = 'Next chapter';
        Object.assign(nextChapterBtn.style, {
            ...btnBase,
            height: '52px',
            borderRadius: '0 0 0 8px',
            fontSize: '16px',
        });
        nextChapterBtn.addEventListener('click', async () => {
            const domainKey = `cfg::${location.hostname}`;
            const stored = await chrome.storage.local.get({ [domainKey]: null });
            const settings = stored[domainKey] ?? {};
            const customSelector = settings.nextChapterSelector || '';
            const nextUrl = findNextChapterLink(customSelector);
            if (nextUrl) {
                showNotification('Next chapter in 2s…', 'info');
                await chrome.storage.local.set({ [`_autoStart::${location.hostname}`]: true });
                setTimeout(() => { window.location.href = nextUrl; }, 2000);
                return;
            }
            const nextBtn = findNextChapterButton(customSelector);
            if (nextBtn) {
                showNotification('Next chapter in 2s…', 'info');
                await chrome.storage.local.set({ [`_autoStart::${location.hostname}`]: true });
                const prevUrl = location.href;
                setTimeout(() => { nextBtn.click(); spaAutoStart(prevUrl); }, 2000);
                return;
            }
            showNotification('No next chapter found', 'error');
        });

        btnGroup.appendChild(toggleBtn);
        btnGroup.appendChild(playPauseBtn);
        btnGroup.appendChild(nextChapterBtn);
        document.body.appendChild(btnGroup);
        _updatePlayPauseBtn = updatePlayPauseBtn;

        // Relay messages from panel → read-aloud functions
        window.addEventListener('message', async (e) => {
            if (!e.data || e.data.source !== 'kokoro-panel') return;
            const { action } = e.data;

            if (action === 'getPageDomain') {
                sendToPanel({ action: 'pageInfo', domain: location.hostname, batchRunning: batchActive });

            } else if (action === 'closePanel') {
                panelOpen = false;
                panelIframe.style.transform = 'translateX(100%)';
                btnGroup.style.right = '0';
                toggleBtn.textContent = '🎙️';

            } else if (action === 'startReadAloud') {
                startReadAloud(e.data.preloadAhead, e.data.contentSelector, e.data.ignoreSelector, e.data.autoStopMinutes);

            } else if (action === 'pauseReadAloud') {
                readAloudPaused = true;
                if (currentReadAudio) currentReadAudio.pause();
                if (_updatePlayPauseBtn) _updatePlayPauseBtn();

            } else if (action === 'resumeReadAloud') {
                readAloudPaused = false;
                if (currentReadAudio) currentReadAudio.play().catch(() => {});
                if (_updatePlayPauseBtn) _updatePlayPauseBtn();

            } else if (action === 'stopReadAloud') {
                clearAutoStopState();
                cleanupReadAloud();

            } else if (action === 'getSelection') {
                const text = window.getSelection().toString().trim();
                sendToPanel({ action: 'selectionResult', text });

            } else if (action === 'getPageText') {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: n => (n.parentElement?.tagName === 'SCRIPT' || n.parentElement?.tagName === 'STYLE')
                        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
                });
                let text = '';
                let node;
                while ((node = walker.nextNode())) {
                    const t = node.textContent.trim();
                    if (t) text += t + ' ';
                }
                sendToPanel({ action: 'pageTextResult', text: text.trim().substring(0, 5000) });

            } else if (action === 'generateTTS') {
                // Forward to background script for streaming
                chrome.runtime.sendMessage({ action: 'generateTTS', text: e.data.text }).catch(() => {});

            } else if (action === 'startBatch') {
                startBatchMode(e.data.contentSelector || '', e.data.ignoreSelector || '', e.data.nextChapterSelector || '');

            } else if (action === 'stopBatch') {
                stopBatchMode();
            }
        });
    }

    function sendToPanel(data) {
        if (panelIframe && panelIframe.contentWindow) {
            panelIframe.contentWindow.postMessage({ ...data, source: 'kokoro-content' }, '*');
        }
    }

    async function maybeInjectPanel() {
        const key = `show::${location.hostname}`;
        const stored = await chrome.storage.local.get({ [key]: false });
        if (stored[key]) injectPanel();
    }

    if (document.body) {
        maybeInjectPanel();
    } else {
        document.addEventListener('DOMContentLoaded', maybeInjectPanel, { once: true });
    }

    let audioContext;
    let audioQueue = [];
    let isPlaying = false;
    let streamingComplete = false;
    let nextStartTime = 0;
    let currentSourceNode = null;

    function initAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(e => console.error("AudioContext resume failed:", e));
        }
    }

    // Schedule a PCM chunk to play exactly when the previous one ends — no gaps
    function scheduleChunk(chunk) {
        const audioData = new Int16Array(chunk);
        const float32Data = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            float32Data[i] = audioData[i] / 32768.0;
        }

        const buffer = audioContext.createBuffer(1, float32Data.length, 22050);
        buffer.copyToChannel(float32Data, 0);

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        currentSourceNode = source;

        // Start immediately if first chunk, otherwise chain onto previous end time
        const startTime = Math.max(audioContext.currentTime + 0.05, nextStartTime);
        source.start(startTime);
        nextStartTime = startTime + buffer.duration;
    }

    // Process audio queue using pre-scheduled timeline playback
    async function processQueue() {
        if (isPlaying || audioQueue.length === 0) return;

        isPlaying = true;
        initAudioContext();
        nextStartTime = audioContext.currentTime + 0.1; // 100ms initial buffer
        showNotification('Speech streaming...', 'loading');

        while (true) {
            if (audioQueue.length > 0) {
                scheduleChunk(audioQueue.shift());
            } else if (streamingComplete) {
                break;
            } else {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }

        // Wait for last scheduled chunk to finish
        const remaining = (nextStartTime - audioContext.currentTime) * 1000 + 100;
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));

        isPlaying = false;
        streamingComplete = false;
    }

    function stopStreamingAudio() {
        if (currentSourceNode) {
            try { currentSourceNode.stop(); } catch (e) {}
            currentSourceNode.disconnect();
            currentSourceNode = null;
        }
        audioQueue = [];
        isPlaying = false;
        streamingComplete = false;
        nextStartTime = 0;
        if (audioContext && audioContext.state === 'running') {
            audioContext.suspend().catch(() => {});
        }
        showNotification('Speech playback stopped', 'info');
    }


    /**
     * Creates and injects an invisible iframe to handle audio playback.
     * This bypasses the host page's Content Security Policy (CSP) which
     * often blocks 'data:' URLs for audio.
     */
    function createAudioPlayerIframe() {
        if (document.getElementById('kokoro-tts-player-iframe')) {
            audioPlayerIframe = document.getElementById('kokoro-tts-player-iframe');
            return;
        }

        console.log("Content Script: Creating audio player iframe.");
        audioPlayerIframe = document.createElement('iframe');
        audioPlayerIframe.id = 'kokoro-tts-player-iframe';
        audioPlayerIframe.src = browser.runtime.getURL('player.html');

        // Style the iframe to be completely invisible and non-interactive
        Object.assign(audioPlayerIframe.style, {
            display: 'none',
            position: 'fixed',
            width: '1px',
            height: '1px',
            border: 'none',
            top: '-10px',
            left: '-10px'
        });
        
        // Ensure the iframe is loaded before we try to use it
        audioPlayerIframe.onload = () => {
             console.log("Content Script: Audio player iframe loaded successfully.");
        };

        document.body.appendChild(audioPlayerIframe);
    }
    
    // Create the iframe as soon as the body is available.
    if (document.body) {
        createAudioPlayerIframe();
    } else {
        document.addEventListener('DOMContentLoaded', createAudioPlayerIframe, { once: true });
    }

    async function generateTTS(text) {
        // Stop any existing streaming audio before starting a new one
        stopStreamingAudio(); 

        try {
            showNotification('Generating speech...', 'loading');
            const response = await browser.runtime.sendMessage({
                action: 'generateTTS',
                text: text
            });
            
            if (response && !response.success) {
                showNotification('Failed: ' + response.error, 'error');
            }
        } catch (error) {
            console.error('Content Script: TTS Error in generateTTS:', error);
            showNotification('Failed to generate speech (client-side error)', 'error');
        }
    }
    
    let notificationTimeout = null;
    function showNotification(message, type = 'info') {
        const existing = document.getElementById('kokoro-tts-notification');
        if (existing) existing.remove();
        
        const notification = document.createElement('div');
        notification.id = 'kokoro-tts-notification';
        notification.textContent = message;
        
        const colors = {
            info: '#2196F3',
            success: '#4CAF50',
            error: '#f44336',
            loading: '#FF9800'
        };
        
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: colors[type] || colors.info,
            color: 'white',
            padding: '12px 20px',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: '500',
            zIndex: '10001',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            opacity: '0',
            transition: 'opacity 0.3s ease'
        });
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        clearTimeout(notificationTimeout);
        notificationTimeout = setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }, 3000);
    }
    
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            const selectedTextForHotkey = window.getSelection().toString().trim();
            if (selectedTextForHotkey) {
                generateTTS(selectedTextForHotkey);
            } else {
                showNotification('No text selected for hotkey', 'error');
            }
        }
    });

    /**
     * Plays the provided audio URL by sending it to the sandboxed iframe.
     * This function is now deprecated for streaming, but kept for compatibility
     * if the non-streaming `generate` endpoint is still used elsewhere.
     * @param {string} audioUrl - The data URL (base64) of the audio to play.
     */
    function playAudioInPage(audioUrl) {
        if (!audioPlayerIframe || !audioPlayerIframe.contentWindow) {
            console.error("Content Script: Audio player iframe is not ready.");
            showNotification('Audio player not ready. Please try again.', 'error');
            if (!audioPlayerIframe) createAudioPlayerIframe(); // Attempt to recover
            return;
        }
        
        console.log("Content Script: Posting audio URL to player iframe.");
        audioPlayerIframe.contentWindow.postMessage({
            action: 'playAudio',
            audioUrl: audioUrl
        }, '*'); // Use '*' for simplicity, or getURL origin for more security
    }

    // ─── Read Aloud ────────────────────────────────────────────────────────────

    let readAloudActive = false;
    let readAloudPaused = false;

    let readAloudSentences = [];
    let readAloudIndex = 0;
    const preloadCache = {};   // index → Promise<objectURL>
    const preloadReady = new Set(); // indices whose audio has finished downloading
    let PRELOAD_AHEAD = 10;
    let currentReadAudio = null;
    let autoStopTimer = null; // wall-clock "sleep timer" for Read Aloud — cleared in cleanupReadAloud()
    let userScrolling = false;
    let userScrollTimer = null;
    let _sentenceIndexMap = {};  // sentence text → index (for DOM rewrap)
    let _domObserver = null;
    let _rewrapPending = false;

    function extractMainContent(customSelector) {
        if (customSelector) {
            try {
                const el = document.querySelector(customSelector);
                if (el) return el;
            } catch (e) { console.warn('Invalid content selector:', customSelector); }
        }
        const selectors = [
            'article', 'main', '[role="main"]',
            '.post-content', '.article-body', '.entry-content',
            '.post-body', '.story-body', '.article-content',
            '#content', '.content', '.main-content'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim().length > 300) return el;
        }
        let best = null, maxScore = 0;
        document.querySelectorAll('div, section').forEach(el => {
            const pCount = el.querySelectorAll('p').length;
            const len = el.innerText.trim().length;
            const score = len + pCount * 150;
            if (score > maxScore && len > 300 && len < 200000) {
                maxScore = score; best = el;
            }
        });
        return best || document.body;
    }

    function splitSentences(text) {
        const raw = text.match(/[^.!?]+[.!?]*[\s]*/g) || [text];
        const sentences = raw.map(s => s.trim()).filter(s => s.length > 2);
        const result = [];
        for (const s of sentences) result.push(...chunkLongSentence(s));
        return result;
    }

    function escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function wrapContentSentences(container, ignoreSelector) {
        const sentences = [];
        _sentenceIndexMap = {};
        const nodes = container.querySelectorAll('p, h1, h2, h3, h4, li');
        nodes.forEach(node => {
            if (ignoreSelector) {
                try {
                    if (node.matches(ignoreSelector) || node.closest(ignoreSelector)) return;
                } catch (e) { console.warn('Invalid ignore selector:', ignoreSelector); }
            }
            // Nodes with <br> children use <br> as paragraph separators;
            // let walkBrContent handle them so the <br> elements are preserved.
            if (node.querySelector('br')) return;
            const text = node.innerText.trim();
            if (!text || text.length < 3) return;
            const parts = splitSentences(text);
            let html = '';
            parts.forEach(sent => {
                const idx = sentences.length;
                _sentenceIndexMap[sent.trim()] = idx;
                sentences.push(sent);
                html += `<span data-kokoro-s="${idx}">${escapeHtml(sent)} </span>`;
            });
            node.innerHTML = html;
        });

        // Fallback: many Vietnamese novel sites use <br> as paragraph separator
        // instead of <p> tags. Walk the tree recursively — when we hit a block
        // element that was already handled in pass 1 (has data-kokoro-s children)
        // skip it; otherwise recurse into it so arbitrary nesting depth is covered.
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
        let group = [];

        function flushGroup() {
            if (!group.length) return;
            const nodes = group.slice();
            group = [];
            const text = nodes.map(n =>
                n.nodeType === Node.TEXT_NODE ? n.textContent : (n.innerText || n.textContent)
            ).join('').trim();
            if (!text || text.length < 3) return;
            const parts = splitSentences(text);
            if (!parts.length) return;
            let html = '';
            parts.forEach(sent => {
                const idx = sentences.length;
                _sentenceIndexMap[sent.trim()] = idx;
                sentences.push(sent);
                html += `<span data-kokoro-s="${idx}">${escapeHtml(sent)} </span>`;
            });
            const parent = nodes[0].parentNode;
            if (!parent) return;
            const anchor = nodes[0];
            const wrapper = document.createElement('span');
            wrapper.innerHTML = html;
            while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, anchor);
            nodes.forEach(n => n.parentNode && n.parentNode.removeChild(n));
        }

        function walkBrContent(root) {
            Array.from(root.childNodes).forEach(child => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (SKIP.has(child.nodeName)) return;
                    if (child.nodeName === 'BR') {
                        flushGroup();
                    } else if (child.querySelector && child.querySelector('[data-kokoro-s]')) {
                        // already wrapped by pass 1 — flush current group and skip
                        flushGroup();
                    } else if (child.textContent.trim()) {
                        const isBlock = getComputedStyle(child).display !== 'inline' &&
                            getComputedStyle(child).display !== 'inline-block' &&
                            getComputedStyle(child).display !== 'inline-flex';
                        if (isBlock) {
                            flushGroup();
                            walkBrContent(child);
                        } else {
                            group.push(child);
                        }
                    }
                } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                    group.push(child);
                }
            });
            flushGroup();
        }

        walkBrContent(container);

        return sentences;
    }

    // Re-wrap a single paragraph node that was reset by the page's virtual scroll
    function rewrapNode(node) {
        const text = node.innerText.trim();
        if (!text || text.length < 3) return;
        const parts = splitSentences(text);
        let html = '';
        let anyFound = false;
        parts.forEach(sent => {
            const idx = _sentenceIndexMap[sent.trim()];
            if (idx !== undefined) {
                anyFound = true;
                html += `<span data-kokoro-s="${idx}">${escapeHtml(sent)} </span>`;
            } else {
                html += escapeHtml(sent) + ' ';
            }
        });
        if (!anyFound) return;
        node.innerHTML = html;
        // Re-apply highlight class if this node contains the current sentence
        const currentSpan = node.querySelector(`[data-kokoro-s="${readAloudIndex}"]`);
        if (currentSpan) currentSpan.classList.add('kokoro-reading');
    }

    function injectHighlightStyle() {
        if (document.getElementById('kokoro-highlight-style')) return;
        const style = document.createElement('style');
        style.id = 'kokoro-highlight-style';
        // Injected at end of body → last in cascade → our !important beats the page's !important
        style.textContent = `
            [data-kokoro-s].kokoro-reading {
                background-color: rgba(255, 220, 50, 0.6) !important;
                border-radius: 3px !important;
                outline: 2px solid rgba(255, 180, 0, 0.65) !important;
                outline-offset: 1px !important;
            }
        `;
        document.body.appendChild(style);
    }

    function startDOMObserver(container) {
        if (_domObserver) _domObserver.disconnect();
        _domObserver = new MutationObserver((mutations) => {
            if (!readAloudActive || _rewrapPending) return;
            const lost = new Set();
            mutations.forEach(m => {
                const node = m.target.closest
                    ? (m.target.matches('p,h1,h2,h3,h4,li') ? m.target : m.target.closest('p,h1,h2,h3,h4,li'))
                    : null;
                if (node && !node.querySelector('[data-kokoro-s]')) lost.add(node);
            });
            if (lost.size === 0) return;
            _rewrapPending = true;
            _domObserver.disconnect();
            lost.forEach(node => rewrapNode(node));
            _domObserver.observe(container, { childList: true, subtree: true });
            _rewrapPending = false;
        });
        _domObserver.observe(container, { childList: true, subtree: true });
    }

    window.addEventListener('scroll', () => {
        userScrolling = true;
        clearTimeout(userScrollTimer);
        userScrollTimer = setTimeout(() => { userScrolling = false; }, 2000);
    }, { passive: true });

    function highlightSentence(index) {
        document.querySelectorAll('[data-kokoro-s].kokoro-reading').forEach(el => el.classList.remove('kokoro-reading'));
        const span = document.querySelector(`[data-kokoro-s="${index}"]`);
        if (span) {
            span.classList.add('kokoro-reading');
            if (!userScrolling) {
                span.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    function cleanTextForTTS(text) {
        return text
            .replace(/[·‧・•]/g, '')   // syllable-separator dots used by some novel sites
            .replace(/[​-‍﻿]/g, '')  // zero-width characters
            .replace(/~/g, '')
            .replace(/\.{2,}/g, '.')   // collapse repeated dots (ellipsis) to single dot
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Split a sentence that is too long for the TTS model at comma boundaries.
    const MAX_TTS_CHARS = 150;
    function chunkLongSentence(sentence) {
        if (sentence.length <= MAX_TTS_CHARS) return [sentence];
        const chunks = [];
        const parts = sentence.split(/,\s*/);
        let current = '';
        for (const part of parts) {
            const next = current ? current + ', ' + part : part;
            if (next.length > MAX_TTS_CHARS && current) {
                chunks.push(current);
                current = part;
            } else {
                current = next;
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }

    async function fetchAudioUrl(text) {
        const settings = await chrome.storage.local.get({ model: '', voice: 'vi_default', speed: 1.0, language: 'vi', ttsApiUrl: '', ttsApiSecret: '', ttsModel: 'piper_vi' });
        const cleaned = cleanTextForTTS(text);

        const response = (settings.ttsApiUrl && settings.ttsApiSecret)
            ? await fetch(`${settings.ttsApiUrl}/tts/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-tts-secret': settings.ttsApiSecret },
                body: JSON.stringify({ text: cleaned, speed: settings.speed, model: settings.ttsModel })
            })
            : await fetch('http://localhost:8000/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleaned, model: settings.model || undefined, voice: settings.voice, speed: settings.speed, language: settings.language })
            });
        if (!response.ok) throw new Error(`TTS error: ${response.status}`);
        return URL.createObjectURL(await response.blob());
    }

    function preloadSentence(index) {
        if (index >= readAloudSentences.length || preloadCache[index]) return;
        preloadCache[index] = fetchAudioUrl(readAloudSentences[index]).then(url => {
            preloadReady.add(index);
            sendProgress(readAloudIndex, readAloudSentences.length);
            return url;
        }).catch(err => {
            preloadReady.add(index); // count as done even on error so UI unblocks
            sendProgress(readAloudIndex, readAloudSentences.length);
            throw err;
        });
    }

    function playAudioUrl(url) {
        return new Promise((resolve, reject) => {
            currentReadAudio = new Audio(url);
            currentReadAudio.onended = resolve;
            currentReadAudio.onerror = reject;
            if (!readAloudPaused) {
                currentReadAudio.play().catch(err => {
                    if (err.name === 'NotAllowedError') {
                        // Browser autoplay policy blocked playback (no prior user gesture).
                        // Pause the loop and let the user resume via the ▶️ button.
                        readAloudPaused = true;
                        if (_updatePlayPauseBtn) _updatePlayPauseBtn();
                        showNotification('Autoplay blocked — click ▶️ to start reading', 'info');
                        // Do not reject; the promise resolves normally once the user
                        // resumes and onended fires.
                    } else {
                        reject(err);
                    }
                });
            }
        });
    }

    function sendProgress(current, total) {
        let preloaded = 0;
        for (let i = current; i < Math.min(current + PRELOAD_AHEAD + 1, total); i++) {
            if (preloadReady.has(i)) preloaded++;
        }
        const totalCached = preloadReady.size;
        const msg = { action: 'readAloudProgress', current, total, preloaded, totalCached };
        chrome.runtime.sendMessage(msg).catch(() => {});
        sendToPanel(msg);
    }

    async function readAloudLoop() {
        const total = readAloudSentences.length;
        sendProgress(0, total);

        while (readAloudActive && readAloudIndex < total) {
            // Wait while paused (between sentences)
            while (readAloudPaused && readAloudActive) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!readAloudActive) break;

            const index = readAloudIndex;
            if (!preloadCache[index]) preloadSentence(index);

            let url;
            try {
                url = await preloadCache[index];
            } catch (e) {
                console.error('Preload failed for sentence', index, e);
                readAloudIndex++;
                continue;
            }

            if (!readAloudActive) break;

            highlightSentence(index);
            sendProgress(index + 1, total);

            // Preload next sentences while this one plays
            for (let i = 1; i <= PRELOAD_AHEAD; i++) preloadSentence(index + i);

            try {
                await playAudioUrl(url);
            } catch (e) {
                console.error('Playback error', e);
            }

            URL.revokeObjectURL(url);
            delete preloadCache[index];
            readAloudIndex++;
        }

        if (readAloudActive) {
            showNotification('Reading complete!', 'success');
            chrome.runtime.sendMessage({ action: 'readAloudDone' }).catch(() => {});
            sendToPanel({ action: 'readAloudDone' });
            const continuing = await tryAutoNextChapter();
            if (!continuing) clearAutoStopState();
        }
        cleanupReadAloud(false);
    }

    function findNextChapterLink(customSelector) {
        // 1. User-specified selector
        if (customSelector) {
            try {
                const el = document.querySelector(customSelector);
                if (el) {
                    const a = el.tagName === 'A' ? el : (el.querySelector('a') || el.closest('a'));
                    if (a && a.href) return a.href;
                }
            } catch (e) {}
        }
        // 2. <link rel="next"> in <head>
        const linkRel = document.querySelector('link[rel="next"]');
        if (linkRel && linkRel.href) return linkRel.href;
        // 3. <a rel="next">
        const aRel = document.querySelector('a[rel="next"]');
        if (aRel && aRel.href) return aRel.href;
        // 4. Common "next" text patterns
        const nextRe = /^(next|tiếp|tiếp theo|chương sau|chap sau|next chapter|→|»|›|>>|>)$/i;
        for (const a of document.querySelectorAll('a')) {
            if (nextRe.test(a.textContent.trim()) && a.href) return a.href;
        }
        // 5. Chapter number in URL — find link pointing to current+1
        const chRe = /[\/\-_](?:chuong|chapter|chap|ch)[\/\-_]?0*(\d+)/i;
        const curMatch = window.location.href.match(chRe);
        if (curMatch) {
            const nextNum = parseInt(curMatch[1]) + 1;
            const nextUrlRe = new RegExp(`[/\\-_](?:chuong|chapter|chap|ch)[/\\-_]?0*${nextNum}(?:[^\\d]|$)`, 'i');
            for (const a of document.querySelectorAll('a')) {
                if (a.href && a.href !== window.location.href && nextUrlRe.test(a.href)) return a.href;
            }
        }
        return null;
    }

    function findNextChapterButton(customSelector) {
        const nextRe = /^(next|tiếp|tiếp theo|chương sau|chap sau|next chapter|→|»|›|>>|>)$/i;
        // 1. User-specified selector pointing to a button
        if (customSelector) {
            try {
                const el = document.querySelector(customSelector);
                if (el) {
                    const btn = el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el.closest('button'));
                    if (btn && !btn.disabled) return btn;
                }
            } catch (e) {}
        }
        // 2. Any button whose text matches "next" patterns
        for (const btn of document.querySelectorAll('button')) {
            if (!btn.disabled && nextRe.test(btn.textContent.trim())) return btn;
        }
        return null;
    }

    // For SPA sites: after clicking a next-chapter button the URL changes via
    // pushState but the page never reloads, so checkAutoStart() never fires.
    // Poll for the URL change here and start reading directly in this context.
    // If the click causes a real page reload instead, the browser tears down this
    // context before the interval fires and checkAutoStart() on the new page
    // handles it via the per-domain _autoStart:: flag.
    async function spaAutoStart(prevUrl) {
        const deadline = Date.now() + 10000;
        const changed = await new Promise(resolve => {
            const poll = setInterval(() => {
                if (location.href !== prevUrl || Date.now() > deadline) {
                    clearInterval(poll);
                    resolve(location.href !== prevUrl);
                }
            }, 200);
        });
        if (!changed) return;
        // SPA navigation confirmed — clear the flag and start reading here
        await chrome.storage.local.set({ [`_autoStart::${location.hostname}`]: false });
        await new Promise(r => setTimeout(r, 1500)); // wait for content to render
        const domainKey = `cfg::${location.hostname}`;
        const stored = await chrome.storage.local.get({ [domainKey]: null, preloadAhead: 10 });
        const cfg = stored[domainKey] ?? { preloadAhead: stored.preloadAhead, contentSelector: '', ignoreSelector: '', autoStopMinutes: 30 };
        startReadAloud(cfg.preloadAhead, cfg.contentSelector, cfg.ignoreSelector, cfg.autoStopMinutes, true);
    }

    // Returns true if a chapter jump was scheduled (the reading session is
    // continuing onto a new page) — callers use this to decide whether the
    // persisted auto-stop countdown should survive or be cleared.
    async function tryAutoNextChapter() {
        const domainKey = `cfg::${location.hostname}`;
        const stored = await chrome.storage.local.get({ [domainKey]: null });
        const settings = stored[domainKey] ?? {};
        if (!settings.autoNextChapter) return false;
        const customSelector = settings.nextChapterSelector || '';
        const nextUrl = findNextChapterLink(customSelector);
        if (nextUrl) {
            showNotification('Next chapter in 2s…', 'info');
            await chrome.storage.local.set({ [`_autoStart::${location.hostname}`]: true });
            setTimeout(() => { window.location.href = nextUrl; }, 2000);
            return true;
        }
        const nextBtn = findNextChapterButton(customSelector);
        if (nextBtn) {
            showNotification('Next chapter in 2s…', 'info');
            await chrome.storage.local.set({ [`_autoStart::${location.hostname}`]: true });
            const prevUrl = location.href;
            setTimeout(() => { nextBtn.click(); spaAutoStart(prevUrl); }, 2000);
            return true;
        }
        showNotification('No next chapter found', 'error');
        return false;
    }

    // Auto-start reading if navigated here from auto-next-chapter
    async function checkAutoStart() {
        const autoStartKey = `_autoStart::${location.hostname}`;
        const result = await chrome.storage.local.get({ [autoStartKey]: false });
        if (!result[autoStartKey]) return;
        await chrome.storage.local.set({ [autoStartKey]: false });
        // Wait for page to fully render
        await new Promise(r => setTimeout(r, 1500));
        // Load domain-specific config (same key the panel saves into)
        const domainKey = `cfg::${location.hostname}`;
        const stored = await chrome.storage.local.get({ [domainKey]: null, preloadAhead: 10 });
        const cfg = stored[domainKey] ?? { preloadAhead: stored.preloadAhead, contentSelector: '', ignoreSelector: '', autoStopMinutes: 30 };
        startReadAloud(cfg.preloadAhead, cfg.contentSelector, cfg.ignoreSelector, cfg.autoStopMinutes, true);
        chrome.runtime.sendMessage({ action: 'readAloudAutoStarted' }).catch(() => {});
        sendToPanel({ action: 'readAloudAutoStarted' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { checkAutoStart(); checkBatchMode(); });
    } else {
        checkAutoStart();
        checkBatchMode();
    }

    function cleanupReadAloud(notify = true) {
        readAloudActive = false;
        readAloudPaused = false;

        if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
        if (_domObserver) { _domObserver.disconnect(); _domObserver = null; }
        if (currentReadAudio) { currentReadAudio.pause(); currentReadAudio = null; }
        Object.entries(preloadCache).forEach(([k, p]) => {
            p.then(url => URL.revokeObjectURL(url)).catch(() => {});
            delete preloadCache[k];
        });
        preloadReady.clear();
        document.getElementById('kokoro-highlight-style')?.remove();
        document.querySelectorAll('[data-kokoro-s]').forEach(el => {
            el.replaceWith(document.createTextNode(el.textContent));
        });
        if (notify) showNotification('Reading stopped', 'info');
        if (_updatePlayPauseBtn) _updatePlayPauseBtn();
    }

    // Clears the persisted auto-stop countdown target for this site. Only
    // call this when the listening session is truly ending (manual stop,
    // the timer itself firing, or finishing with no next chapter to jump
    // to) — NOT on every cleanupReadAloud(), since a successful chapter
    // jump also runs through cleanupReadAloud() and must let the countdown
    // survive into the next page load.
    function clearAutoStopState() {
        if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
        chrome.storage.local.remove(`_autoStopAt::${location.hostname}`).catch(() => {});
    }

    // Stops reading (without advancing to the next chapter, unlike finishing
    // normally) once `minutes` of wall-clock time have passed since the
    // session started — runs regardless of pause state, same as an
    // audiobook sleep timer.
    function autoStopReadAloud(minutes) {
        showNotification(`Auto-stopped after ${minutes}m`, 'info');
        chrome.runtime.sendMessage({ action: 'readAloudDone' }).catch(() => {});
        sendToPanel({ action: 'readAloudDone' });
        clearAutoStopState();
        cleanupReadAloud(false);
    }

    // `continueCountdown` distinguishes the two ways startReadAloud() can be
    // called without an explicit stop having happened first:
    //  - true  (checkAutoStart/spaAutoStart only): resuming into a NEW page
    //    because auto-next-chapter just jumped here — inherit the running
    //    countdown so a marathon session actually adds up across chapters.
    //  - false/omitted (every manual trigger — button clicks, panel
    //    messages): always start a brand-new N-minute countdown, even if a
    //    stale unexpired target happens to still be sitting in storage from
    //    before (e.g. the user just reloaded the page and pressed Play
    //    again — that's a fresh listening session from the user's
    //    perspective, not a continuation, even though nothing explicitly
    //    cleared storage on the reload).
    async function startReadAloud(preloadAhead, contentSelector, ignoreSelector, autoStopMinutes, continueCountdown = false) {
        if (readAloudActive) { clearAutoStopState(); cleanupReadAloud(); return; }
        if (preloadAhead) PRELOAD_AHEAD = preloadAhead;

        const container = extractMainContent(contentSelector);
        readAloudSentences = wrapContentSentences(container, ignoreSelector);
        if (readAloudSentences.length === 0) {
            showNotification('No readable text found', 'error'); return;
        }

        readAloudActive = true;
        readAloudIndex = 0;
        if (_updatePlayPauseBtn) _updatePlayPauseBtn();
        injectHighlightStyle();
        startDOMObserver(container);

        if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
        const stopMinutes = Number(autoStopMinutes);
        if (stopMinutes > 0) {
            // Countdown target is persisted (not just an in-memory setTimeout)
            // so it survives auto-advancing to the next chapter — each chapter
            // is a fresh page load / fresh content-script instance, so a
            // purely in-memory timer would silently reset to the full N
            // minutes every time, never actually firing across a multi-hour
            // multi-chapter reading marathon.
            const stopKey = `_autoStopAt::${location.hostname}`;
            const now = Date.now();
            let autoStopAt = null;
            if (continueCountdown) {
                const stored = await chrome.storage.local.get({ [stopKey]: 0 });
                if (stored[stopKey] && stored[stopKey] > now) autoStopAt = stored[stopKey];
            }
            if (!autoStopAt) {
                autoStopAt = now + stopMinutes * 60 * 1000;
            }
            await chrome.storage.local.set({ [stopKey]: autoStopAt });
            const remainingMs = autoStopAt - now;
            if (remainingMs <= 0) {
                autoStopReadAloud(stopMinutes);
                return;
            }
            autoStopTimer = setTimeout(() => autoStopReadAloud(stopMinutes), remainingMs);
        }

        const initialCount = Math.min(PRELOAD_AHEAD, readAloudSentences.length);
        for (let i = 0; i < initialCount; i++) preloadSentence(i);

        showNotification(`Preloading ${initialCount} sentences…`, 'loading');
        sendProgress(0, readAloudSentences.length);

        await Promise.all(
            Array.from({ length: initialCount }, (_, i) => preloadCache[i].catch(() => {}))
        );

        if (!readAloudActive) return; // Was stopped while preloading
        showNotification('Starting…', 'loading');
        readAloudLoop();
    }

    // Stop Read Aloud with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && readAloudActive) { clearAutoStopState(); cleanupReadAloud(); e.preventDefault(); }
    });

    // ─── Batch Convert Mode ────────────────────────────────────────────────────
    // Sends full chapter text to server for offline MP3 export, then auto-advances.

    let batchActive = false;
    let batchPollInterval = null;
    let _batchNavTimer = null;

    function extractFullChapterText(contentSelector, ignoreSelector) {
        const container = extractMainContent(contentSelector);
        const parts = [];
        const MARK = 'data-kokoro-batch';

        // Pass 1: same node set as wrapContentSentences
        container.querySelectorAll('p, h1, h2, h3, h4, li').forEach(node => {
            if (ignoreSelector) {
                try {
                    if (node.matches(ignoreSelector) || node.closest(ignoreSelector)) return;
                } catch (e) {}
            }
            if (node.querySelector('br')) return; // handled in pass 2
            const text = node.innerText.trim();
            if (text && text.length >= 3) {
                parts.push(text);
                node.setAttribute(MARK, '1');
            }
        });

        // Pass 2: br-separated content (mirrors walkBrContent)
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
        let group = [];

        function flushGroup() {
            if (!group.length) return;
            const text = group.map(n =>
                n.nodeType === Node.TEXT_NODE ? n.textContent : (n.innerText || n.textContent)
            ).join('').trim();
            group = [];
            if (text && text.length >= 3) parts.push(text);
        }

        function walkBr(root) {
            Array.from(root.childNodes).forEach(child => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (SKIP.has(child.nodeName)) return;
                    if (child.nodeName === 'BR') {
                        flushGroup();
                    } else if (child.querySelector && child.querySelector(`[${MARK}]`)) {
                        flushGroup(); // subtree already handled in pass 1
                    } else if (child.textContent.trim()) {
                        const s = getComputedStyle(child);
                        const isBlock = s.display !== 'inline' && s.display !== 'inline-block' && s.display !== 'inline-flex';
                        if (isBlock) { flushGroup(); walkBr(child); }
                        else group.push(child);
                    }
                } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                    group.push(child);
                }
            });
            flushGroup();
        }

        walkBr(container);
        container.querySelectorAll(`[${MARK}]`).forEach(el => el.removeAttribute(MARK));
        return parts.join('\n');
    }

    function extractNovelAndChapter() {
        const parts = location.pathname.split('/').filter(Boolean);
        const chapterRe = /^(?:chuong|chapter|chap|ch)[_\-]?0*(\d+)/i;
        let novelSlug = '';
        let chNum = null;
        for (let i = 0; i < parts.length; i++) {
            const m = parts[i].match(chapterRe);
            if (m) { chNum = m[1]; if (i > 0) novelSlug = parts[i - 1]; break; }
        }
        if (!chNum) {
            const m = location.pathname.match(/[\/\-_](?:chuong|chapter|chap|ch)[\/\-_]?0*(\d+)/i);
            if (m) chNum = m[1];
        }
        if (!novelSlug) {
            novelSlug = parts.find(p => p.length > 3 && !/^\d+$/.test(p) && !chapterRe.test(p)) || parts[0] || '';
        }
        novelSlug = novelSlug.replace(/[-]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').replace(/^_+|_+$/g, '').slice(0, 60)
            || location.hostname.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
        return { novelSlug, chNum };
    }

    async function startBatchMode(contentSelector, ignoreSelector, nextChapterSelector) {
        if (batchActive) return;
        batchActive = true;
        sendToPanel({ action: 'batchAutoStarted' });

        try {
            const text = extractFullChapterText(contentSelector, ignoreSelector);
            if (!text || text.length < 10) {
                showNotification('Batch: no text found on this page', 'error');
                batchActive = false;
                sendToPanel({ action: 'batchStopped' });
                return;
            }

            showNotification(`Batch: submitting ${text.length} chars…`, 'loading');
            sendToPanel({ action: 'batchProgress', progress: 0, total: text.length });

            const tts = await chrome.storage.local.get({ model: '', voice: 'vi_default', speed: 1.0, language: 'vi' });
            const { novelSlug, chNum } = extractNovelAndChapter();
            const body = {
                text,
                novel_name: novelSlug,
                chapter: chNum,
                voice: tts.voice,
                speed: tts.speed,
                language: tts.language,
            };
            if (tts.model) body.model = tts.model;

            const submitResp = await fetch('http://localhost:8000/batch_submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!submitResp.ok) throw new Error(`Submit failed: ${submitResp.status}`);
            const { job_id: jobId } = await submitResp.json();

            // Poll for completion
            batchPollInterval = setInterval(async () => {
                if (!batchActive) { clearInterval(batchPollInterval); return; }
                try {
                    const r = await fetch(`http://localhost:8000/batch_status/${jobId}`);
                    if (!r.ok) return;
                    const job = await r.json();

                    sendToPanel({ action: 'batchProgress', progress: job.progress || 0 });
                    showNotification(`Batch: ${job.progress || 0}% processed…`, 'loading');

                    if (job.status === 'done') {
                        clearInterval(batchPollInterval);
                        sendToPanel({ action: 'batchDone', file: job.file });
                        const delaySec = Math.floor(Math.random() * 8) + 8;
                        let remaining = delaySec;
                        const countdownEl = document.getElementById('kokoro-tts-notification') || document.createElement('div');
                        countdownEl.id = 'kokoro-tts-notification';
                        countdownEl.textContent = `Batch: chapter saved! Next in ${remaining}s…`;
                        Object.assign(countdownEl.style, {
                            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                            backgroundColor: '#4CAF50', color: 'white', padding: '12px 20px',
                            borderRadius: '6px', fontSize: '14px', fontWeight: '500',
                            zIndex: '10001', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', opacity: '1'
                        });
                        if (!countdownEl.parentNode) document.body.appendChild(countdownEl);
                        const countdownInterval = setInterval(() => {
                            remaining--;
                            if (remaining > 0) {
                                countdownEl.textContent = `Batch: chapter saved! Next in ${remaining}s…`;
                            } else {
                                clearInterval(countdownInterval);
                                countdownEl.remove();
                            }
                        }, 1000);
                        _batchNavTimer = setTimeout(async () => {
                            _batchNavTimer = null;
                            clearInterval(countdownInterval);
                            countdownEl.remove();
                            if (!batchActive) return;
                            await advanceBatchChapter(contentSelector, ignoreSelector, nextChapterSelector);
                        }, delaySec * 1000);

                    } else if (job.status === 'error') {
                        clearInterval(batchPollInterval);
                        showNotification(`Batch error: ${job.error}`, 'error');
                        batchActive = false;
                        sendToPanel({ action: 'batchError', error: job.error });
                    }
                } catch (e) {
                    console.error('Batch poll error:', e);
                }
            }, 5000);

        } catch (e) {
            showNotification(`Batch failed: ${e.message}`, 'error');
            batchActive = false;
            sendToPanel({ action: 'batchError', error: e.message });
        }
    }

    async function advanceBatchChapter(contentSelector, ignoreSelector, nextChapterSelector) {
        const nextUrl = findNextChapterLink(nextChapterSelector);
        if (nextUrl) {
            await chrome.storage.local.set({
                [`_batchMode::${location.hostname}`]: { contentSelector, ignoreSelector, nextChapterSelector }
            });
            window.location.href = nextUrl;
            return;
        }
        const nextBtn = findNextChapterButton(nextChapterSelector);
        if (nextBtn) {
            await chrome.storage.local.set({
                [`_batchMode::${location.hostname}`]: { contentSelector, ignoreSelector, nextChapterSelector }
            });
            const prevUrl = location.href;
            nextBtn.click();
            // SPA: poll for URL change then restart batch
            const deadline = Date.now() + 10000;
            const poll = setInterval(async () => {
                if (location.href !== prevUrl || Date.now() > deadline) {
                    clearInterval(poll);
                    if (location.href !== prevUrl) {
                        await chrome.storage.local.remove([`_batchMode::${location.hostname}`]);
                        await new Promise(r => setTimeout(r, 1500));
                        batchActive = false;
                        startBatchMode(contentSelector, ignoreSelector, nextChapterSelector);
                    }
                }
            }, 300);
            return;
        }
        showNotification('Batch: no next chapter found, done.', 'info');
        batchActive = false;
        sendToPanel({ action: 'batchStopped' });
    }

    function stopBatchMode() {
        batchActive = false;
        if (_batchNavTimer) { clearTimeout(_batchNavTimer); _batchNavTimer = null; }
        if (batchPollInterval) { clearInterval(batchPollInterval); batchPollInterval = null; }
        chrome.storage.local.remove([`_batchMode::${location.hostname}`]);
        showNotification('Batch mode stopped', 'info');
        sendToPanel({ action: 'batchStopped' });
    }

    async function checkBatchMode() {
        const key = `_batchMode::${location.hostname}`;
        const result = await chrome.storage.local.get({ [key]: null });
        if (!result[key]) return;
        const cfg = result[key];
        await chrome.storage.local.remove([key]);
        await new Promise(r => setTimeout(r, 1500));
        startBatchMode(cfg.contentSelector || '', cfg.ignoreSelector || '', cfg.nextChapterSelector || '');
        // Panel may already be open and missed the batchAutoStarted from startBatchMode
        setTimeout(() => { if (batchActive) sendToPanel({ action: 'batchAutoStarted' }); }, 200);
    }

    // ───────────────────────────────────────────────────────────────────────────

    // Listener for messages from the background script to play audio OR show status
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'playTTSAudio' && (request.audioUrl || request.audioData)) {
            console.log("Content Script: Received 'playTTSAudio' message from background script (non-streaming).");
            // background.js is a service worker (no DOM / URL.createObjectURL), so
            // it sends the raw bytes here and we build the blob URL in-page.
            const audioUrl = request.audioUrl || URL.createObjectURL(new Blob([request.audioData], { type: 'audio/wav' }));
            playAudioInPage(audioUrl);
            // Update the in-page notification when audio data is received and playback is initiated
            showNotification('Speech generated and now playing! 🎉', 'success');
            sendResponse({success: true}); // Acknowledge receipt
            return true; // Indicate async response
        } else if (request.action === 'showGeneratingSpeech') {
            console.log("Content Script: Received 'showGeneratingSpeech' message from background script.");
            // For streaming, this notification is shown before fetch starts.
            // For non-streaming, it's shown here.
            showNotification('Generating speech...', 'loading');
            sendResponse({success: true});
            return true;
        } else if (request.action === 'streamTTSChunk') {
            audioQueue.push(request.chunk);
            processQueue();
            sendResponse({success: true}); // Acknowledge receipt of chunk
            return true;
        }
        else if (request.action === 'streamEnd') {
            streamingComplete = true;
            const checkDone = setInterval(() => {
                if (!isPlaying) {
                    clearInterval(checkDone);
                    showNotification('Speech stream completed! 🎉', 'success');
                }
            }, 100);
            sendResponse({success: true});
            return true;
        }
        else if (request.action === 'streamError') {
            stopStreamingAudio();
            showNotification(`Speech stream error: ${request.error}`, 'error');
            sendResponse({success: true});
            return true;
        } else if (request.action === 'startReadAloud') {
            startReadAloud(request.preloadAhead, request.contentSelector, request.ignoreSelector, request.autoStopMinutes);
            sendResponse({success: true});
            return true;
        } else if (request.action === 'pauseReadAloud') {
            readAloudPaused = true;
            if (currentReadAudio) currentReadAudio.pause();
            sendResponse({success: true});
            return true;
        } else if (request.action === 'resumeReadAloud') {
            readAloudPaused = false;
            if (currentReadAudio) currentReadAudio.play().catch(() => {});
            sendResponse({success: true});
            return true;
        } else if (request.action === 'stopReadAloud') {
            clearAutoStopState();
            cleanupReadAloud();
            sendResponse({success: true});
            return true;
        } else if (request.action === 'setBtnGroupVisible') {
            const btnGroup = document.getElementById('kokoro-btn-group');
            if (request.visible) {
                if (!btnGroup) {
                    injectPanel();
                } else {
                    btnGroup.style.display = 'flex';
                }
            } else {
                if (btnGroup) {
                    btnGroup.style.display = 'none';
                    // slide panel closed if open
                    const iframe = document.getElementById('kokoro-panel-iframe');
                    if (iframe) iframe.style.transform = 'translateX(100%)';
                }
            }
            sendResponse({ success: true });
            return true;
        }
    });
    
    // Listen for escape key to stop streaming audio
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isPlaying) {
            stopStreamingAudio();
            e.preventDefault(); // Prevent default escape behavior if any
        }
    });
    
})(); // End of IIFE for content script
