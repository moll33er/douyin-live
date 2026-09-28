let REQUIRE_LOGIN = true;

const state = {
    token: localStorage.getItem('douyin_token') || null,
    currentUrl: '',
    player: null,
    latencyTimer: null,
    currentStream: null,
    reconnectController: null,
    standby: null,
    reconnectAttempts: 0,
    lastReconnectAt: -Infinity,
    cdnStreams: {},
    cdnRoom: null,
    cdnRun: null,
    cdnResult: null,
    qualityRun: null,
    qualityResult: null,
    danmakuRoom: null,
    danmaku: null
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
const parseSource = document.getElementById('parse-source');
const bridgeInstallLink = document.getElementById('bridge-install-link');
const qualitySection = document.getElementById('quality-section');
const qualityButtons = document.getElementById('quality-buttons');
const playerContainer = document.getElementById('player-container');
// The on-screen player and a hidden one that loads replacement connections; they swap roles on reconnect.
let videoElement = document.getElementById('video-player');
let standbyVideo = document.getElementById('video-standby');

const speedSelect = document.getElementById('speed-select');
const forwardBtn = document.getElementById('forward-btn');
const reloadBtn = document.getElementById('reload-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const qualitySelect = document.getElementById('quality-select');
const autoLatencyToggle = document.getElementById('auto-latency-toggle');
const syncModeSelect = document.getElementById('sync-mode');
const syncModeHint = document.getElementById('sync-mode-hint');
const syncStatus = document.getElementById('sync-status');
const cdnSection = document.getElementById('cdn-section');
const cdnQualitySelect = document.getElementById('cdn-quality-select');
const cdnTestBtn = document.getElementById('cdn-test-btn');
const cdnCancelBtn = document.getElementById('cdn-cancel-btn');
const cdnUseBestBtn = document.getElementById('cdn-use-best-btn');
const cdnExtraUrls = document.getElementById('cdn-extra-urls');
const cdnStatus = document.getElementById('cdn-status');
const cdnResults = document.getElementById('cdn-results');
const cdnCurrent = document.getElementById('cdn-current');
const cdnPreviews = document.getElementById('cdn-previews');
const qualityCompareSection = document.getElementById('quality-compare-section');
const qualityCompareA = document.getElementById('quality-compare-a');
const qualityCompareB = document.getElementById('quality-compare-b');
const qualityTestBtn = document.getElementById('quality-test-btn');
const qualityCancelBtn = document.getElementById('quality-cancel-btn');
const qualityUseBestBtn = document.getElementById('quality-use-best-btn');
const qualityStatus = document.getElementById('quality-compare-status');
const qualityResults = document.getElementById('quality-compare-results');
const qualityPreviews = document.getElementById('quality-previews');
const danmakuToggle = document.getElementById('danmaku-toggle');
const danmakuStatus = document.getElementById('danmaku-status');
const danmakuLayer = document.getElementById('danmaku-layer');

try {
    syncModeSelect.value = localStorage.getItem('douyin_sync_mode') === 'smooth' ? 'smooth' : 'fresh';
    danmakuToggle.checked = localStorage.getItem('douyin_danmaku') !== 'off';
} catch (err) { /* Keep the default when storage is unavailable. */ }

// --- Auth Logic ---

async function loadAppConfig() {
    try {
        const res = await axios.get('/api/config');
        REQUIRE_LOGIN = res.data.requireLogin !== false;
    } catch (err) {
        REQUIRE_LOGIN = true;
    }

    logoutBtn.classList.toggle('hidden', !REQUIRE_LOGIN);
}

function checkAuth() {
    if (!REQUIRE_LOGIN) {
        showDashboard();
        return;
    }

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
        loginError.textContent = err.response?.data?.error || '登录失败';
    }
}

function handleLogout() {
    if (!REQUIRE_LOGIN) return;

    destroyPlayer();
    stopDanmaku();
    state.danmakuRoom = null;
    state.token = null;
    localStorage.removeItem('douyin_token');
    checkAuth();
}

// --- Extraction Logic ---

// With the optional userscript the browser parses rooms itself, so Douyin dispatches lines for the viewer's
// own network (browser-parser.js); without it, or when that fails, the server parses them.
async function fetchRoom(input, options = {}) {
    let localError = null;
    if (window.DouyinLocalParser?.available()) {
        try {
            const data = await window.DouyinLocalParser.resolve(input, options);
            if (data) return { data, source: 'browser' };
            localError = '没有取得直播间数据';
        } catch (err) {
            if (options.signal?.aborted) throw err;
            localError = err.message;
        }
    }
    const headers = REQUIRE_LOGIN && state.token ? { 'x-api-key': state.token } : {};
    const res = await axios.get('/api/live', { params: { url: input }, headers, ...options });
    if (!res.data.success) throw new Error(res.data.error || '直播地址获取失败');
    return { data: res.data.data, source: 'server', localError };
}

async function handleExtract() {
    const url = urlInput.value.trim();
    if (!url) return;

    extractBtn.textContent = '解析中...';
    extractBtn.disabled = true;
    infoSection.classList.add('hidden');
    qualitySection.classList.add('hidden');
    playerContainer.classList.add('hidden');
    cdnSection.classList.add('hidden');
    qualityCompareSection.classList.add('hidden');
    destroyPlayer();
    stopDanmaku();
    state.danmakuRoom = null;

    // Direct Stream Support
    // Check path extension instead of full URL
    const urlPath = url.split('?')[0];
    if (urlPath.endsWith('.flv') || urlPath.endsWith('.m3u8')) {
        const type = urlPath.endsWith('.flv') ? 'flv' : 'm3u8';
        const filename = urlPath.split('/').pop();

        const directData = {
            title: '直链播放',
            anchor_name: '直链',
            cover: '', // No cover for direct link
            flv: type === 'flv' ? { 'original': { url, sdk_params: {}, label: '原画' } } : {},
            hls: type === 'm3u8' ? { 'original': { url, sdk_params: {}, label: '原画' } } : {}
        };

        renderInfo(directData);
        renderQualities(directData);
        state.currentUrl = url;
        addToHistory(directData, url);

        // Auto play
        playStream(url, type, 'original');

        extractBtn.textContent = '解析';
        extractBtn.disabled = false;
        return;
    }

    try {
        const result = await fetchRoom(url);
        const data = result.data;
        // Share texts and short links are replaced by the room number, which reloads and history reuse.
        const room = data.web_rid || roomNumber(url) || url;
        // Live comments connect once something plays (activateStream).
        state.danmakuRoom = Number(data.status) === 2 ? data.room_id || null : null;
        renderInfo(data, result);
        renderQualities(data);
        state.currentUrl = room; // Save for reload
        urlInput.value = room;
        addToHistory(data, room);
    } catch (err) {
        if (REQUIRE_LOGIN && err.response && (err.response.status === 401 || err.response.status === 403)) {
            // Token expired or invalid
            handleLogout();
            loginError.textContent = '会话已过期，请重新登录。';
        } else {
            alert(err.response?.data?.error || '解析直播数据失败');
        }
    } finally {
        extractBtn.textContent = '解析';
        extractBtn.disabled = false;
    }
}

function renderInfo(data, { source, localError } = {}) {
    document.getElementById('room-title').textContent = data.title;
    document.getElementById('anchor-name').textContent = data.anchor_name;
    document.getElementById('cover-img').src = data.cover || '';
    parseSource.textContent = source === 'browser' ? '浏览器本地解析，线路按你当前的网络分配。'
        : source !== 'server' ? ''
        : localError ? `浏览器解析失败（${localError}），已改用服务器解析。` : '服务器解析，线路按服务器所在的网络分配。';
    bridgeInstallLink.classList.toggle('hidden', source !== 'server' || !!localError);
    infoSection.classList.remove('hidden');
}

function renderQualities(data, preferredType = 'flv') {
    updateCdnSources(data.flv || {}, data.web_rid || null);
    qualityButtons.innerHTML = '';

    // Combine FLV and HLS for selection
    // Prefer FLV as it's usually lower latency
    const streams = [];

    if (data.flv && preferredType !== 'm3u8') {
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
            playStream(stream.url, stream.type, stream.key);
        };
        qualityButtons.appendChild(btn);

        // Populate dropdown
        const option = document.createElement('option');
        option.value = JSON.stringify({ url: stream.url, type: stream.type, key: stream.key });
        option.textContent = `${stream.label} (${stream.type})`;
        qualitySelect.appendChild(option);
    });

    // Select first one by default in dropdown if exists
    if (streams.length > 0) {
        qualitySelect.value = JSON.stringify({ url: streams[0].url, type: streams[0].type, key: streams[0].key });
    }

    qualitySection.classList.remove('hidden');
}

