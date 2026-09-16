import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('public/script.js', root), 'utf8');
const html = readFileSync(new URL('public/index.html', root), 'utf8');
const ranges = (start, end) => ({ length: end > start ? 1 : 0, start: () => start, end: () => end });

function setup({ mode = 'fresh', nativeHls = false, liveResponse, cdnTester } = {}) {
    let now = 100000;
    let timerId = 0;
    const timers = new Map();
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
    Object.assign(video, {
        currentTime: 0, playbackRate: 1, paused: true, seeking: false, readyState: 0, error: null,
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
        attachMediaElement() { video.readyState = 4; }
        attachMedia() { video.readyState = 4; this.events.get('manifest')?.(); }
        loadSource(url) { this.url = url; }
        load() {}
        destroy() { this.destroyed = true; }
    }
    Player.isSupported = () => !nativeHls;
    Player.Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    const context = vm.createContext({
        document: { getElementById: id => elements.get(id), createElement: element, addEventListener() {}, querySelectorAll: () => [] },
        window: { addEventListener() {} }, CdnTester: cdnTester,
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        axios: { get: async (url, options) => {
            if (url === '/api/config') return { data: { requireLogin: false } };
            requests.push(options);
            return liveResponse ? liveResponse(options) : { data: { success: true, data: { title: '直播', flv: { hd: { url: 'https://cdn/new.flv', label: '高清' } } } } };
        } },
        flvjs: { isSupported: () => true, Events: { ERROR: 'error' }, createPlayer: () => new Player() }, Hls: Player,
        Date: { now: () => now }, AbortController, URL, console, alert() {},
        setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id)
    });
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    const start = (type = 'flv') => {
        run(`playStream('https://cdn/live.${type}', '${type}', 'hd')`);
        if (nativeHls) { video.readyState = 4; video.emit('loadedmetadata'); }
    };
    const tick = async (seconds = 1, advance = 0) => {
        for (let i = 0; i < seconds; i++) {
            now += 1000;
            video.currentTime += advance;
            for (const fn of [...timers.values()]) fn();
            await Promise.resolve();
        }
    };
    return { run, start, tick, video, elements, players, requests, storage, timers };
}

test('both deployable frontends stay identical', () => {
    for (const file of ['script.js', 'index.html', 'style.css', 'cdn-tester.js']) {
        assert.equal(readFileSync(new URL(`public/${file}`, root), 'utf8'), readFileSync(new URL(`Cloudflare/public/${file}`, root), 'utf8'));
    }
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

test('fresh mode tolerates a brief lag but reconnects when lag persists', async () => {
    const h = setup();
    h.start();
    h.video.buffered = ranges(0, 100);
    h.video.currentTime = 90;
    await h.tick(3, 1);
    assert.equal(h.players.length, 1);
    await h.tick(1, 1);
    assert.equal(h.players.length, 2);
    assert.ok(h.players[0].destroyed);
    assert.equal(h.timers.size, 1);
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

test('room reconnect refreshes its URL and retains the selected quality', async () => {
    const h = setup();
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    await h.run('reconnectStream()');
    assert.equal(h.requests[0].params.url, 'https://live.douyin.com/123');
    assert.equal(h.requests[0].timeout, 10000);
    assert.equal(h.run('state.currentStream.url'), 'https://cdn/new.flv');
    assert.equal(h.run('state.currentStream.key'), 'hd');
    assert.equal(JSON.parse(h.elements.get('quality-select').value).url, 'https://cdn/new.flv');
});

test('an HLS reconnect keeps the quality selector consistent when FLV becomes available', async () => {
    const h = setup({ liveResponse: () => ({ data: { success: true, data: {
        flv: { hd: { url: 'https://cdn/new.flv', label: '高清' } },
        hls: { hd: { url: 'https://cdn/new.m3u8', label: '高清' } }
    } } }) });
    h.start('m3u8');
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    await h.run('reconnectStream()');
    assert.equal(h.run('state.currentStream.type'), 'm3u8');
    assert.equal(JSON.parse(h.elements.get('quality-select').value).url, 'https://cdn/new.m3u8');
});

test('switching streams discards a late reconnect response', async () => {
    let resolve;
    const h = setup({ liveResponse: () => new Promise(done => { resolve = done; }) });
    h.start();
    h.run("state.currentUrl = 'https://live.douyin.com/123'");
    const reconnect = h.run('reconnectStream()');
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
    const reconnect = h.run('reconnectStream(true)');
    h.elements.get('sync-mode').value = 'smooth';
    h.elements.get('sync-mode').onchange();
    assert.equal(h.requests[0].signal.aborted, true);
    resolve({ data: { success: false } });
    await reconnect;
    assert.equal(h.players.length, 1);
    assert.equal(h.timers.size, 1);
    assert.equal(h.elements.get('forward-btn').disabled, false);
});

test('benchmark resumes playback and applying its result preserves the selected node on reconnect', async () => {
    const best = { url: 'https://edge/live.flv', host: 'edge', eligible: true, arrivalLagMs: 0, pictureLagMs: 0 };
    const h = setup({ cdnTester: {
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
    await h.run('reconnectStream()');
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
