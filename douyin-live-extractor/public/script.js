const state = {
    token: localStorage.getItem('douyin_token') || null,
    currentUrl: '',
    player: null
};

// Elements
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const urlInput = document.getElementById('url-input');
const extractBtn = document.getElementById('extract-btn');
const infoSection = document.getElementById('info-section');
const qualitySection = document.getElementById('quality-section');
const qualityButtons = document.getElementById('quality-buttons');
const playerContainer = document.getElementById('player-container');
const videoElement = document.getElementById('video-player');

const speedSelect = document.getElementById('speed-select');
const forwardBtn = document.getElementById('forward-btn');
const reloadBtn = document.getElementById('reload-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const qualitySelect = document.getElementById('quality-select');

// --- Auth Logic ---

function checkAuth() {
    if (state.token) {
        showDashboard();
    } else {
        showLogin();
    }
}

function showLogin() {
    loginScreen.classList.remove('hidden');
    dashboardScreen.classList.add('hidden');
}

function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
}

async function handleLogin() {
    const username = usernameInput.value;
    const password = passwordInput.value;

    try {
        const res = await axios.post('/api/login', { username, password });
        if (res.data.success) {
            state.token = res.data.token;
            localStorage.setItem('douyin_token', state.token);
            checkAuth();
        }
    } catch (err) {
        loginError.textContent = err.response?.data?.error || 'Login failed';
    }
}

function handleLogout() {
    state.token = null;
    localStorage.removeItem('douyin_token');
    checkAuth();
}

// --- Extraction Logic ---

async function handleExtract() {
    const url = urlInput.value;
    if (!url) return;

    extractBtn.textContent = 'Parsing...';
    extractBtn.disabled = true;
    infoSection.classList.add('hidden');
    qualitySection.classList.add('hidden');
    playerContainer.classList.add('hidden');
    destroyPlayer();

    // Direct Stream Support
    // Check path extension instead of full URL
    const urlPath = url.split('?')[0];
    if (urlPath.endsWith('.flv') || urlPath.endsWith('.m3u8')) {
        const type = urlPath.endsWith('.flv') ? 'flv' : 'm3u8';
        const filename = urlPath.split('/').pop();

        const directData = {
            title: 'Direct Stream Playback',
            anchor_name: 'Direct Link',
            cover: '', // No cover for direct link
            flv: type === 'flv' ? { 'original': { url, sdk_params: {}, label: 'Original' } } : {},
            hls: type === 'm3u8' ? { 'original': { url, sdk_params: {}, label: 'Original' } } : {}
        };

        renderInfo(directData);
        renderQualities(directData);
        state.currentUrl = url;
        addToHistory(directData, url);

        // Auto play
        playStream(url, type);

        extractBtn.textContent = 'Parse';
        extractBtn.disabled = false;
        return;
    }

    try {
        const res = await axios.get('/api/live', {
            params: { url: url },
            headers: { 'x-api-key': state.token }
        });

        if (res.data.success) {
            renderInfo(res.data.data);
            renderQualities(res.data.data);
            state.currentUrl = url; // Save for reload
            addToHistory(res.data.data, url);
        }
    } catch (err) {
        if (err.response && (err.response.status === 401 || err.response.status === 403)) {
            // Token expired or invalid
            handleLogout();
            loginError.textContent = 'Session expired, please login again.';
        } else {
            alert(err.response?.data?.error || 'Failed to extract stream data');
        }
    } finally {
        extractBtn.textContent = 'Parse';
        extractBtn.disabled = false;
    }
}

function renderInfo(data) {
    document.getElementById('room-title').textContent = data.title;
    document.getElementById('anchor-name').textContent = data.anchor_name;
    document.getElementById('cover-img').src = data.cover || '';
    infoSection.classList.remove('hidden');
}

function renderQualities(data) {
    qualityButtons.innerHTML = '';

    // Combine FLV and HLS for selection
    // Prefer FLV as it's usually lower latency
    const streams = [];

    if (data.flv) {
        Object.keys(data.flv).forEach(key => {
            streams.push({ type: 'flv', key, ...data.flv[key] });
        });
    }

    // Add HLS if wanted, or just as backup. 
    // For now, let's just list FLV first, then HLS if FLV empty.
    // Or just list all unique qualities.
    if (streams.length === 0 && data.hls) {
        Object.keys(data.hls).forEach(key => {
            streams.push({ type: 'm3u8', key, ...data.hls[key] });
        });
    }

    qualitySelect.innerHTML = '';
    streams.forEach(stream => {
        const btn = document.createElement('button');
        btn.className = 'quality-btn';
        btn.textContent = `${stream.label} (${stream.type})`;
        btn.onclick = () => {
            document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            playStream(stream.url, stream.type);
        };
        qualityButtons.appendChild(btn);

        // Populate dropdown
        const option = document.createElement('option');
        option.value = JSON.stringify({ url: stream.url, type: stream.type });
        option.textContent = `${stream.label} (${stream.type})`;
        qualitySelect.appendChild(option);
    });

    // Select first one by default in dropdown if exists
    if (streams.length > 0) {
        qualitySelect.value = JSON.stringify({ url: streams[0].url, type: streams[0].type });
    }

    qualitySection.classList.remove('hidden');
}

// --- Player Logic ---

function destroyPlayer() {
    if (state.player) {
        if (state.player.destroy) state.player.destroy();
        // HLS.js uses destroy(), flv.js also destroy()
        state.player = null;
    }
    // Also stop video element
    videoElement.pause();
    videoElement.src = '';
    videoElement.load();
}

