let REQUIRE_LOGIN = true;

const state = {
    token: localStorage.getItem('douyin_token') || null,
    currentUrl: '',
    player: null,
    latencyTimer: null,
    currentStream: null,
    reconnectController: null,
    reconnectAttempts: 0,
    lastReconnectAt: -Infinity,
    cdnStreams: {},
    cdnRun: null,
    cdnResult: null
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

try {
    syncModeSelect.value = localStorage.getItem('douyin_sync_mode') === 'smooth' ? 'smooth' : 'fresh';
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
    state.token = null;
    localStorage.removeItem('douyin_token');
    checkAuth();
}

// --- Extraction Logic ---

async function handleExtract() {
    const url = urlInput.value;
    if (!url) return;

    extractBtn.textContent = '解析中...';
    extractBtn.disabled = true;
    infoSection.classList.add('hidden');
    qualitySection.classList.add('hidden');
    playerContainer.classList.add('hidden');
    cdnSection.classList.add('hidden');
    destroyPlayer();

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
        const headers = REQUIRE_LOGIN && state.token ? { 'x-api-key': state.token } : {};
        const res = await axios.get('/api/live', {
            params: { url: url },
            headers
        });

        if (res.data.success) {
            renderInfo(res.data.data);
            renderQualities(res.data.data);
            state.currentUrl = url; // Save for reload
            addToHistory(res.data.data, url);
        }
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

function renderInfo(data) {
    document.getElementById('room-title').textContent = data.title;
    document.getElementById('anchor-name').textContent = data.anchor_name;
    document.getElementById('cover-img').src = data.cover || '';
    infoSection.classList.remove('hidden');
}

function renderQualities(data, preferredType = 'flv') {
    updateCdnSources(data.flv || {});
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

function destroyPlayer() {
    cancelCdnTest();
    stopLatencyMonitor();
    cancelReconnect();
    state.currentStream = null;
    videoElement.onloadedmetadata = null;
    videoElement.oncanplay = null;
    if (state.player) {
        if (state.player.destroy) state.player.destroy();
        // HLS.js uses destroy(), flv.js also destroy()
        state.player = null;
    }
    // Also stop video element
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
}

function playStream(url, type, key = null, reconnecting = false, cdnSelected = false, autoplay = true) {
    destroyPlayer();
    if (!reconnecting) {
        state.reconnectAttempts = 0;
        state.lastReconnectAt = -Infinity;
    }
    const stream = { url, type, key, failed: false, wantsPlay: autoplay, playRequested: false, cdnSelected };
    state.currentStream = stream;
    if (cdnSelected && autoplay) videoElement.oncanplay = () => {
        if (state.currentStream !== stream || !stream.wantsPlay) return;
        if (CdnTester.chase(videoElement)) {
            stream.startupChaseUntil = Date.now() + 3000;
            videoElement.oncanplay = null;
            syncStatus.textContent = '所选线路已加载，并已追到当前可用直播位置。';
        }
    };
    cdnCurrent.textContent = cdnSelected ? `在播线路：${new URL(url).host}（测速选择）` : '在播线路：平台默认';
    syncStatus.textContent = reconnecting ? '正在连接最新直播画面…' : '正在加载直播…';
    playerContainer.classList.remove('hidden');

    const fail = () => {
        if (state.currentStream !== stream) return;
        stream.failed = true;
        syncStatus.textContent = '直播连接中断；可点击“同步直播”或“重新加载”重试。';
    };
    const play = () => {
        if (state.currentStream !== stream || !stream.wantsPlay) return;
        stream.playRequested = true;
        videoElement.play().catch(err => {
            if (state.currentStream !== stream) return;
            if (err.name === 'NotAllowedError') {
                stream.wantsPlay = false;
                syncStatus.textContent = '请点击视频播放按钮开始观看。';
            } else if (err.name !== 'AbortError') {
                fail();
            }
        });
    };

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
            state.player = player;
            player.on(flvjs.Events.ERROR, fail);
            player.attachMediaElement(videoElement);
            player.load();
            play();
        } else {
            state.currentStream = null;
            syncStatus.textContent = '当前浏览器不支持 FLV 播放。';
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
            state.player = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, play);
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) fail();
            });
            hls.loadSource(url);
            hls.attachMedia(videoElement);
        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            videoElement.onloadedmetadata = play;
            videoElement.src = url;
        } else {
            state.currentStream = null;
            syncStatus.textContent = '当前浏览器不支持 HLS 播放。';
        }
    }
    // Sync dropdown state if needed (playStream might be called from buttons)
    // Find matching option
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
    if (state.currentStream) reconnectStream();
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
    forwardBtn.disabled = false;
    reloadBtn.disabled = false;
}

