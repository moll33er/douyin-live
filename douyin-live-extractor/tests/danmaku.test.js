import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { pushAddress, encodeFrame, decodeFields, readFrame, readChat, connect, DanmakuOverlay } from '../public/danmaku.js';

const root = new URL('../', import.meta.url);

// --- Minimal protobuf builder for Douyin frames ---
function varint(value) {
    let rest = BigInt(value);
    const out = [];
    do { const low = Number(rest & 0x7fn); rest >>= 7n; out.push(rest ? low | 0x80 : low); } while (rest);
    return out;
}
const field = (number, value) => typeof value === 'number' || typeof value === 'bigint'
    ? [...varint(number << 3), ...varint(value)]
    : (bytes => [...varint(number << 3 | 2), ...varint(bytes.length), ...bytes])(typeof value === 'string' ? [...Buffer.from(value)] : [...value]);
const pb = (...fields) => Uint8Array.from(fields.flat());
const chat = ({ id, content, nickname = '用户', eventTime }) =>
    pb(field(1, pb(field(2, BigInt(id)))), field(2, pb(field(3, nickname))), field(3, content), eventTime ? field(15, eventTime) : []);
const message = (method, payload, msgId = 1) => pb(field(1, method), field(2, payload), field(3, BigInt(msgId)));
function frame({ messages = [], now, needAck = false, internalExt = 'ext', logId = 7n, type = 'msg' }) {
    const response = pb(...messages.map(m => field(1, m)), now ? field(4, now) : [], field(5, internalExt), needAck ? field(9, 1) : []);
    return pb(field(2, logId), field(7, type), field(8, gzipSync(response)));
}

test('the push address signs the documented parameters for the room', () => {
    const { url, signInput } = pushAddress('7689889057404439315', 1790000000000);
    assert.equal(signInput, 'live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.14-beta.0,room_id=7689889057404439315,'
        + 'sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=7319483754668557238,device_platform=web,device_type=,ac=,identity=audience');
    assert.ok(url.startsWith('wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?app_name=douyin_web&'));
    assert.match(url, /&room_id=7689889057404439315&/);
    assert.match(url, /wss_push_room_id:7689889057404439315\|/);
    assert.match(url, /cursor=d-1_u-1_fh-7392091211001140287_t-1790000000000_r-1/);
    assert.throws(() => pushAddress('12a'), /房间 ID 无效/);
});

test('frames round-trip, including 64-bit ids and heartbeats', async () => {
    assert.deepEqual([...encodeFrame({ payloadType: 'hb' })], [0x3a, 2, 0x68, 0x62]);
    const ack = decodeFields(encodeFrame({ logId: 18446744073709551615n, payloadType: 'ack', payload: Buffer.from('ext') }));
    assert.equal(ack[2][0], 18446744073709551615n);
    assert.equal(Buffer.from(ack[7][0]).toString(), 'ack');
    assert.equal(Buffer.from(ack[8][0]).toString(), 'ext');
    assert.throws(() => decodeFields(Uint8Array.from([0x1a, 5, 1])), /不完整/);

    const read = await readFrame(frame({ now: 1790000001000, needAck: true, messages: [
        message('WebcastChatMessage', chat({ id: 9007199254740993n, content: ' 你好 ', nickname: 'J***', eventTime: 1790000000 }), 42)
    ] }));
    assert.equal(read.type, 'msg');
    assert.equal(read.needAck, true);
    assert.equal(read.now, 1790000001000);
    assert.equal(Buffer.from(read.internalExt).toString(), 'ext');
    assert.deepEqual(readChat(read.messages[0]), { id: '9007199254740993', content: '你好', nickname: 'J***', createdAt: 1790000000000 });
    assert.equal((await readFrame(pb(field(7, 'hb')))).type, 'hb');
});