function playStream(url, type) {
    destroyPlayer();
    playerContainer.classList.remove('hidden');

    // Handle FLV
    if (type === 'flv' || url.endsWith('.flv')) {
        if (flvjs.isSupported()) {
            const player = flvjs.createPlayer({
                type: 'flv',
                url: url,
                isLive: true,
                hasAudio: true,
                hasVideo: true
            }, {
                enableStashBuffer: false, // Reduce latency
                lazyLoad: false,
                autoCleanupSourceBuffer: true
            });
            player.attachMediaElement(videoElement);
            player.load();
            player.play().catch(e => console.error("Auto-play blocked", e));
            state.player = player;
        } else {
            console.error('FLV is not supported in this browser');
        }
    }
    // Handle HLS
    else if (type === 'm3u8' || url.endsWith('.m3u8')) {
        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90
            });
            hls.loadSource(url);
            hls.attachMedia(videoElement);
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                videoElement.play().catch(e => console.error("Auto-play blocked", e));
            });
            state.player = hls;
        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            videoElement.src = url;
            videoElement.addEventListener('loadedmetadata', function () {
                videoElement.play();
            });
        }
    }
    // Sync dropdown state if needed (playStream might be called from buttons)
    // Find matching option
    Array.from(qualitySelect.options).forEach(opt => {
        try {
            const val = JSON.parse(opt.value);
            if (val.url === url) {
                qualitySelect.value = opt.value;
            }
        } catch (e) { }
    });
}

// --- Controls ---

forwardBtn.onclick = () => {
    // Aggressive Sync to Live Edge
    if (videoElement.buffered.length > 0) {
        // Jump to the very end of the buffer minus a tiny safety margin
        // This forces the player to consume the latest network packet
        const end = videoElement.buffered.end(videoElement.buffered.length - 1);
        videoElement.currentTime = end - 0.1;
        console.log("Synced to live edge:", videoElement.currentTime);
    } else {
        // Fallback if no buffer info, just try to nudge forward
        videoElement.currentTime += 5;
    }
};

speedSelect.onchange = (e) => {
    videoElement.playbackRate = parseFloat(e.target.value);
};

qualitySelect.onchange = (e) => {
    try {
        const { url, type } = JSON.parse(e.target.value);
        playStream(url, type);
    } catch (err) {
        console.error("Failed to parse quality selection", err);
    }
};

reloadBtn.onclick = () => {
    // Re-trigger extraction to get fresh link, then auto-play same quality? 
    // For simplicity, just re-run extraction.
    if (state.currentUrl) {
        handleExtract();
    }
};

fullscreenBtn.onclick = () => {
    playerContainer.classList.toggle('web-fullscreen');
};

// --- History Logic ---

const historyDropdown = document.getElementById('history-dropdown');

function loadHistory() {
    try {
        const hist = JSON.parse(localStorage.getItem('douyin_history')) || [];
        return hist;
    } catch (e) {
        return [];
    }
}

function saveHistory(item) {
    let hist = loadHistory();
    // Remove if exists (to move to top)
    hist = hist.filter(h => h.url !== item.url);
    // Add new to top
    hist.unshift(item);
    // Limit to 10
    if (hist.length > 10) hist = hist.slice(0, 10);

    localStorage.setItem('douyin_history', JSON.stringify(hist));
    renderHistory();
}

function deleteHistory(e, url) {
    e.stopPropagation(); // specific delete button click
    let hist = loadHistory();
    hist = hist.filter(h => h.url !== url);
    localStorage.setItem('douyin_history', JSON.stringify(hist));
    renderHistory();

    // If empty after delete, hide
    if (hist.length === 0) {
        historyDropdown.classList.add('hidden');
    }
}

function renderHistory() {
    const hist = loadHistory();
    historyDropdown.innerHTML = '';

    if (hist.length === 0) {
        // historyDropdown.innerHTML = '<div style="padding:8px;text-align:center;color:#666">No History</div>';
        return;
    }

    hist.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.onclick = () => {
            urlInput.value = item.url;
            historyDropdown.classList.add('hidden');
        };

        const info = document.createElement('div');
        info.className = 'history-info';

        // Truncate URL for display if needed or show title
        const niceUrl = item.url.replace('https://live.douyin.com/', '');

        info.innerHTML = `
            <div class="history-title">${item.title || 'Unknown Room'}</div>
            <div class="history-sub">${item.anchor_name || '-'} | ${niceUrl}</div>
        `;

        const delBtn = document.createElement('button');
        delBtn.className = 'delete-hist-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Remove';
        delBtn.onclick = (e) => deleteHistory(e, item.url);

        div.appendChild(info);
        div.appendChild(delBtn);
        historyDropdown.appendChild(div);
    });
}

// Show history on focus
urlInput.addEventListener('focus', () => {
    renderHistory();
    if (loadHistory().length > 0) {
        historyDropdown.classList.remove('hidden');
    }
});

// Hide when clicking outside
document.addEventListener('click', (e) => {
    if (!urlInput.contains(e.target) && !historyDropdown.contains(e.target)) {
        historyDropdown.classList.add('hidden');
    }
});

// Hook into extraction success to save history
// Called from handleExtract
function addToHistory(data, url) {
    saveHistory({
        url: url,
        title: data.title,
        anchor_name: data.anchor_name,
        timestamp: Date.now()
    });
}

// --- Init ---
loginBtn.onclick = handleLogin;
logoutBtn.onclick = handleLogout;
extractBtn.onclick = handleExtract;

checkAuth();
