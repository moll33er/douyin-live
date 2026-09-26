import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('public/script.js', root), 'utf8');
const cdnSource = readFileSync(new URL('public/cdn-tester.js', root), 'utf8');
const html = readFileSync(new URL('public/index.html', root), 'utf8');
const ranges = (start, end) => ({ length: end > start ? 1 : 0, start: () => start, end: () => end });

function setup({ mode = 'fresh', nativeHls = false, liveResponse, cdnTester, qualityTester, localParser, danmaku } = {}) {
    let now = 100000;
    let timerId = 0;
    const timers = new Map();
    const timeouts = new Map();
    const players = [];
    const requests = [];
    const storage = new Map([['douyin_sync_mode', mode]]);
    function element() {
        const listeners = new Map();
        return {
            value: '', checked: false, options: [], textContent: '', disabled: false,
            classList: { add() {}, remove() {}, toggle() {} },
            set innerHTML(value) { this.options = []; },
            appendChild(child) { this.options.push(child); },
            addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
            emit(name) { this[`on${name}`]?.(); for (const fn of listeners.get(name) || []) fn(); },
            removeAttribute(name) { delete this[name]; }
        };
    }
    const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
    const video = elements.get('video-player');
    const standby = elements.get('video-standby');
    for (const media of [video, standby]) Object.assign(media, {
        currentTime: 0, playbackRate: 1, paused: true, seeking: false, readyState: 0, error: null, muted: false,
        buffered: ranges(0, 0), seekable: ranges(0, 0),
        pause() { this.paused = true; this.emit('pause'); },
        play() { this.paused = false; this.emit('play'); return Promise.resolve(); },
        load() { this.currentTime = 0; this.readyState = 0; this.error = null; this.buffered = ranges(0, 0); this.seekable = ranges(0, 0); },
        canPlayType: () => nativeHls ? 'probably' : ''
    });
    elements.get('auto-latency-toggle').checked = true;
    class Player {
        constructor() { this.events = new Map(); players.push(this); }
        on(event, fn) { this.events.set(event, fn); }
        attachMediaElement(media) { media.readyState = 4; this.media = media; }
        attachMedia(media) { media.readyState = 4; this.media = media; this.events.get('manifest')?.(); }
        loadSource(url) { this.url = url; }
        load() {}
        destroy() { this.destroyed = true; }
    }
    Player.isSupported = () => !nativeHls;
    Player.Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    const context = vm.createContext({
        document: { getElementById: id => elements.get(id), createElement: element, addEventListener() {}, querySelectorAll: () => [] },
        window: { addEventListener() {}, DouyinLocalParser: localParser, DouyinDanmaku: danmaku }, CdnTester: cdnTester, QualityTester: qualityTester,
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        axios: { get: async (url, options) => {
            if (url === '/api/config') return { data: { requireLogin: false } };
            requests.push(options);
            return liveResponse ? liveResponse(options) : { data: { success: true, data: { title: '直播', flv: { hd: { url: 'https://cdn/new.flv', label: '高清' } } } } };
        } },
        flvjs: { isSupported: () => true, Events: { ERROR: 'error' }, createPlayer: () => new Player() }, Hls: Player,
        Date: { now: () => now }, AbortController, DOMException, URL, console, alert() {},
        setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
        setTimeout: (fn, ms) => { timeouts.set(++timerId, { fn, at: now + ms }); return timerId; }, clearTimeout: id => timeouts.delete(id)
    });
    if (!cdnTester) vm.runInContext(cdnSource, context);
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    const start = (type = 'flv') => {
        run(`playStream('https://cdn/live.${type}', '${type}', 'hd')`);
        if (nativeHls) { video.readyState = 4; video.emit('loadedmetadata'); }
    };
    const tick = async (seconds = 1, advance = 0) => {
        for (let i = 0; i < seconds; i++) {
            now += 1000;
            run('videoElement').currentTime += advance;
            for (const [id, timeout] of [...timeouts]) if (timeout.at <= now) { timeouts.delete(id); timeout.fn(); }
            for (const fn of [...timers.values()]) fn();
            await Promise.resolve();
        }
    };
    // Lets the connection loading in the standby element become playable, then waits for the swap.
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    const ready = async () => {
        await flush();
        const media = run('standbyVideo');
        media.buffered = ranges(0, 4);
        media.emit('canplay');
        await flush();
    };
    return { run, start, tick, flush, ready, video, standby, elements, players, requests, storage, timers, timeouts };
}