// --- connect() against a scripted websocket ---
function harness(modes) {
    const sockets = [], signs = [], fetches = [], sleeps = [], intervals = [], statuses = [], comments = [];
    let clock = 1790000000000;
    class FakeSocket {
        constructor(url) {
            this.url = url; this.sent = []; this.readyState = 0;
            const mode = modes[sockets.length] ?? 'refuse';
            sockets.push(this);
            queueMicrotask(() => mode === 'open' ? this.accept() : this.drop());
        }
        accept() { this.readyState = 1; this.onopen(); }
        drop() { if (this.readyState === 3) return; this.readyState = 3; this.onerror({}); this.onclose({ code: 1006 }); }
        send(bytes) { this.sent.push(bytes); }
        close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose({ code: 1000 })); }
        receive(bytes) { this.onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
    }
    const controller = new AbortController();
    const env = {
        WebSocket: FakeSocket,
        sign: async input => { signs.push(input); return 'SIG+/='; },
        fetch: async (url, options) => { fetches.push({ url, options }); },
        sleep: async ms => { sleeps.push(ms); },
        setInterval: (fn, ms) => intervals.push({ fn, ms }),
        clearInterval: () => {},
        now: () => clock
    };
    const done = connect('7689', { signal: controller.signal, onStatus: s => statuses.push(s), onComment: c => comments.push(c.content) }, env);
    const waitFor = async (condition, what) => {
        for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 2));
        assert.ok(condition(), `timed out waiting for ${what}`);
    };
    return { sockets, signs, fetches, sleeps, intervals, statuses, comments, controller, done, waitFor, advance: ms => { clock += ms; }, now: () => clock };
}

test('a refused handshake fetches the Douyin cookie once, then chats flow with heartbeats and acks', async () => {
    const h = harness(['refuse', 'open']);
    await h.waitFor(() => h.sockets.length === 2 && h.sockets[1].readyState === 1, 'second socket');
    assert.equal(h.fetches.length, 1);
    assert.equal(h.fetches[0].url, 'https://live.douyin.com/');
    assert.equal(h.fetches[0].options.mode, 'no-cors');
    assert.equal(h.fetches[0].options.credentials, 'include');
    assert.ok(h.sockets[1].url.endsWith('&signature=SIG%2B%2F%3D'));
    assert.equal(h.signs.length, 2);
    assert.equal(h.intervals.at(-1).ms, 5000);
    h.intervals.at(-1).fn();
    assert.deepEqual([...h.sockets[1].sent[0]], [0x3a, 2, 0x68, 0x62]);

    const nowSeconds = Math.floor(h.now() / 1000);
    h.sockets[1].receive(frame({ now: h.now(), needAck: true, logId: 18446744073709551615n, messages: [
        message('WebcastChatMessage', chat({ id: 1, content: '新弹幕', eventTime: nowSeconds - 1 }), 11),
        message('WebcastChatMessage', chat({ id: 2, content: '一分钟前的积压', eventTime: nowSeconds - 60 }), 12),
        message('WebcastEmojiChatMessage', pb(field(1, pb(field(2, 3n))), field(5, '[比心]')), 13),
        message('WebcastGiftMessage', pb(field(1, pb(field(2, 4n)))), 14)
    ] }));
    h.sockets[1].receive(frame({ now: h.now(), messages: [message('WebcastChatMessage', chat({ id: 1, content: '新弹幕', eventTime: nowSeconds - 1 }), 11)] }));
    await h.waitFor(() => h.comments.length === 2 && h.sockets[1].sent.length === 2, 'comments');
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(h.comments, ['新弹幕', '[比心]'], 'backlog, gifts and repeats are not shown');
    const ack = decodeFields(h.sockets[1].sent[1]);
    assert.equal(Buffer.from(ack[7][0]).toString(), 'ack');
    assert.equal(ack[2][0], 18446744073709551615n);
    assert.equal(Buffer.from(ack[8][0]).toString(), 'ext');

    h.controller.abort();
    await h.done;
    assert.equal(h.sockets[1].readyState, 3);
    assert.deepEqual(h.statuses, ['弹幕连接中…', '正在向抖音获取访客 Cookie…', '弹幕已连接。']);
});

test('refusals that persist after fetching the cookie stop with an explanation', async () => {
    const h = harness(['refuse', 'refuse', 'refuse', 'open']);
    await h.done;
    assert.equal(h.sockets.length, 3);
    assert.equal(h.fetches.length, 1);
    assert.match(h.statuses.at(-1), /第三方 Cookie/);
});

test('dropped connections reconnect with backoff until the live ends', async () => {
    const h = harness(['open', 'open', 'open']);
    await h.waitFor(() => h.sockets[0]?.readyState === 1, 'first socket');
    h.advance(40000);
    h.sockets[0].drop();
    await h.waitFor(() => h.sockets[1]?.readyState === 1, 'second socket');
    h.sockets[1].drop();
    await h.waitFor(() => h.sockets[2]?.readyState === 1, 'third socket');
    assert.deepEqual(h.sleeps, [1000, 2000], 'a long session resets the backoff, a short one doubles it');
    h.sockets[2].receive(frame({ messages: [message('WebcastControlMessage', pb(field(2, 3)))] }));
    await h.done;
    assert.equal(h.sockets.length, 3);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.statuses.at(-1), '直播已结束，弹幕已停止。');
});

