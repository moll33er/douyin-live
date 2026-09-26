import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/quality-tester.js', import.meta.url), 'utf8');
function setup() {
    let now = 0, next = 0;
    const timers = new Map(), videos = [], players = [], listeners = new Map();
    function element(tag) {
        const value = { children: [], appendChild(child) { this.children.push(child); child.parent = this; },
            remove() { this.parent.children = this.parent.children.filter(child => child !== this); } };
        if (tag === 'video') {
            const callbacks = new Map();
            Object.assign(value, { callbacks, readyState: 4, seeking: false, currentTime: 0, videoWidth: 640, videoHeight: 360,
                buffered: { length: 1, start: () => 0, end: () => value.currentTime + 0.35 },
                requestVideoFrameCallback(fn) { callbacks.set(++next, fn); return next; },
                cancelVideoFrameCallback(id) { callbacks.delete(id); },
                play: () => Promise.resolve(), pause() { this.paused = true; }, removeAttribute() {}, load() {},
                frame(mediaTime = now / 1000 + (this.offset || 0)) {
                    this.currentTime = mediaTime;
                    const pending = [...callbacks]; callbacks.clear();
                    for (const [, fn] of pending) fn(now, { mediaTime, expectedDisplayTime: now });
                }
            });
            videos.push(value);
        }
        if (tag === 'canvas') value.getContext = () => ({ drawImage() {}, getImageData() { return { data: scene(now) }; } });
        return value;
    }
    const document = { hidden: false, body: element('body'), createElement: element,
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    const context = vm.createContext({ document, DOMException, performance: { now: () => now },
        setInterval: fn => { timers.set(++next, fn); return next; }, clearInterval: id => timers.delete(id),
        CdnTester: { streamUrl: url => url, chase: video => {
            video.chased = (video.chased || 0) + 1;
            video.offset = video.buffered.end(0) - 0.35 - now / 1000;
            return true;
        } },
        flvjs: { isSupported: () => true, Events: { ERROR: 'error' }, createPlayer() {
            const player = { on(name, fn) { this.error = fn; }, attachMediaElement() {}, load() {}, destroy() { this.destroyed = true; } };
            players.push(player); return player;
        } }
    });
    vm.runInContext(source, context);
    return { api: context.QualityTester, videos, players, timers, document, listeners, clock: () => now,
        tick(ms = 100, frames = true) { now += ms; if (frames) videos.forEach(video => video.frame()); for (const fn of [...timers.values()]) fn(); } };
}

function scene(time, quantize = 1) {
    const rgba = new Uint8ClampedArray(32 * 18 * 4);
    for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
        const level = Math.round((128 + 50 * Math.sin(x * 0.5 + time / 700) + 50 * Math.cos(y * 0.7 + time / 1100) +
            15 * Math.sin(x * y * 0.1 + time / 190)) / quantize) * quantize;
        const i = (y * 32 + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = level; rgba[i + 3] = 255;
    }
    return rgba;
}
const sequences = (api, delay, options = {}) => [0, 1].map(side => Array.from({ length: 200 }, (_, i) => {
    const at = i * 100;
    let pictureTime = at - (side ? (typeof delay === 'function' ? delay(i) : delay) : 0);
    if (options.static) pictureTime = 0;
    if (options.repeat) pictureTime = ((pictureTime % 2000) + 2000) % 2000;
    return { at: at + (side ? Math.sin(i) * 8 : 0), pixels: api.fingerprint(scene(pictureTime, side ? 12 : 1)) };
}));
const sources = [{ key: 'sd', url: 'https://cdn/sd.flv' }, { key: 'hd', url: 'https://cdn/hd.flv' }];

test('decoded pictures tolerate quality loss and use display clock to determine both lead directions', () => {
    const { api } = setup();
    for (const delay of [850, -1200, 0, 7000]) {
        const result = api.compare(...sequences(api, delay));
        assert.ok(result.eligible, result.error);
        assert.ok(Math.abs(result.deltaMs - delay) < 100, JSON.stringify(result));
        assert.equal(result.bestIndex, delay === 0 ? null : delay > 0 ? 0 : 1);
    }
});

test('static, repeated, unrelated, drifting and out-of-window content must not produce a winner', () => {
    const { api } = setup();
    for (const options of [{ static: true }, { repeat: true }]) {
        assert.equal(api.compare(...sequences(api, 800, options)).eligible, false);
    }
    assert.equal(api.compare(...sequences(api, i => i < 100 ? 800 : 1800)).eligible, false);
    assert.equal(api.compare(...sequences(api, 10000)).eligible, false);
    const [a, b] = sequences(api, 0);
    b.forEach((sample, i) => { sample.pixels = api.fingerprint(scene(i * 4673 + 270000)); });
    assert.equal(api.compare(a, b).eligible, false);
    assert.equal(api.compare(a.slice(0, 30), b).eligible, false);
});

test('measurement chases both players then samples, and releases callbacks, players and previews', async () => {
    const h = setup(), phases = [];
    const task = h.api.measure(sources, new AbortController().signal, info => phases.push(info.phase));
    for (let i = 0; i < 240; i++) h.tick();
    const result = await task;
    assert.ok(result.eligible, result.error);
    assert.equal(result.bestIndex, null);
    assert.ok(phases.includes('prepare') && phases.includes('sample'));
    assert.ok(h.videos.every(v => v.chased && v.paused && !v.callbacks.size));
    assert.ok(h.players.every(p => p.destroyed));
    assert.equal(h.document.body.children.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
});

test('chasing outlasts the cached pictures a CDN bursts at startup', async () => {
    const h = setup();
    const task = h.api.measure(sources, new AbortController().signal);
    // Measured on a real 原画 connection: its cache kept arriving at ~4.5x real time after the first frame.
    const hd = h.videos[1];
    hd.buffered = { length: 1, start: () => 0, end: () => Math.min(h.clock(), 3000) * 0.0045 + Math.max(0, h.clock() - 3000) / 1000 };
    for (let i = 0; i < 300; i++) h.tick();
    const result = await task;
    assert.ok(result.eligible, result.error);
    assert.ok(hd.chased >= 3, `chased ${hd.chased} times`);
});

test('a backlog that never settles is still reported as unable to reach the live position', async () => {
    const h = setup();
    const task = h.api.measure(sources, new AbortController().signal);
    h.videos[1].buffered = { length: 1, start: () => 0, end: () => h.clock() / 500 };
    for (let i = 0; i < 260; i++) h.tick();
    await assert.rejects(task, /hd：缓冲持续积压，无法稳定追到直播位置/);
    assert.ok(h.players.every(p => p.destroyed));
    assert.equal(h.timers.size, 0);
});

test('cancel, background, network failure, stalled playback and warmup timeout release every resource', async () => {
    for (const reason of ['cancel', 'background', 'network', 'stall', 'timeout']) {
        const h = setup(), controller = new AbortController();
        const task = h.api.measure(sources, controller.signal);
        if (reason === 'cancel') controller.abort();
        if (reason === 'background') { h.document.hidden = true; h.listeners.get('visibilitychange')(); }
        if (reason === 'network') h.players[0].error();
        if (reason === 'stall') { for (let i = 0; i < 30; i++) h.tick(); h.tick(1000, false); }
        if (reason === 'timeout') h.tick(26000, false);
        await assert.rejects(task);
        assert.ok(h.players.every(p => p.destroyed), reason);
        assert.ok(h.videos.every(v => !v.callbacks.size), reason);
        assert.equal(h.timers.size, 0, reason);
        assert.equal(h.document.body.children.length, 0, reason);
    }
});

test('same source and pre-cancelled measurements never open players', async () => {
    const h = setup(), controller = new AbortController();
    await assert.rejects(h.api.measure([sources[0], { ...sources[1], url: sources[0].url }], controller.signal), /同一播放地址/);
    controller.abort();
    await assert.rejects(h.api.measure(sources, controller.signal), { name: 'AbortError' });
    assert.equal(h.players.length, 0);
});

test('a failing progress renderer terminates measurement and releases its players', async () => {
    const h = setup();
    const task = h.api.measure(sources, new AbortController().signal, () => { throw new Error('render failed'); });
    h.tick();
    await assert.rejects(task, /render failed/);
    assert.ok(h.players.every(p => p.destroyed));
    assert.equal(h.timers.size, 0);
    assert.equal(h.document.body.children.length, 0);
});