test('both deployable frontends stay identical', () => {
    for (const file of ['script.js', 'index.html', 'style.css', 'cdn-tester.js', 'quality-tester.js', 'browser-parser.js', 'douyin-live-bridge.user.js', 'danmaku.js', 'danmaku-worker.js', 'douyin-sign.js']) {
        assert.equal(readFileSync(new URL(`public/${file}`, root), 'utf8'), readFileSync(new URL(`Cloudflare/public/${file}`, root), 'utf8'));
    }
});

test('offline room extraction leaves history untouched and live rooms still update it', async () => {
    let data;
    const h = setup({ liveResponse: () => ({ data: { success: true, data } }) });
    const url = 'https://live.douyin.com/123';
    const original = JSON.stringify([
        { url: 'https://live.douyin.com/456', title: '其他直播', anchor_name: '其他主播', timestamp: 20 },
        { url, title: '原直播标题', anchor_name: '原主播', timestamp: 10 }
    ]);
    h.storage.set('douyin_history', original);
    for (const status of [0, 4, '4', null]) {
        data = { status, title: '', anchor_name: '', flv: {}, hls: {} };
        for (const roomUrl of [url, 'https://live.douyin.com/789']) {
            h.elements.get('url-input').value = roomUrl;
            await h.run('handleExtract()');
            assert.equal(h.storage.get('douyin_history'), original);
        }
    }
    h.elements.get('url-input').value = url;
    for (const status of [2, '2']) {
        data = { status, title: '新直播标题', anchor_name: '主播新名字', flv: { hd: { url: 'https://cdn/live.flv' } } };
        await h.run('handleExtract()');
        const history = JSON.parse(h.storage.get('douyin_history'));
        assert.equal(history.length, 2);
        assert.deepEqual(history[0], { url: '123', title: data.title, anchor_name: data.anchor_name, timestamp: 100000 });
        assert.deepEqual(history[1], { ...JSON.parse(original)[0], url: '456' });
    }
});

test('share text resolves to the room number for the input, reloads and history', async () => {
    const h = setup({ liveResponse: () => ({ data: { success: true, data: {
        web_rid: '12345678901', status: 2, title: '直播', anchor_name: '主播', flv: { hd: { url: 'https://cdn/live.flv' } }
    } } }) });
    const share = '1- #在抖音，记录美好生活#【主播】正在直播，来和我一起支持Ta吧。复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/AbCdEfGh123/ 0@9.com :5pm';
    h.elements.get('url-input').value = share;
    await h.run('handleExtract()');
    assert.equal(h.requests[0].params.url, share);
    assert.equal(h.elements.get('url-input').value, '12345678901');
    assert.equal(h.run('state.currentUrl'), '12345678901');
    assert.equal(JSON.parse(h.storage.get('douyin_history'))[0].url, '12345678901');
});

test('with the userscript installed rooms are parsed in the browser instead of the server', async () => {
    const calls = [];
    const data = { web_rid: '555', status: 2, title: '直播', anchor_name: '主播', flv: { hd: { url: 'https://cdn/local.flv' } } };
    const h = setup({ localParser: { available: () => true, resolve: async (input, options) => { calls.push({ input, options }); return data; } } });
    h.elements.get('url-input').value = 'https://live.douyin.com/555';
    await h.run('handleExtract()');
    assert.equal(h.requests.length, 0);
    assert.equal(calls[0].input, 'https://live.douyin.com/555');
    assert.equal(h.elements.get('url-input').value, '555');
    assert.equal(h.run('state.currentUrl'), '555');
    assert.equal(h.elements.get('parse-source').textContent, '浏览器本地解析，线路按你当前的网络分配。');
});