async function reconnectStream(automatic = false) {
    const stream = state.currentStream;
    if (!stream || state.reconnectController) return;
    if (automatic) {
        if (!autoLatencyToggle.checked || syncModeSelect.value !== 'fresh' || !stream.wantsPlay) return;
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
        // Room links are resolved again to renew expiring stream URLs; direct URLs are re-opened as supplied.
        if (state.currentUrl && !/\.(flv|m3u8)(?:[?#]|$)/i.test(state.currentUrl) && (!cdnSelected || stream.failed)) {
            const headers = REQUIRE_LOGIN && state.token ? { 'x-api-key': state.token } : {};
            const res = await axios.get('/api/live', {
                params: { url: state.currentUrl }, headers, signal: controller.signal, timeout: 10000
            });
            if (controller.signal.aborted || state.currentStream !== stream) return;
            if (!res.data.success) throw new Error(res.data.error || '直播地址获取失败');
            const qualities = res.data.data[type === 'flv' ? 'flv' : 'hls'];
            key = qualities?.[key] ? key : Object.keys(qualities || {})[0];
            if (!qualities?.[key]?.url) throw new Error('暂无可用直播画面，直播可能已经结束');
            url = qualities[key].url;
            cdnSelected = false;
            renderInfo(res.data.data);
            renderQualities(res.data.data, type);
        }
        if (controller.signal.aborted || state.currentStream !== stream) return;
        playStream(url, type, key, true, cdnSelected);
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
        if (syncModeSelect.value === 'fresh' &&
            (stream.failed || now - lastProgressAt >= stallTimeout || (lagSince !== null && now - lagSince >= 3000))) {
            reconnectStream(true);
            return;
        }
        if (target === null || stream.failed) return;

        if (lag > 1.5 && syncModeSelect.value === 'smooth') {
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
        ? '最新画面优先：明显落后或播放停滞时重新连接，可能短暂等待；点击“同步直播”可立即重连。'
        : '平滑追赶：通过加速和跳转追赶直播，不主动重新连接。';
    forwardBtn.title = fresh ? '重新连接，获取新的直播画面' : '跳转到当前可用的直播位置';
    syncStatus.textContent = '';
}

videoElement.addEventListener('play', () => {
    if (state.currentStream) {
        state.currentStream.wantsPlay = true;
        state.currentStream.playRequested = true;
    }
});
videoElement.addEventListener('pause', () => {
    // Ignore teardown events until the new stream has actually requested playback.
    if (!state.currentStream?.playRequested || !videoElement.paused || videoElement.error || state.currentStream.failed) return;
    state.currentStream.wantsPlay = false;
    cancelReconnect();
});
videoElement.addEventListener('error', () => {
    if (state.currentStream && videoElement.error) state.currentStream.failed = true;
});
videoElement.addEventListener('playing', () => {
    if (state.currentStream) syncStatus.textContent = '正在播放';
});

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

// --- CDN freshness comparison ---

function setCdnBusy(busy) {
    cdnTestBtn.disabled = busy || !Object.keys(state.cdnStreams).length;
    cdnCancelBtn.disabled = !busy;
    cdnQualitySelect.disabled = busy;
    cdnExtraUrls.disabled = busy;
    cdnUseBestBtn.disabled = busy || !state.cdnResult?.best;
}

function cancelCdnTest() {
    const run = state.cdnRun;
    if (!run) return;
    state.cdnRun = null;
    run.controller.abort();
    setCdnBusy(false);
    cdnStatus.textContent = '测速已取消。';
}

function updateCdnSources(streams) {
    cancelCdnTest();
    state.cdnStreams = streams;
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
    if (state.cdnRun || !row.eligible || state.cdnResult?.key !== key) return;
    playStream(row.url, 'flv', key, false, true);
}

async function startCdnTest() {
    if (state.cdnRun) return;
    const key = cdnQualitySelect.value;
    const source = state.cdnStreams[key];
    if (!source?.url) return;
    const extras = cdnExtraUrls.value.split(/\s+/).filter(text => /^https?:\/\//i.test(text));
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
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.cdnRun) {
        state.cdnRun.cancelReason = '页面已进入后台，测速已取消；请保持页面在前台后重试。';
        state.cdnRun.controller.abort();
    }
});

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