// --- Player Logic ---

function resetVideo(video) {
    video.onloadedmetadata = null;
    video.oncanplay = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
}

function destroyPlayer() {
    cancelCdnTest();
    cancelQualityTest();
    stopLatencyMonitor();
    cancelReconnect();
    state.currentStream = null;
    if (state.player) {
        if (state.player.destroy) state.player.destroy();
        // HLS.js uses destroy(), flv.js also destroy()
        state.player = null;
    }
    resetVideo(videoElement);
}

function closeStandby() {
    const standby = state.standby;
    if (!standby) return;
    state.standby = null;
    standby.player?.destroy?.();
    resetVideo(standbyVideo);
}

// A stream may drive its callbacks while it is on screen or while it is loading in the standby element.
const ownsStream = stream => state.currentStream === stream || state.standby?.stream === stream;

// Attaches a live connection to `video`; returns the flv.js/hls.js player (null for native HLS).
function openStream(video, stream) {
    const { url, type, cdnSelected } = stream;
    const isFlv = type === 'flv' || url.endsWith('.flv');
    // Live FLV connections start with the CDN's cached GOP; skip it once the first picture is playable.
    if (stream.wantsPlay) video.oncanplay = () => {
        if (!ownsStream(stream) || !stream.wantsPlay) return;
        if (isFlv) {
            if (!CdnTester.chase(video)) return;
            stream.startupChaseUntil = Date.now() + 3000;
        }
        video.oncanplay = null;
        if (cdnSelected && state.currentStream === stream) syncStatus.textContent = '所选线路已加载，并已追到当前可用直播位置。';
        stream.onReady?.();
    };

    const fail = () => {
        if (!ownsStream(stream)) return;
        stream.failed = true;
        if (state.currentStream === stream) syncStatus.textContent = '直播连接中断；可点击“同步直播”或“重新加载”重试。';
        stream.onFail?.();
    };
    const play = () => {
        if (!ownsStream(stream) || !stream.wantsPlay) return;
        stream.playRequested = true;
        video.play().catch(err => {
            if (!ownsStream(stream)) return;
            if (err.name === 'NotAllowedError' && state.currentStream === stream) {
                stream.wantsPlay = false;
                syncStatus.textContent = '请点击视频播放按钮开始观看。';
            } else if (err.name !== 'AbortError') {
                fail();
            }
        });
    };

    // Handle FLV
    if (isFlv) {
        if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 FLV 播放。');
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
        player.on(flvjs.Events.ERROR, fail);
        player.attachMediaElement(video);
        player.load();
        play();
        return player;
    }
    // Handle HLS
    if (type === 'm3u8' || url.endsWith('.m3u8')) {
        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90
            });
            hls.on(Hls.Events.MANIFEST_PARSED, play);
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) fail();
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            return hls;
        }
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.onloadedmetadata = play;
            video.src = url;
            return null;
        }
        throw new Error('当前浏览器不支持 HLS 播放。');
    }
    return null;
}