test('a failed browser parse falls back to the server and says why', async () => {
    let outcome;
    const h = setup({ localParser: { available: () => true, resolve: async () => outcome() } });
    const extract = async () => { h.elements.get('url-input').value = '123'; await h.run('handleExtract()'); };
    outcome = () => { throw new TypeError('请求超时'); };
    await extract();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].params.url, '123');
    assert.equal(h.elements.get('parse-source').textContent, '浏览器解析失败（请求超时），已改用服务器解析。');
    outcome = () => null;
    await extract();
    assert.equal(h.requests.length, 2);
    assert.equal(h.elements.get('parse-source').textContent, '浏览器解析失败（没有取得直播间数据），已改用服务器解析。');
});

test('without the userscript rooms are parsed by the server as before', async () => {
    const h = setup({ localParser: { available: () => false, resolve: async () => assert.fail('the userscript is not installed') } });
    h.elements.get('url-input').value = '123';
    await h.run('handleExtract()');
    assert.equal(h.requests.length, 1);
    assert.equal(h.elements.get('parse-source').textContent, '服务器解析，线路按服务器所在的网络分配。');
    h.elements.get('url-input').value = 'https://cdn/live.flv';
    await h.run('handleExtract()');
    assert.equal(h.elements.get('parse-source').textContent, '', 'direct links are not parsed at all');
});

test('line candidates from the server and earlier parses of the same room reach discovery', async () => {
    const soon = Math.floor(100000 / 1000) + 30, later = Math.floor(100000 / 1000) + 3600;
    let data, extras;
    const h = setup({
        liveResponse: () => ({ data: { success: true, data } }),
        cdnTester: { discover: async (url, list) => { extras = list; return { nodes: [], failures: [] }; } }
    });
    const parse = async (room, sd1) => {
        data = { web_rid: room, status: 2, title: '直播', anchor_name: '主播', flv: { SD1: sd1 } };
        h.elements.get('url-input').value = room;
        await h.run('handleExtract()');
    };
    await parse('1', { url: `https://a/ld.flv?expire=${later}`, candidates: [`https://b/ld.flv?expire=${later}`, `https://a/other.flv?expire=${later}`, `https://f/ld.flv?expire=${soon}`] });
    await parse('1', { url: `https://c/ld.flv?expire=${later}`, candidates: [`https://d/ld.flv?expire=${later}`] });
    await h.run('startCdnTest()');
    assert.deepEqual([...extras], [`https://d/ld.flv?expire=${later}`, `https://a/ld.flv?expire=${later}`, `https://b/ld.flv?expire=${later}`]);
    await parse('2', { url: `https://e/ld.flv?expire=${later}` });
    await h.run('startCdnTest()');
    assert.deepEqual([...extras], []);
});

test('direct FLV and HLS extraction still saves history without a room status', async () => {
    const h = setup();
    for (const type of ['flv', 'm3u8']) {
        const url = `https://cdn/live.${type}?token=test`;
        h.elements.get('url-input').value = url;
        await h.run('handleExtract()');
        const history = JSON.parse(h.storage.get('douyin_history'));
        assert.equal(history[0].url, url);
        assert.equal(history[0].anchor_name, '直链');
    }
    assert.equal(JSON.parse(h.storage.get('douyin_history')).length, 2);
});

test('a direct link pasted without a scheme still opens instead of locking extraction', async () => {
    const h = setup();
    h.elements.get('url-input').value = 'cdn/live.flv?token=test';
    await h.run('handleExtract()');
    assert.equal(h.elements.get('extract-btn').disabled, false);
    assert.equal(h.run('state.currentStream.url'), 'cdn/live.flv?token=test');
});

test('smooth mode accelerates, restores speed, and seeks without reconnecting', async () => {
    const h = setup({ mode: 'smooth' });
    h.start();
    h.video.buffered = ranges(0, 100);
    h.video.currentTime = 98.5;
    await h.tick();
    assert.equal(h.video.playbackRate, 1.1);
    h.video.currentTime = 99.5;
    await h.tick();
    assert.equal(h.video.playbackRate, 1);
    h.video.currentTime = 70;
    await h.tick();
    assert.equal(h.video.currentTime, 99.5);
    assert.equal(h.players.length, 1);
});

test('every autoplay FLV connection skips the cached startup GOP once playable', async () => {
    const h = setup();
    h.start();
    h.video.buffered = ranges(0, 4);
    h.video.emit('canplay');
    assert.ok(Math.abs(h.video.currentTime - 3.65) < 1e-9);
    assert.equal(h.video.oncanplay, null);
    h.run("playStream('https://cdn/live.flv', 'flv', 'hd', false, false, false)");
    assert.equal(h.video.oncanplay, null, 'a paused restore must not jump on its own');
});

