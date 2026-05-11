// Content script for Kokoro TTS addon
// This script is injected into every webpage to provide in-page TTS features.

(function() {
    'use strict';
    const browser = chrome;
    
    let isFloatingButtonVisible = false;
    let floatingButton = null;
    let lastSelection = '';
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
            sendToPanel({ action: 'pageInfo', domain: location.hostname });
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
            borderRadius: '0 0 0 8px',
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
                const cfg = stored[domainKey] ?? { preloadAhead: stored.preloadAhead, contentSelector: '', ignoreSelector: '' };
                startReadAloud(cfg.preloadAhead, cfg.contentSelector, cfg.ignoreSelector);
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

        btnGroup.appendChild(toggleBtn);
        btnGroup.appendChild(playPauseBtn);
        document.body.appendChild(btnGroup);
        _updatePlayPauseBtn = updatePlayPauseBtn;

        // Relay messages from panel → read-aloud functions
        window.addEventListener('message', async (e) => {
            if (!e.data || e.data.source !== 'kokoro-panel') return;
            const { action } = e.data;

            if (action === 'getPageDomain') {
                sendToPanel({ action: 'pageInfo', domain: location.hostname });

            } else if (action === 'closePanel') {
                panelOpen = false;
                panelIframe.style.transform = 'translateX(100%)';
                btnGroup.style.right = '0';
                toggleBtn.textContent = '🎙️';

            } else if (action === 'startReadAloud') {
                startReadAloud(e.data.preloadAhead, e.data.contentSelector, e.data.ignoreSelector);

            } else if (action === 'pauseReadAloud') {
                readAloudPaused = true;
                if (currentReadAudio) currentReadAudio.pause();
                if (_updatePlayPauseBtn) _updatePlayPauseBtn();

            } else if (action === 'resumeReadAloud') {
                readAloudPaused = false;
                if (currentReadAudio) currentReadAudio.play().catch(() => {});
                if (_updatePlayPauseBtn) _updatePlayPauseBtn();

            } else if (action === 'stopReadAloud') {
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

    /**
     * Creates and returns the floating TTS button element.
     * Only creates it once.
     * @returns {HTMLElement} The floating button element.
     */
    function createFloatingButton() {
        if (floatingButton) return floatingButton;

        floatingButton = document.createElement('div');
        floatingButton.id = 'kokoro-tts-float-btn';
        floatingButton.innerHTML = '💬';
        floatingButton.title = 'Speak with Kokoro TTS';
        
        Object.assign(floatingButton.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            width: '50px',
            height: '50px',
            backgroundColor: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '50%',
            fontSize: '20px',
            cursor: 'pointer',
            zIndex: '10000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            transition: 'all 0.3s ease',
            transform: 'scale(0)',
            opacity: '0'
        });
        
        floatingButton.addEventListener('mouseenter', () => {
            floatingButton.style.transform = 'scale(1.1)';
            floatingButton.style.backgroundColor = '#5a67d8';
        });
        
        floatingButton.addEventListener('mouseleave', () => {
            floatingButton.style.transform = 'scale(1)';
            floatingButton.style.backgroundColor = '#667eea';
        });
        
        floatingButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (lastSelection) {
                await generateTTS(lastSelection); 
                hideFloatingButton();
            } else {
                showNotification('No text was selected when button appeared', 'error');
            }
        });
        
        document.body.appendChild(floatingButton);
        return floatingButton;
    }
    
    function showFloatingButton() {
        if (!floatingButton) createFloatingButton();
        
        floatingButton.style.display = 'flex';
        setTimeout(() => {
            floatingButton.style.transform = 'scale(1)';
            floatingButton.style.opacity = '1';
        }, 10);
        
        isFloatingButtonVisible = true;
    }
    
    function hideFloatingButton() {
        if (!floatingButton) return;
        
        floatingButton.style.transform = 'scale(0)';
        floatingButton.style.opacity = '0';
        
        setTimeout(() => {
            if (floatingButton) {
                floatingButton.style.display = 'none';
            }
        }, 300);
        
        isFloatingButtonVisible = false;
    }
    
    document.addEventListener('mouseup', () => {
        setTimeout(() => {
            const currentSelectionText = window.getSelection().toString().trim();
            if (currentSelectionText && currentSelectionText.length > 0) {
                if (currentSelectionText !== lastSelection) {
                    lastSelection = currentSelectionText;
                    showFloatingButton();
                }
            } else {
                lastSelection = '';
                if (isFloatingButtonVisible) {
                    hideFloatingButton();
                }
            }
        }, 100);
    });
    
    document.addEventListener('click', (e) => {
        if (e.target !== floatingButton && isFloatingButtonVisible) {
            const currentSelectionCheck = window.getSelection().toString().trim();
            if (!currentSelectionCheck) {
                hideFloatingButton();
            }
        }
    });
    
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
        return raw.map(s => s.trim()).filter(s => s.length > 2);
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

    function updateReadingBar(text) {
        let bar = document.getElementById('kokoro-reading-bar');
        if (!text) { if (bar) bar.style.display = 'none'; return; }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'kokoro-reading-bar';
            Object.assign(bar.style, {
                position: 'fixed', bottom: '20px', left: '50%',
                transform: 'translateX(-50%)', maxWidth: '70%',
                background: 'rgba(20,20,20,0.88)', color: '#fff',
                padding: '7px 18px', borderRadius: '20px',
                fontSize: '13px', lineHeight: '1.4', zIndex: '2147483647',
                boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
                pointerEvents: 'none', textAlign: 'center',
                borderLeft: '3px solid rgba(255,220,50,0.9)'
            });
            document.body.appendChild(bar);
        }
        bar.textContent = text;
        bar.style.display = 'block';
    }

    function highlightSentence(index) {
        document.querySelectorAll('[data-kokoro-s].kokoro-reading').forEach(el => el.classList.remove('kokoro-reading'));
        const span = document.querySelector(`[data-kokoro-s="${index}"]`);
        if (span) {
            span.classList.add('kokoro-reading');
            updateReadingBar(span.textContent.trim());
            if (!userScrolling) {
                span.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    async function fetchAudioUrl(text) {
        const settings = await chrome.storage.local.get({ voice: 'vi_default', speed: 1.0, language: 'vi' });
        const response = await fetch('http://localhost:8000/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: settings.voice, speed: settings.speed, language: settings.language })
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
                currentReadAudio.play().catch(reject);
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
            await tryAutoNextChapter();
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

    async function tryAutoNextChapter() {
        const domainKey = `cfg::${location.hostname}`;
        const stored = await chrome.storage.local.get({ [domainKey]: null });
        const settings = stored[domainKey] ?? {};
        if (!settings.autoNextChapter) return;
        const nextUrl = findNextChapterLink(settings.nextChapterSelector || '');
        if (!nextUrl) { showNotification('No next chapter found', 'error'); return; }
        showNotification('Next chapter in 2s…', 'info');
        await chrome.storage.local.set({ _autoStartReadAloud: true });
        setTimeout(() => { window.location.href = nextUrl; }, 2000);
    }

    // Auto-start reading if navigated here from auto-next-chapter
    async function checkAutoStart() {
        const result = await chrome.storage.local.get({ _autoStartReadAloud: false });
        if (!result._autoStartReadAloud) return;
        await chrome.storage.local.set({ _autoStartReadAloud: false });
        // Wait for page to fully render
        await new Promise(r => setTimeout(r, 1500));
        const s = await chrome.storage.local.get({ preloadAhead: 10, contentSelector: '', ignoreSelector: '' });
        startReadAloud(s.preloadAhead, s.contentSelector, s.ignoreSelector);
        chrome.runtime.sendMessage({ action: 'readAloudAutoStarted' }).catch(() => {});
        sendToPanel({ action: 'readAloudAutoStarted' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAutoStart);
    } else {
        checkAutoStart();
    }

    function cleanupReadAloud(notify = true) {
        readAloudActive = false;
        readAloudPaused = false;
        if (_domObserver) { _domObserver.disconnect(); _domObserver = null; }
        if (currentReadAudio) { currentReadAudio.pause(); currentReadAudio = null; }
        Object.entries(preloadCache).forEach(([k, p]) => {
            p.then(url => URL.revokeObjectURL(url)).catch(() => {});
            delete preloadCache[k];
        });
        preloadReady.clear();
        updateReadingBar('');
        document.getElementById('kokoro-highlight-style')?.remove();
        document.querySelectorAll('[data-kokoro-s]').forEach(el => {
            el.replaceWith(document.createTextNode(el.textContent));
        });
        if (notify) showNotification('Reading stopped', 'info');
        if (_updatePlayPauseBtn) _updatePlayPauseBtn();
    }

    async function startReadAloud(preloadAhead, contentSelector, ignoreSelector) {
        if (readAloudActive) { cleanupReadAloud(); return; }
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
        if (e.key === 'Escape' && readAloudActive) { cleanupReadAloud(); e.preventDefault(); }
    });

    // ───────────────────────────────────────────────────────────────────────────

    // Listener for messages from the background script to play audio OR show status
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'playTTSAudio' && request.audioUrl) {
            console.log("Content Script: Received 'playTTSAudio' message from background script (non-streaming).");
            playAudioInPage(request.audioUrl);
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
            startReadAloud(request.preloadAhead, request.contentSelector, request.ignoreSelector);
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