function activateStream({ url, type, key, cdnSelected }) {
    cdnCurrent.textContent = cdnSelected ? `在播线路：${new URL(url).host}（测速选择）` : '在播线路：平台默认';
    // Sync dropdown state if needed (playStream might be called from buttons)
    Array.from(qualitySelect.options).forEach(opt => {
        try {
            const val = JSON.parse(opt.value);
            if (val.url === url || (cdnSelected && val.key === key && val.type === type)) {
                qualitySelect.value = opt.value;
            }
        } catch (e) { }
    });

    // Start Monitor if enabled
    if (autoLatencyToggle.checked) {
        startLatencyMonitor();
    }
    startDanmaku();
}

function playStream(url, type, key = null, reconnecting = false, cdnSelected = false, autoplay = true) {
    destroyPlayer();
    if (!reconnecting) {
        state.reconnectAttempts = 0;
        state.lastReconnectAt = -Infinity;
    }
    const stream = { url, type, key, failed: false, wantsPlay: autoplay, playRequested: false, cdnSelected };
    state.currentStream = stream;
    syncStatus.textContent = reconnecting ? '正在连接最新直播画面…' : '正在加载直播…';
    playerContainer.classList.remove('hidden');
    try {
        state.player = openStream(videoElement, stream);
    } catch (err) {
        state.currentStream = null;
        syncStatus.textContent = err.message;
    }
    activateStream(stream);
}

// Loads a replacement connection in the hidden standby element; resolves once it has caught up and can play.
function prepareStandby(url, type, key, cdnSelected, signal) {
    const stream = { url, type, key, failed: false, wantsPlay: true, playRequested: false, cdnSelected };
    return new Promise((resolve, reject) => {
        const finish = err => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            stream.onReady = stream.onFail = null;
            if (!err) return resolve(stream);
            if (state.standby?.stream === stream) closeStandby();
            reject(err);
        };
        const abort = () => finish(new DOMException('重连已取消', 'AbortError'));
        const timer = setTimeout(() => finish(new Error('新连接加载超时')), 10000);
        stream.onReady = () => finish();
        stream.onFail = () => finish(new Error('新连接失败'));
        signal.addEventListener('abort', abort, { once: true });
        state.standby = { stream, player: null };
        standbyVideo.muted = true;
        try {
            const player = openStream(standbyVideo, stream);
            if (state.standby?.stream === stream) state.standby.player = player;
            else player?.destroy?.();
        } catch (err) {
            finish(err);
        }
    });
}

function swapToStandby(stream) {
    const { player } = state.standby;
    state.standby = null;
    stopLatencyMonitor();
    const old = videoElement, oldPlayer = state.player;
    videoElement = standbyVideo;
    standbyVideo = old;
    videoElement.muted = old.muted;
    videoElement.volume = old.volume;
    videoElement.playbackRate = parseFloat(speedSelect.value) || 1;
    videoElement.classList.remove('standby');
    old.classList.add('standby');
    state.player = player;
    state.currentStream = stream;
    oldPlayer?.destroy?.();
    resetVideo(old);
    syncStatus.textContent = '已切换到新连接。';
    activateStream(stream);
}

// --- Controls ---

forwardBtn.onclick = () => {
    if (syncModeSelect.value === 'fresh') reconnectStream();
    else seekToLive();
};

speedSelect.onchange = (e) => {
    videoElement.playbackRate = parseFloat(e.target.value);
};

qualitySelect.onchange = (e) => {
    try {
        const { url, type, key } = JSON.parse(e.target.value);
        playStream(url, type, key);
    } catch (err) {
        console.error("Failed to parse quality selection", err);
    }
};