test('fresh mode jumps to the newest buffered picture instead of reconnecting for local backlog', async () => {
    const h = setup();
    h.start();
    h.video.buffered = ranges(0, 100);
    h.video.currentTime = 98.8;
    await h.tick();
    assert.equal(h.video.playbackRate, 1.1);
    h.video.currentTime = 98;
    await h.tick();
    assert.equal(h.video.currentTime, 99.5);
    for (let i = 0; i < 5; i++) {
        h.video.currentTime = 90;
        await h.tick();
        assert.equal(h.video.currentTime, 99.5);
        await h.tick();
    }
    assert.equal(h.video.playbackRate, 1);
    assert.equal(h.players.length, 1);
});

test('fresh mode reconnects when jumping cannot clear a persistent lag', async () => {
    const h = setup();
    h.start();
    h.video.buffered = ranges(0, 100);
    Object.defineProperty(h.video, 'currentTime', { get: () => 90, set() {}, configurable: true });
    await h.tick(3);
    assert.equal(h.players.length, 1);
    await h.tick();
    assert.equal(h.players.length, 2);
    assert.ok(!h.players[0].destroyed, 'the current picture stays until the new connection is ready');
    await h.ready();
    assert.ok(h.players[0].destroyed);
    assert.equal(h.timers.size, 1);
});

test('smooth mode also recovers failed and stalled connections', async () => {
    const h = setup({ mode: 'smooth' });
    h.start();
    h.players[0].events.get('error')();
    await h.tick();
    assert.equal(h.players.length, 2);
    await h.tick(14);
    assert.equal(h.players.length, 2);
    await h.tick();
    assert.equal(h.players.length, 3);
});

test('manual sync follows the selected mode even when automatic sync is off', async () => {
    const h = setup({ mode: 'smooth' });
    h.start();
    const auto = h.elements.get('auto-latency-toggle');
    auto.checked = false;
    auto.onchange();
    h.video.currentTime = 10;
    h.elements.get('forward-btn').onclick();
    assert.equal(h.video.currentTime, 10, 'an empty buffer must not seek blindly');
    h.video.buffered = ranges(0, 100);
    h.elements.get('forward-btn').onclick();
    assert.equal(h.video.currentTime, 99.5);
    const mode = h.elements.get('sync-mode');
    mode.value = 'fresh';
    mode.onchange();
    assert.equal(h.storage.get('douyin_sync_mode'), 'fresh');
    await h.tick(30);
    assert.equal(h.players.length, 1);
    h.elements.get('forward-btn').onclick();
    assert.equal(h.players.length, 2);
    assert.equal(h.timers.size, 0);
});

test('HLS uses its live sync point rather than the end of downloaded segments', async () => {
    const h = setup({ mode: 'smooth' });
    h.start('m3u8');
    h.players[0].liveSyncPosition = 92;
    h.video.buffered = ranges(0, 100);
    h.video.currentTime = 92;
    await h.tick();
    assert.equal(h.video.currentTime, 92);
    assert.equal(h.video.playbackRate, 1);
    h.video.currentTime = 70;
    h.elements.get('forward-btn').onclick();
    assert.equal(h.video.currentTime, 92);
});

test('native HLS is monitored, uses seekable, and replaces its metadata handler', async () => {
    const h = setup({ mode: 'smooth', nativeHls: true });
    h.start('m3u8');
    const oldHandler = h.video.onloadedmetadata;
    h.start('m3u8');
    assert.notEqual(h.video.onloadedmetadata, oldHandler);
    h.video.seekable = ranges(50, 100);
    h.video.buffered = ranges(50, 80);
    h.video.currentTime = 60;
    await h.tick();
    assert.equal(h.video.currentTime, 99);
    assert.equal(h.timers.size, 1);
    h.run('destroyPlayer()');
    assert.equal(h.video.onloadedmetadata, null);
    assert.equal(h.timers.size, 0);
});