test('signing failures stop without retrying', async () => {
    const statuses = [];
    await connect('7689', { signal: new AbortController().signal, onStatus: s => statuses.push(s), onComment() {} },
        { sign: async () => { throw new Error('签名超时'); }, WebSocket: class { constructor() { assert.fail('no socket without a signature'); } } });
    assert.equal(statuses.at(-1), '弹幕加载失败（签名超时）。');
});

test('the worker hashes UTF-8 input with md5 and signs it with the vendored Douyin signer', () => {
    const replies = [];
    const context = vm.createContext({
        TextEncoder,
        postMessage: reply => replies.push(reply),
        importScripts: name => vm.runInContext(readFileSync(new URL(`public/${name}`, root), 'utf8'), context)
    });
    vm.runInContext(readFileSync(new URL('public/danmaku-worker.js', root), 'utf8'), context);
    for (const input of ['', 'abc', '弹幕,room_id=1', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(999)]) {
        assert.equal(vm.runInContext(`md5(${JSON.stringify(input)})`, context), createHash('md5').update(input).digest('hex'));
    }
    context.onmessage({ data: { id: 3, input: pushAddress('7689').signInput } });
    assert.equal(replies[0].id, 3);
    assert.equal(typeof replies[0].signature, 'string');
    assert.ok(replies[0].signature.length >= 8);
});

// --- Overlay ---
function overlayHarness({ width = 800, height = 450, hidden = false } = {}) {
    let now = 0;
    const timeouts = [];
    const layer = {
        clientWidth: width, clientHeight: height, children: [],
        appendChild(child) { this.children.push(child); child.parent = this; },
        replaceChildren() { this.children = []; }
    };
    const createElement = () => ({
        style: {}, textContent: '',
        get offsetWidth() { return [...this.textContent].length * 20; },
        animate(keyframes, options) { this.animation = { keyframes, options }; return this.animation; },
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    });
    const win = {
        document: { hidden, createElement },
        performance: { now: () => now },
        setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
        clearTimeout() {}
    };
    return { layer, overlay: new DanmakuOverlay(layer, win), timeouts, advance: ms => { now += ms; } };
}

test('comments fill free lanes top-down, scroll at one speed and wait for a lane when all are busy', () => {
    const h = overlayHarness();
    for (let i = 0; i < 10; i++) h.overlay.add(`c${i}`);
    // 450 px tall: 23 px text, 35 px lanes, 9 lanes in the top three quarters.
    assert.equal(h.layer.children.length, 9);
    assert.deepEqual(h.layer.children.map(c => c.style.top), [0, 35, 70, 105, 140, 175, 210, 245, 280].map(y => `${y}px`));
    const first = h.layer.children[0];
    assert.equal(first.style.fontSize, '23px');
    assert.deepEqual(first.animation.keyframes, [{ transform: 'translateX(800px)' }, { transform: 'translateX(-40px)' }]);
    assert.equal(first.animation.options.duration, 8400);
    assert.equal(h.timeouts.length, 1);

    h.advance(700);
    h.timeouts.shift().fn();
    assert.equal(h.layer.children.length, 9, 'a lane frees only once its comment and the gap have entered');
    h.advance(100);
    h.timeouts.shift().fn();
    assert.equal(h.layer.children.length, 10);
    assert.deepEqual(h.layer.children.slice(9).map(c => [c.textContent, c.style.top]), [['c9', '0px']]);
    first.animation.onfinish();
    assert.equal(h.layer.children.includes(first), false);
});

test('the overlay trims long comments, drops stale backlog and stays idle while hidden', () => {
    const h = overlayHarness({ height: 40 });
    h.overlay.add('长'.repeat(80));
    assert.equal(h.layer.children[0].textContent, '长'.repeat(50) + '…');
    for (let i = 0; i < 60; i++) h.overlay.add(`q${i}`);
    assert.equal(h.overlay.queue.length, 40);
    assert.equal(h.overlay.queue[0], 'q20');
    h.overlay.clear();
    assert.equal(h.layer.children.length, 0);
    assert.equal(h.overlay.queue.length, 0);

    const hidden = overlayHarness({ hidden: true });
    hidden.overlay.add('看不见');
    assert.equal(hidden.layer.children.length, 0);
    const collapsed = overlayHarness({ width: 0, height: 0 });
    collapsed.overlay.add('没有尺寸');
    assert.equal(collapsed.overlay.queue.length, 0);
});