reloadBtn.onclick = () => {
    if (state.currentStream) reconnectStream(false, true);
    else if (state.currentUrl) {
        urlInput.value = state.currentUrl;
        handleExtract();
    }
};

fullscreenBtn.onclick = () => {
    playerContainer.classList.toggle('web-fullscreen');
};

// --- Auto Latency Logic ---

function getLiveTarget() {
    if (!state.currentStream) return null;
    const hlsTarget = state.player?.liveSyncPosition;
    if (Number.isFinite(hlsTarget)) return hlsTarget;

    // Native HLS exposes its sliding live window through seekable.
    const isHls = state.currentStream.type === 'm3u8';
    const ranges = isHls && videoElement.seekable.length ? videoElement.seekable : videoElement.buffered;
    if (!ranges.length) return null;
    const last = ranges.length - 1;
    const end = ranges.end(last);
    return Number.isFinite(end) ? Math.max(ranges.start(last), end - (isHls ? 1 : 0.5)) : null;
}

function seekToLive() {
    const target = getLiveTarget();
    if (target === null) {
        syncStatus.textContent = '尚无可同步的直播画面，请稍候或点击“重新加载”。';
        return;
    }
    videoElement.currentTime = target;
    if (autoLatencyToggle.checked) videoElement.playbackRate = 1;
    syncStatus.textContent = '已跳转到当前可用的直播位置。';
}

function cancelReconnect() {
    state.reconnectController?.abort();
    state.reconnectController = null;
    closeStandby();
    forwardBtn.disabled = false;
    reloadBtn.disabled = false;
}

function urlExpiring(url) {
    const expire = Number(new URL(url).searchParams.get('expire'));
    return expire > 0 && expire * 1000 - Date.now() < 60000;
}