test('paused playback does not trigger automatic reconnects, even after a stream error', async () => {
    const h = setup();
    h.start();
    h.video.pause();
    h.players[0].events.get('error')();
    await h.tick(60);
    assert.equal(h.players.length, 1);
});

test('pausing during initial loading also suppresses recovery after a later failure', async () => {
    const h = setup();
    h.start();
    h.video.readyState = 0;
    h.video.pause();
    h.players[0].events.get('error')();
    await h.tick(30);
    assert.equal(h.players.length, 1);
});

test('stall recovery respects HLS segment duration and ignores ordinary segment gaps', async () => {
    const h = setup();
    h.start('m3u8');
    h.players[0].currentLevel = 0;
    h.players[0].levels = [{ details: { targetduration: 8 } }];
    await h.tick(30, 1);
    assert.equal(h.players.length, 1, 'advancing playback is healthy without buffer-end updates');
    await h.tick(23);
    assert.equal(h.players.length, 1);
    await h.tick();
    assert.equal(h.players.length, 2);
});

test('repeated fatal failures have a cooldown and stop after three automatic attempts', async () => {
    const h = setup();
    h.start();
    h.players.at(-1).events.get('error')();
    await h.tick();
    assert.equal(h.players.length, 2);
    h.players.at(-1).events.get('error')();
    await h.tick(14);
    assert.equal(h.players.length, 2);
    await h.tick();
    assert.equal(h.players.length, 3);
    h.players.at(-1).events.get('error')();
    await h.tick(15);
    assert.equal(h.players.length, 4);
    h.players.at(-1).events.get('error')();
    await h.tick(30);
    assert.equal(h.players.length, 4);
    assert.equal(h.timers.size, 0);
    assert.match(h.elements.get('sync-status').textContent, /停止自动重试/);
});

test('healthy playback replenishes the automatic retry budget', async () => {
    const h = setup();
    h.start();
    h.run('state.reconnectAttempts = 3');
    await h.tick(31, 1);
    assert.equal(h.run('state.reconnectAttempts'), 0);
});

test('room reload refreshes its URL and retains the selected quality', async () => {
    const h = setup();
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reload = h.run('reconnectStream(false, true)');
    await h.ready();
    await reload;
    assert.equal(h.requests[0].params.url, 'https://live.douyin.com/123');
    assert.equal(h.requests[0].timeout, 10000);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/new.flv');
    assert.equal(h.run('state.currentStream.key'), 'hd');
    assert.equal(JSON.parse(h.elements.get('quality-select').value).url, 'https://cdn/new.flv');
});

test('room reloads also parse in the browser, and a cancelled one is not retried on the server', async () => {
    const calls = [];
    let stall = false;
    const h = setup({ localParser: { available: () => true, resolve: (input, options) => {
        calls.push(options);
        if (!stall) return Promise.resolve({ flv: { hd: { url: 'https://cdn/local.flv', label: '高清' } } });
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
    } } });
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reload = h.run('reconnectStream(false, true)');
    await h.ready();
    await reload;
    assert.equal(calls[0].timeout, 10000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/local.flv');

    stall = true;
    const reconnect = h.run('reconnectStream(false, true)');
    h.run("playStream('https://cdn/other.flv', 'flv', 'other')");
    await reconnect;
    assert.equal(calls[1].signal.aborted, true);
    assert.equal(h.requests.length, 0);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/other.flv');
});

test('an HLS reconnect keeps the quality selector consistent when FLV becomes available', async () => {
    const h = setup({ liveResponse: () => ({ data: { success: true, data: {
        flv: { hd: { url: 'https://cdn/new.flv', label: '高清' } },
        hls: { hd: { url: 'https://cdn/new.m3u8', label: '高清' } }
    } } }) });
    h.start('m3u8');
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reload = h.run('reconnectStream(false, true)');
    await h.ready();
    await reload;
    assert.equal(h.run('state.currentStream.type'), 'm3u8');
    assert.equal(JSON.parse(h.elements.get('quality-select').value).url, 'https://cdn/new.m3u8');
});

test('switching streams discards a late reconnect response', async () => {
    let resolve;
    const h = setup({ liveResponse: () => new Promise(done => { resolve = done; }) });
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reconnect = h.run('reconnectStream(false, true)');
    h.run("playStream('https://cdn/other.flv', 'flv', 'other')");
    assert.equal(h.requests[0].signal.aborted, true);
    resolve({ data: { success: true, data: { flv: { hd: { url: 'https://cdn/stale.flv' } } } } });
    await reconnect;
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/other.flv');
    assert.equal(h.players.length, 2);
});

test('mode changes cancel pending reconnects and keep only one monitor', async () => {
    let resolve;
    const h = setup({ liveResponse: () => new Promise(done => { resolve = done; }) });
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reconnect = h.run('reconnectStream(true, true)');
    h.elements.get('sync-mode').value = 'smooth';
    h.elements.get('sync-mode').onchange();
    assert.equal(h.requests[0].signal.aborted, true);
    resolve({ data: { success: false } });
    await reconnect;
    assert.equal(h.players.length, 1);
    assert.equal(h.timers.size, 1);
    assert.equal(h.elements.get('forward-btn').disabled, false);
});

test('reconnects reuse a valid room URL and only resolve broken or expiring ones', async () => {
    const h = setup();
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    let reconnect = h.run('reconnectStream()');
    await h.ready(); await reconnect;
    assert.equal(h.requests.length, 0);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/live.flv');
    h.run("playStream('https://cdn/live.flv?expire=100000', 'flv', 'hd')");
    reconnect = h.run('reconnectStream()');
    await h.ready(); await reconnect;
    assert.equal(h.requests.length, 0, 'a URL far from expiry is reopened as is');
    h.run("playStream('https://cdn/live.flv?expire=130', 'flv', 'hd')");
    reconnect = h.run('reconnectStream()');
    await h.ready(); await reconnect;
    assert.equal(h.requests.length, 1, 'a URL expiring within a minute is renewed');
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/new.flv');
    h.run('state.currentStream.failed = true');
    await h.run('reconnectStream()');
    assert.equal(h.requests.length, 2, 'a failed connection is renewed');
});

test('reconnecting a playing stream keeps its picture until the caught-up replacement takes over', async () => {
    const h = setup();
    h.start();
    const first = h.run('videoElement');
    first.volume = 0.4;
    h.elements.get('forward-btn').onclick();
    const second = h.run('standbyVideo');
    assert.equal(second.muted, true);
    assert.equal(h.players.length, 2);
    assert.equal(h.run('state.player'), h.players[0]);
    assert.equal(first.paused, false);
    assert.match(h.elements.get('sync-status').textContent, /当前画面继续播放/);
    await h.ready();
    assert.equal(h.run('videoElement'), second);
    assert.equal(h.run('standbyVideo'), first);
    assert.equal(second.muted, false);
    assert.equal(second.volume, 0.4);
    assert.ok(Math.abs(second.currentTime - 3.65) < 1e-9, 'the replacement starts from its newest buffered picture');
    assert.ok(h.players[0].destroyed);
    assert.equal(h.players[0].media, first);
    assert.equal(h.run('state.player'), h.players[1]);
    assert.equal(first.paused, true);
    assert.equal(h.run('state.currentStream.wantsPlay'), true, 'retiring the old element is not a user pause');
    assert.equal(h.elements.get('forward-btn').disabled, false);
    assert.equal(h.timers.size, 1);
});

test('a replacement that fails or times out keeps the current picture and renews the room URL next time', async () => {
    const h = setup();
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const first = h.run('videoElement');
    let reconnect = h.run('reconnectStream()');
    h.players[1].events.get('error')();
    await reconnect;
    assert.equal(h.run('videoElement'), first);
    assert.ok(h.players[1].destroyed);
    assert.ok(!h.players[0].destroyed);
    assert.equal(h.run('state.player'), h.players[0]);
    assert.match(h.elements.get('sync-status').textContent, /新连接未能就绪.*继续播放当前画面/);
    assert.equal(h.requests.length, 0);
    reconnect = h.run('reconnectStream()');
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.players.length, 3);
    await h.tick(10);
    await reconnect;
    assert.equal(h.run('videoElement'), first);
    assert.ok(h.players[2].destroyed);
    assert.ok(!h.players[0].destroyed);
    assert.match(h.elements.get('sync-status').textContent, /加载超时/);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.elements.get('forward-btn').disabled, false);
});