async function reconnectStream(automatic = false, renew = false) {
    const stream = state.currentStream;
    if (!stream || state.reconnectController) return;
    if (automatic) {
        if (!autoLatencyToggle.checked || !stream.wantsPlay) return;
        if (state.reconnectAttempts >= 3) {
            syncStatus.textContent = '连续重连未恢复，已停止自动重试。请检查直播状态后点击“重新加载”。';
            stopLatencyMonitor();
            return;
        }
        if (Date.now() - state.lastReconnectAt < 15000) return;
        state.reconnectAttempts++;
    } else {
        state.reconnectAttempts = 0;
    }
    state.lastReconnectAt = Date.now();
    const controller = new AbortController();
    state.reconnectController = controller;
    forwardBtn.disabled = true;
    reloadBtn.disabled = true;
    syncStatus.textContent = '正在重新获取直播并连接，请稍候…';

    try {
        let { url, type, key, cdnSelected } = stream;
        const room = state.currentUrl && !/\.(flv|m3u8)(?:[?#]|$)/i.test(state.currentUrl);
        // Signed stream URLs stay valid until `expire`, so a room page is only fetched again when the
        // address may be broken or stale; direct URLs are re-opened as supplied.
        if (room && (renew || stream.failed || stream.renewUrl || urlExpiring(url))) {
            const result = await fetchRoom(state.currentUrl, { signal: controller.signal, timeout: 10000 });
            if (controller.signal.aborted || state.currentStream !== stream) return;
            const qualities = result.data[type === 'flv' ? 'flv' : 'hls'];
            key = qualities?.[key] ? key : Object.keys(qualities || {})[0];
            if (!qualities?.[key]?.url) throw new Error('暂无可用直播画面，直播可能已经结束');
            url = qualities[key].url;
            cdnSelected = false;
            renderInfo(result.data, result);
            renderQualities(result.data, type);
        }
        if (controller.signal.aborted || state.currentStream !== stream) return;
        // Broken or stalled connections have no picture worth keeping, so they are replaced directly.
        if (stream.failed || videoElement.paused || videoElement.readyState < 3) {
            playStream(url, type, key, true, cdnSelected);
            return;
        }
        // Keep the current picture on screen until the new connection has caught up.
        syncStatus.textContent = '正在后台建立新连接，当前画面继续播放…';
        const next = await prepareStandby(url, type, key, cdnSelected, controller.signal).catch(err => {
            if (controller.signal.aborted || state.currentStream !== stream) return null;
            stream.renewUrl = true;
            syncStatus.textContent = `新连接未能就绪（${err.message}），继续播放当前画面。`;
            return null;
        });
        if (!next || controller.signal.aborted || state.currentStream !== stream) return;
        swapToStandby(next);
    } catch (err) {
        if (controller.signal.aborted || state.currentStream !== stream) return;
        syncStatus.textContent = `重连失败：${err.response?.data?.error || err.message}`;
        if (err.response?.status === 401 || err.response?.status === 403) stopLatencyMonitor();
    } finally {
        if (state.reconnectController === controller) cancelReconnect();
    }
}

function startLatencyMonitor() {
    stopLatencyMonitor();
    if (!state.currentStream) return;
    let lastTime = videoElement.currentTime;
    let lastProgressAt = Date.now();
    let healthySince = null;
    let lagSince = null;

    state.latencyTimer = setInterval(() => {
        const stream = state.currentStream;
        const now = Date.now();
        if (!stream || state.reconnectController) return;
        if (stream.startupChaseUntil > now && !videoElement.paused && videoElement.buffered.length &&
            videoElement.buffered.end(videoElement.buffered.length - 1) - videoElement.currentTime > 0.8) {
            CdnTester.chase(videoElement);
        }
        if (!stream.wantsPlay || (videoElement.paused && !stream.failed) || videoElement.seeking) {
            lastTime = videoElement.currentTime;
            lastProgressAt = now;
            healthySince = lagSince = null;
            return;
        }

        const progressed = videoElement.currentTime > lastTime + 0.05;
        lastTime = videoElement.currentTime;
        if (progressed && !stream.failed) {
            lastProgressAt = now;
            healthySince ??= now;
        } else {
            healthySince = null;
        }

        const target = getLiveTarget();
        const lag = target === null ? 0 : target - videoElement.currentTime;
        if (lag > 3) lagSince ??= now;
        else lagSince = null;
        if (healthySince !== null && now - healthySince >= 30000 && lag <= 3) state.reconnectAttempts = 0;

        // HLS segments arrive in batches: allow at least three segment durations before calling playback stalled.
        const segmentDuration = state.player?.levels?.[state.player.currentLevel]?.details?.targetduration || 0;
        const stallTimeout = Math.max(15000, segmentDuration * 3000);
        const fresh = syncModeSelect.value === 'fresh';
        // Both modes recover broken connections; only fresh mode also reconnects when jumping cannot clear the lag.
        if (stream.failed || now - lastProgressAt >= stallTimeout || (fresh && lagSince !== null && now - lagSince >= 3000)) {
            reconnectStream(true);
            return;
        }
        if (target === null || stream.failed) return;

        // Buffered frames are the newest this connection has delivered, so fresh mode jumps to them sooner.
        if (lag > (fresh ? 1 : 1.5)) {
            seekToLive();
        } else if (lag > 0.25) {
            videoElement.playbackRate = 1.1;
        } else if (lag <= 0.1) {
            videoElement.playbackRate = 1;
        }
    }, 1000);
}

function stopLatencyMonitor() {
    if (state.latencyTimer) {
        clearInterval(state.latencyTimer);
        state.latencyTimer = null;
    }
    // Reset speed just in case, but maybe user wants it? 
    // If we stop monitor, we should probably reset to 1.0 if we were speeding up.
    if (videoElement.playbackRate === 1.1) {
        videoElement.playbackRate = 1.0;
    }
}

autoLatencyToggle.onchange = () => {
    cancelReconnect();
    updateSpeedControls();
    if (autoLatencyToggle.checked) {
        startLatencyMonitor();
    } else {
        stopLatencyMonitor();
    }
};

syncModeSelect.onchange = () => {
    cancelReconnect();
    state.reconnectAttempts = 0;
    state.lastReconnectAt = -Infinity;
    try { localStorage.setItem('douyin_sync_mode', syncModeSelect.value); } catch (err) { }
    updateSyncMode();
    if (autoLatencyToggle.checked) startLatencyMonitor();
};

function updateSyncMode() {
    const fresh = syncModeSelect.value === 'fresh';
    syncModeHint.textContent = fresh
        ? '最新画面优先：落后超过 1 秒直接跳到已缓冲的最新画面；仍明显落后、连接出错或停滞时重新连接，可能短暂等待；点击“同步直播”可立即重连。'
        : '平滑追赶：以加速为主追赶直播，落后较多时跳转；仅在连接出错或停滞时重新连接。';
    forwardBtn.title = fresh ? '重新连接，获取新的直播画面' : '跳转到当前可用的直播位置';
    syncStatus.textContent = '';
}

// User-facing events only count for the on-screen element; the standby element reports errors for its own stream.
for (const video of [videoElement, standbyVideo]) {
    video.addEventListener('play', () => {
        if (video !== videoElement || !state.currentStream) return;
        state.currentStream.wantsPlay = true;
        state.currentStream.playRequested = true;
    });
    video.addEventListener('pause', () => {
        // Ignore teardown events until the new stream has actually requested playback.
        if (video !== videoElement || !state.currentStream?.playRequested || !video.paused || video.error || state.currentStream.failed) return;
        state.currentStream.wantsPlay = false;
        cancelReconnect();
    });
    video.addEventListener('error', () => {
        const stream = video === videoElement ? state.currentStream : state.standby?.stream;
        if (!stream || !video.error) return;
        stream.failed = true;
        stream.onFail?.();
    });
    video.addEventListener('playing', () => {
        if (video === videoElement && state.currentStream) syncStatus.textContent = '正在播放';
    });
}

function updateSpeedControls() {
    if (autoLatencyToggle.checked) {
        speedSelect.disabled = true;
        speedSelect.value = '1.0';
        videoElement.playbackRate = 1.0;
    } else {
        speedSelect.disabled = false;
    }
}

// Init speed controls state
updateSpeedControls();
updateSyncMode();

// --- Danmaku ---

let danmakuOverlay = null;

// Connects the parsed room's live comments; switching quality or line keeps the room's connection.
function startDanmaku() {
    const roomId = state.danmakuRoom;
    const api = window.DouyinDanmaku;
    if (!api || !roomId || !danmakuToggle.checked || state.danmaku?.roomId === roomId) return;
    stopDanmaku();
    const controller = new AbortController();
    state.danmaku = { roomId, controller };
    danmakuOverlay ??= new api.DanmakuOverlay(danmakuLayer);
    api.connect(roomId, {
        signal: controller.signal,
        relay: danmakuRelayAddress(),
        onComment: comment => danmakuOverlay.add(comment.content),
        onStatus: message => { danmakuStatus.textContent = message; }
    });
}

// This site's danmaku relay, for browsers that keep Douyin's cookie from its websocket (Safari, iOS, private windows).
function danmakuRelayAddress() {
    const url = new URL('/api/danmaku', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (REQUIRE_LOGIN && state.token) url.searchParams.set('token', state.token);
    return url.href;
}

function stopDanmaku() {
    state.danmaku?.controller.abort();
    state.danmaku = null;
    danmakuOverlay?.clear();
    danmakuStatus.textContent = '';
}

danmakuToggle.onchange = () => {
    try { localStorage.setItem('douyin_danmaku', danmakuToggle.checked ? 'on' : 'off'); } catch (err) { }
    if (!danmakuToggle.checked) stopDanmaku();
    else if (state.currentStream) startDanmaku();
};

// --- CDN freshness comparison ---

function setCdnBusy(busy) {
    cdnTestBtn.disabled = busy || !!state.qualityRun || !Object.keys(state.cdnStreams).length;
    cdnCancelBtn.disabled = !busy;
    cdnQualitySelect.disabled = busy;
    cdnExtraUrls.disabled = busy;
    cdnUseBestBtn.disabled = busy || !!state.qualityRun || !state.cdnResult?.best;
    setQualityBusy();
}

function cancelCdnTest() {
    const run = state.cdnRun;
    if (!run) return;
    state.cdnRun = null;
    run.controller.abort();
    setCdnBusy(false);
    cdnStatus.textContent = '测速已取消。';
}

function updateCdnSources(streams, room = null) {
    cancelCdnTest();
    // Each parse may be dispatched to another CDN, so unexpired addresses from earlier parses of
    // the same room remain line candidates.
    const previous = room && state.cdnRoom === room ? state.cdnStreams : {};
    // Direct links are kept as typed, so an address may not parse as a URL.
    const hostOf = url => { try { return new URL(url).host; } catch (err) { return url; } };
    state.cdnRoom = room;
    state.cdnStreams = Object.fromEntries(Object.entries(streams).map(([key, stream]) => {
        const hosts = new Set([hostOf(stream.url)]);
        const earlier = [previous[key]?.url, ...(previous[key]?.candidates || [])].filter(url => url && !urlExpiring(url));
        const candidates = [...(stream.candidates || []), ...earlier].filter(url => {
            const host = hostOf(url);
            return !hosts.has(host) && hosts.add(host);
        });
        return [key, { ...stream, candidates }];
    }));
    state.cdnResult = null;
    cdnQualitySelect.innerHTML = '';
    for (const [key, stream] of Object.entries(streams)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = stream.label || key;
        cdnQualitySelect.appendChild(option);
    }
    cdnQualitySelect.value = streams.SD1 ? 'SD1' : Object.keys(streams)[0] || '';
    cdnSection.classList.toggle('hidden', !Object.keys(streams).length);
    cdnResults.innerHTML = '';
    cdnStatus.textContent = '选择画质后开始测速。';
    setCdnBusy(false);
    updateQualitySources();
}

function showCdnRows(rows, key, complete = false) {
    cdnResults.innerHTML = '';
    const ms = value => value == null ? '—' : value < 1 ? '< 1 ms' : `约 ${Math.round(value)} ms`;
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const text of [row.host || '未连接', row.loadMs == null ? '等待加载' : `${(row.loadMs / 1000).toFixed(1)} 秒`,
            `${row.chases || 0} / ${row.reconnects || 0}`, row.eligible ? ms(row.arrivalLagMs) : '—', row.eligible ? ms(row.pictureLagMs) : '—']) {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
        }
        const action = document.createElement('td');
        if (complete && row.eligible) {
            const button = document.createElement('button');
            button.className = 'btn sm'; button.textContent = '使用';
            button.onclick = () => useCdnResult(row, key);
            action.appendChild(button);
        } else action.textContent = row.error || (complete ? '未判定' : row.stage || (row.pending ? '加载待确认' : '等待试播'));
        tr.appendChild(action);
        cdnResults.appendChild(tr);
    }
}

function useCdnResult(row, key) {
    if (state.cdnRun || state.qualityRun || !row.eligible || state.cdnResult?.key !== key) return;
    playStream(row.url, 'flv', key, false, true);
}

async function startCdnTest() {
    if (state.cdnRun || state.qualityRun) return;
    const key = cdnQualitySelect.value;
    const source = state.cdnStreams[key];
    if (!source?.url) return;
    const extras = cdnExtraUrls.value.split(/\s+/).filter(text => /^https?:\/\//i.test(text));
    extras.push(...source.candidates || []);
    if (state.cdnResult?.key === key) extras.push(...state.cdnResult.rows.filter(row => row.eligible).map(row => row.url));
    if (state.currentStream?.type === 'flv' && state.currentStream.key === key && state.currentStream.url !== source.url) extras.push(state.currentStream.url);
    const previous = state.currentStream ? { ...state.currentStream, wantsPlay: state.currentStream.wantsPlay && !videoElement.paused } : null;
    destroyPlayer();
    const run = { controller: new AbortController(), previous };
    state.cdnRun = run;
    state.cdnResult = null;
    setCdnBusy(true);
    cdnResults.innerHTML = '';
    cdnStatus.textContent = '正在发现可用线路…';
    const progress = info => {
        if (state.cdnRun !== run) return;
        showCdnRows(info.nodes, key);
        if (info.phase === 'discover') cdnStatus.textContent = `正在发现线路：已有 ${info.nodes.length} / 5 条候选（第 ${info.attempt} 次请求）…`;
        else if (info.phase === 'prepare') cdnStatus.textContent = `正在加载、追帧和核验重连：${info.nodes.filter(n => n.ready).length} / ${info.nodes.length} 条就绪，已用 ${Math.floor(info.elapsed)} 秒…`;
        else if (info.phase === 'align') cdnStatus.textContent = '正在核对不同时间段的共同画面，避免漏掉大幅领先的线路…';
        else cdnStatus.textContent = `正在比较相同画面，剩余约 ${info.remaining} 秒…`;
    };
    try {
        const discovered = await CdnTester.discover(source.url, extras, run.controller.signal, progress);
        if (state.cdnRun !== run) return;
        if (discovered.nodes.length < 2) {
            showCdnRows(discovered.nodes, key);
            const detail = discovered.failures.at(-1)?.error;
            cdnStatus.textContent = `仅发现 ${discovered.nodes.length} 条可用线路，无法比较。可补充同画质备用地址。${detail ? ' ' + detail : ''}`;
            return;
        }
        const result = await CdnTester.measure(discovered.nodes, run.controller.signal, progress, cdnPreviews);
        if (state.cdnRun !== run) return;
        state.cdnResult = { ...result, key };
        showCdnRows(result.rows, key, true);
        cdnStatus.textContent = result.error || `${source.label || key}：加载追帧及时间轴核验用时 ${result.warmupSeconds.toFixed(1)} 秒。处理后窗口匹配 ${result.matchedFrames} 个相同画面，按画面进度推荐；加载耗时不参与排名。`;
    } catch (err) {
        if (state.cdnRun === run) cdnStatus.textContent = err.name === 'AbortError' ? run.cancelReason || '测速已取消。' : `测速失败：${err.message}`;
    } finally {
        if (state.cdnRun === run) {
            state.cdnRun = null;
            setCdnBusy(false);
            if (previous) playStream(previous.url, previous.type, previous.key, false, previous.cdnSelected, previous.wantsPlay);
        }
    }
}

cdnTestBtn.onclick = startCdnTest;
cdnCancelBtn.onclick = () => state.cdnRun?.controller.abort();
cdnUseBestBtn.onclick = () => {
    if (state.cdnResult?.best) useCdnResult(state.cdnResult.best, state.cdnResult.key);
};
cdnQualitySelect.onchange = () => {
    state.cdnResult = null;
    cdnResults.innerHTML = '';
    cdnStatus.textContent = '已切换测速画质；备用地址也应与此画质一致。';
    setCdnBusy(false);
};
window.addEventListener('pagehide', () => {
    cancelCdnTest();
    destroyPlayer();
    stopDanmaku();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.cdnRun) {
        state.cdnRun.cancelReason = '页面已进入后台，测速已取消；请保持页面在前台后重试。';
        state.cdnRun.controller.abort();
    }
});

// --- Cross-quality picture comparison ---

function setQualityBusy() {
    const busy = !!state.qualityRun || !!state.cdnRun;
    qualityTestBtn.disabled = busy || Object.keys(state.cdnStreams).length < 2 || qualityCompareA.value === qualityCompareB.value;
    qualityCancelBtn.disabled = !state.qualityRun;
    qualityCompareA.disabled = qualityCompareB.disabled = busy;
    qualityUseBestBtn.disabled = busy || !state.qualityResult?.best;
}

function cancelQualityTest() {
    const run = state.qualityRun;
    if (!run) return;
    state.qualityRun = null;
    run.controller.abort();
    qualityStatus.textContent = '画质对比已取消。';
    setCdnBusy(!!state.cdnRun);
}

function updateQualitySources() {
    cancelQualityTest();
    state.qualityResult = null;
    qualityResults.innerHTML = '';
    const keys = Object.keys(state.cdnStreams);
    for (const select of [qualityCompareA, qualityCompareB]) {
        select.innerHTML = '';
        for (const key of keys) {
            const option = document.createElement('option');
            option.value = key; option.textContent = state.cdnStreams[key].label || key;
            select.appendChild(option);
        }
    }
    qualityCompareA.value = state.cdnStreams.SD1 ? 'SD1' : keys[0] || '';
    qualityCompareB.value = keys.find(key => key !== qualityCompareA.value) || '';
    qualityCompareSection.classList.toggle('hidden', !keys.length);
    qualityStatus.textContent = keys.length < 2 ? '此直播只有一种可用 FLV 画质，无法对比。' : '选择两种画质，自动估算当前哪一路画面领先。';
    setQualityBusy();
}

async function startQualityTest() {
    if (state.qualityRun || state.cdnRun) return;
    const keys = [qualityCompareA.value, qualityCompareB.value];
    if (keys[0] === keys[1] || keys.some(key => !state.cdnStreams[key]?.url)) return;
    const sources = keys.map(key => ({ ...state.cdnStreams[key], key }));
    const previous = state.currentStream ? { ...state.currentStream, wantsPlay: state.currentStream.wantsPlay && !videoElement.paused } : null;
    destroyPlayer();
    const run = { controller: new AbortController() };
    state.qualityRun = run;
    state.qualityResult = null;
    qualityResults.innerHTML = '';
    qualityStatus.textContent = '正在加载两种画质并追到可播放的直播位置…';
    setCdnBusy(false);
    try {
        const result = await QualityTester.measure(sources, run.controller.signal, info => {
            if (state.qualityRun !== run) return;
            qualityStatus.textContent = info.phase === 'prepare' ? '正在加载、追帧并等待播放稳定…' : `正在比较连续画面，剩余约 ${info.remaining} 秒…`;
        }, qualityPreviews);
        if (state.qualityRun !== run) return;
        if (!result.eligible) {
            qualityStatus.textContent = `无法判定：${result.error}`;
            return;
        }
        const best = result.bestIndex === null ? null : sources[result.bestIndex];
        state.qualityResult = { ...result, best };
        const lag = [Math.max(0, -result.deltaMs), Math.max(0, result.deltaMs)];
        sources.forEach((source, i) => {
            const tr = document.createElement('tr');
            for (const text of [source.label || source.key,
                result.bestIndex === null ? '差异不足以区分' : lag[i] === 0 ? '本次领先' : `约落后 ${(lag[i] / 1000).toFixed(1)} 秒`]) {
                const td = document.createElement('td'); td.textContent = text; tr.appendChild(td);
            }
            qualityResults.appendChild(tr);
        });
        qualityStatus.textContent = `${best ? `${best.label || best.key} 本次画面领先约 ${(Math.abs(result.deltaMs) / 1000).toFixed(1)} 秒。` : '两种画质近似同步，暂不推荐切换。'}连续匹配 ${result.matchedFrames} 组画面，估算容差约 ${(result.uncertaintyMs / 1000).toFixed(1)} 秒；仅适用于本次两路试播。`;
    } catch (err) {
        if (state.qualityRun === run) qualityStatus.textContent = err.name === 'AbortError' ? '画质对比已取消。' : `无法判定：${err.message}`;
    } finally {
        if (state.qualityRun === run) {
            state.qualityRun = null;
            setCdnBusy(false);
            if (previous) playStream(previous.url, previous.type, previous.key, false, previous.cdnSelected, previous.wantsPlay);
        }
    }
}

qualityTestBtn.onclick = startQualityTest;
qualityCancelBtn.onclick = () => state.qualityRun?.controller.abort();
qualityUseBestBtn.onclick = () => {
    const best = state.qualityResult?.best;
    if (best && !state.qualityRun && !state.cdnRun) playStream(best.url, 'flv', best.key);
};
qualityCompareA.onchange = qualityCompareB.onchange = () => {
    state.qualityResult = null;
    qualityResults.innerHTML = '';
    qualityStatus.textContent = qualityCompareA.value === qualityCompareB.value ? '请选择两种不同画质。' : '画质已更换，请重新开始对比。';
    setQualityBusy();
};

// --- History Logic ---

const historyDropdown = document.getElementById('history-dropdown');

function roomNumber(text) {
    return String(text).trim().match(/^(?:https?:\/\/live\.douyin\.com\/)?(\d+)(?:[/?#]\S*)?$/)?.[1] || null;
}

function loadHistory() {
    try {
        const hist = JSON.parse(localStorage.getItem('douyin_history')) || [];
        // Older entries stored room page URLs; history now keeps room numbers.
        return hist.map(item => ({ ...item, url: roomNumber(item.url) || item.url }));
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
            <div class="history-title">${item.title || '未知房间'}</div>
            <div class="history-sub">${item.anchor_name || '-'} | ${niceUrl}</div>
        `;

        const delBtn = document.createElement('button');
        delBtn.className = 'delete-hist-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = '移除';
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
    // Offline room metadata must not replace history; direct streams have no status.
    if (data.status !== undefined && Number(data.status) !== 2) return;
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

async function init() {
    await loadAppConfig();
    checkAuth();
}

init();