test('switching streams while a replacement loads discards it', async () => {
    const h = setup();
    h.start();
    const reconnect = h.run('reconnectStream()');
    const replacement = h.players[1];
    h.run("playStream('https://cdn/other.flv', 'flv', 'other')");
    await reconnect;
    assert.ok(replacement.destroyed);
    assert.equal(h.run('state.standby'), null);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/other.flv');
    assert.equal(h.run('state.player'), h.players[2]);
});

test('benchmark resumes playback and applying its result preserves the selected node on reconnect', async () => {
    const best = { url: 'https://edge/live.flv', host: 'edge', eligible: true, arrivalLagMs: 0, pictureLagMs: 0 };
    const h = setup({ cdnTester: {
        chase: () => true,
        discover: async () => ({ nodes: [best, { url: 'https://second/live.flv' }], failures: [] }),
        measure: async () => ({ rows: [best], best, warmupSeconds: 10, matchedFrames: 100 })
    } });
    h.run("renderQualities({flv:{hd:{url:'https://cdn/live.flv',label:'高清'}}}); state.currentUrl='https://live.douyin.com/123'");
    h.start();
    await h.run('startCdnTest()');
    assert.equal(h.players.length, 2, 'original player is restored after testing');
    assert.ok(h.players[0].destroyed);
    assert.match(h.elements.get('cdn-status').textContent, /匹配 100 个相同画面/);
    h.elements.get('cdn-use-best-btn').onclick();
    assert.equal(h.run('state.currentStream.url'), best.url);
    assert.equal(h.run('state.currentStream.cdnSelected'), true);
    assert.equal(JSON.parse(h.elements.get('quality-select').value).key, 'hd');
    const reconnect = h.run('reconnectStream()');
    await h.ready();
    await reconnect;
    assert.equal(h.run('state.currentStream.url'), best.url);
    assert.equal(h.requests.length, 0);
    h.run('state.currentStream.failed = true');
    await h.run('reconnectStream()');
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/new.flv');
    assert.equal(h.run('state.currentStream.cdnSelected'), false);
});

test('changing streams aborts a benchmark and its late result cannot restore the old stream', async () => {
    let resolve;
    let signal;
    const h = setup({ cdnTester: { discover: (url, extras, s) => { signal = s; return new Promise(done => { resolve = done; }); } } });
    h.run("updateCdnSources({hd:{url:'https://cdn/live.flv'}})");
    h.start();
    const testRun = h.run('startCdnTest()');
    h.run("playStream('https://other/live.flv', 'flv', 'hd')");
    assert.equal(signal.aborted, true);
    resolve({ nodes: [], failures: [] });
    await testRun;
    assert.equal(h.run('state.currentStream.url'), 'https://other/live.flv');
    assert.equal(h.elements.get('cdn-cancel-btn').disabled, true);
});

test('cancelling a benchmark restores a paused player without autoplay', async () => {
    const h = setup({ cdnTester: { discover: (url, extras, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    }) } });
    h.run("updateCdnSources({hd:{url:'https://cdn/live.flv'}})");
    h.start(); h.video.pause();
    const run = h.run('startCdnTest()');
    h.elements.get('cdn-cancel-btn').onclick();
    await run;
    assert.equal(h.video.paused, true);
    assert.equal(h.run('state.currentStream.wantsPlay'), false);
    assert.equal(h.timers.size, 1);
    assert.match(h.elements.get('cdn-status').textContent, /取消/);
});

const qualityData = "{flv:{ORIGIN:{url:'https://cdn/original.flv',label:'原画'},SD1:{url:'https://cdn/sd.flv',label:'标清'}}}";
test('quality comparison restores playback, recommends the selected winner and clears stale results', async () => {
    const h = setup({ qualityTester: { measure: async sources => {
        assert.equal(sources[0].key, 'SD1'); assert.equal(sources[1].key, 'ORIGIN');
        return { eligible: true, bestIndex: 1, deltaMs: -600, uncertaintyMs: 200, matchedFrames: 120 };
    } } });
    h.run(`renderQualities(${qualityData})`); h.start();
    await h.run('startQualityTest()');
    assert.ok(h.players[0].destroyed);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/live.flv');
    assert.match(h.elements.get('quality-compare-status').textContent, /原画.*0.6 秒/);
    assert.equal(h.elements.get('quality-use-best-btn').disabled, false);
    h.elements.get('quality-use-best-btn').onclick();
    assert.equal(h.run('state.currentStream.key'), 'ORIGIN');
    h.elements.get('quality-compare-b').value = 'SD1';
    h.elements.get('quality-compare-b').onchange();
    assert.equal(h.run('state.qualityResult'), null);
    assert.equal(h.elements.get('quality-test-btn').disabled, true);
});

test('switching rooms or streams aborts quality comparison and discards late results', async () => {
    let resolve, signal;
    const h = setup({ qualityTester: { measure: (sources, s) => { signal = s; return new Promise(done => { resolve = done; }); } } });
    h.run(`renderQualities(${qualityData})`); h.start();
    const task = h.run('startQualityTest()');
    assert.equal(h.elements.get('cdn-test-btn').disabled, true);
    await h.run('startCdnTest()');
    assert.equal(h.run('state.cdnRun'), null);
    h.run("playStream('https://new/room.flv', 'flv', 'other')");
    assert.equal(signal.aborted, true);
    resolve({ eligible: true, bestIndex: 0, deltaMs: 800, uncertaintyMs: 200, matchedFrames: 80 });
    await task;
    assert.equal(h.run('state.currentStream.url'), 'https://new/room.flv');
    assert.equal(h.run('state.qualityResult'), null);
    assert.equal(h.elements.get('quality-cancel-btn').disabled, true);
});

test('cancelling quality comparison preserves paused playback and uncertain results cannot be applied', async () => {
    const qualityTester = { measure: (sources, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    }) };
    const h = setup({ qualityTester });
    h.run(`renderQualities(${qualityData})`); h.start(); h.video.pause();
    const task = h.run('startQualityTest()');
    h.elements.get('quality-cancel-btn').onclick(); await task;
    assert.equal(h.video.paused, true);
    assert.equal(h.run('state.currentStream.wantsPlay'), false);
    assert.match(h.elements.get('quality-compare-status').textContent, /取消/);
    qualityTester.measure = async () => ({ eligible: false, error: '重复画面' });
    await h.run('startQualityTest()');
    assert.equal(h.elements.get('quality-use-best-btn').disabled, true);
    assert.match(h.elements.get('quality-compare-status').textContent, /无法判定.*重复画面/);
});

test('live comments connect once a live room plays, survive stream switches and stop with the room or toggle', async () => {
    const calls = [], added = [];
    let cleared = 0;
    const danmaku = {
        connect(roomId, options) { calls.push({ roomId, ...options }); },
        DanmakuOverlay: class { add(text) { added.push(text); } clear() { cleared++; } }
    };
    let data = { web_rid: '555', room_id: '7689', status: 2, title: '直播', flv: { hd: { url: 'https://cdn/live.flv' } } };
    const h = setup({ danmaku, liveResponse: () => ({ data: { success: true, data } }) });
    h.elements.get('url-input').value = '555';
    await h.run('handleExtract()');
    assert.equal(calls.length, 0, 'nothing plays yet');
    h.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].roomId, '7689');
    h.run("playStream('https://cdn/other.flv', 'flv', 'sd')");
    assert.equal(calls.length, 1, 'switching quality keeps the connection');
    calls[0].onStatus('弹幕已连接。');
    calls[0].onComment({ content: '你好' });
    assert.equal(h.elements.get('danmaku-status').textContent, '弹幕已连接。');
    assert.deepEqual(added, ['你好']);

    const toggle = h.elements.get('danmaku-toggle');
    assert.equal(toggle.checked, true, 'on by default');
    toggle.checked = false; toggle.emit('change');
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(h.storage.get('douyin_danmaku'), 'off');
    assert.equal(h.elements.get('danmaku-status').textContent, '');
    assert.ok(cleared >= 1);
    toggle.checked = true; toggle.emit('change');
    assert.equal(calls.length, 2);

    data = { ...data, room_id: '8888', status: 4 };
    await h.run('handleExtract()');
    assert.equal(calls[1].signal.aborted, true, 'a new parse ends the old room');
    h.start();
    assert.equal(calls.length, 2, 'offline rooms have no live comments');
});
