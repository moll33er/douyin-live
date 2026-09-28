/* Live comments (danmaku) for a Douyin room, received by the viewer's browser and scrolled over the player.
   Douyin pushes room messages over a websocket that needs a `signature` from its web SDK (computed in
   danmaku-worker.js) and a `ttwid` cookie for douyin.com. Browsers that keep that cookie from Douyin get the same
   websocket through the site's server instead (danmaku-relay.js). Frames are protobuf with gzip payloads; field
   numbers follow douyin.proto from saermart/DouyinLiveWebFetcher. Only chats are shown: anonymous viewers
   get masked nicknames and no gift messages. */

const PUSH_URL = 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/';
const DEVICE_ID = '7319483754668557238';
const BROWSER_VERSION = '5.0%20(Windows%20NT%2010.0;%20Win64;%20x64)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/126.0.0.0%20Safari/537.36';
// The signature covers these parameters, in this order.
const SIGNED_PARAMS = ['live_id', 'aid', 'version_code', 'webcast_sdk_version', 'room_id', 'sub_room_id', 'sub_channel_id',
    'did_rule', 'user_unique_id', 'device_platform', 'device_type', 'ac', 'identity'];
const HEARTBEAT_MS = 5000;
// Chats already this old when they arrive are the backlog Douyin replays to a new connection.
const BACKLOG_MS = 10000;
const SIGN_TIMEOUT_MS = 15000;
const SEEN_LIMIT = 2000;
const BLOCKED_TEXT = '弹幕连接被抖音拒绝。浏览器可能屏蔽了第三方 Cookie（如无痕模式、Safari），也可能是抖音更新了接口；允许 douyin.com 的 Cookie 后重新勾选“弹幕”重试。';
const RELAY_TEXT = '浏览器没有把 Cookie 发给抖音（Safari、iPhone/iPad 上的浏览器和无痕模式常见），改由本站服务器中转弹幕…';
const RELAY_FAILED_TEXT = '弹幕连接失败：浏览器直连和本站服务器中转都被拒绝。可能是抖音更新了接口或登录已过期，稍后重新勾选“弹幕”重试。';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = bytes => bytes ? decoder.decode(bytes) : '';

export function pushAddress(roomId, now = Date.now()) {
    if (!/^\d+$/.test(String(roomId))) throw new Error('房间 ID 无效');
    const params = [
        ['app_name', 'douyin_web'], ['version_code', '180800'], ['webcast_sdk_version', '1.0.14-beta.0'],
        ['update_version_code', '1.0.14-beta.0'], ['compress', 'gzip'], ['device_platform', 'web'], ['cookie_enabled', 'true'],
        ['screen_width', '1536'], ['screen_height', '864'], ['browser_language', 'zh-CN'], ['browser_platform', 'Win32'],
        ['browser_name', 'Mozilla'], ['browser_version', BROWSER_VERSION], ['browser_online', 'true'], ['tz_name', 'Asia/Shanghai'],
        ['cursor', `d-1_u-1_fh-7392091211001140287_t-${now}_r-1`],
        ['internal_ext', `internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${DEVICE_ID}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:7392094459690748497`],
        ['host', 'https://live.douyin.com'], ['aid', '6383'], ['live_id', '1'], ['did_rule', '3'], ['endpoint', 'live_pc'],
        ['support_wrds', '1'], ['user_unique_id', DEVICE_ID], ['im_path', '/webcast/im/fetch/'], ['identity', 'audience'],
        ['need_persist_msg_count', '15'], ['insert_task_id', ''], ['live_reason', ''], ['room_id', String(roomId)], ['heartbeatDuration', '0']
    ];
    const values = new Map(params);
    return {
        url: `${PUSH_URL}?${params.map(([key, value]) => `${key}=${value}`).join('&')}`,
        signInput: SIGNED_PARAMS.map(key => `${key}=${values.get(key) ?? ''}`).join(',')
    };
}

// The relay at `base` rebuilds the push address itself; it only needs the room and the signature for it.
export function relayAddress(base, roomId, signature) {
    const url = new URL(base);
    url.searchParams.set('room_id', roomId);
    url.searchParams.set('signature', signature);
    return url.href;
}

// --- Protobuf ---

function readVarint(bytes, pos) {
    let value = 0n, shift = 0n, byte;
    do {
        if (pos >= bytes.length) throw new Error('protobuf 数据不完整');
        byte = bytes[pos++];
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
    } while (byte & 0x80);
    return [value, pos];
}

// Field number → values: varints as BigInt, length-delimited fields as bytes. Fixed-width fields are skipped.
export function decodeFields(bytes) {
    const fields = {};
    let pos = 0;
    while (pos < bytes.length) {
        let key, value;
        [key, pos] = readVarint(bytes, pos);
        const type = Number(key & 7n);
        if (type === 0) {
            [value, pos] = readVarint(bytes, pos);
        } else if (type === 2) {
            let length;
            [length, pos] = readVarint(bytes, pos);
            const end = pos + Number(length);
            if (end > bytes.length) throw new Error('protobuf 数据不完整');
            value = bytes.subarray(pos, end);
            pos = end;
        } else if (type === 1 || type === 5) {
            pos += type === 1 ? 8 : 4;
            continue;
        } else {
            throw new Error(`不支持的 protobuf 字段类型 ${type}`);
        }
        (fields[Number(key >> 3n)] ??= []).push(value);
    }
    return fields;
}

function varintBytes(value) {
    let rest = BigInt(value);
    const out = [];
    do {
        const low = Number(rest & 0x7fn);
        rest >>= 7n;
        out.push(rest ? low | 0x80 : low);
    } while (rest);
    return out;
}

// PushFrame { logId = 2; payloadType = 7; payload = 8 }
export function encodeFrame({ logId, payloadType, payload }) {
    const out = [];
    const bytesField = (number, bytes) => out.push(...varintBytes(number << 3 | 2), ...varintBytes(bytes.length), ...bytes);
    if (logId !== undefined) out.push(...varintBytes(2 << 3), ...varintBytes(logId));
    bytesField(7, encoder.encode(payloadType));
    if (payload) bytesField(8, payload);
    return new Uint8Array(out);
}

const HEARTBEAT = encodeFrame({ payloadType: 'hb' });

async function gunzip(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A PushFrame; 'msg' frames carry a gzip Response { messages = 1; internalExt = 5; now = 4; needAck = 9 }.
export async function readFrame(data) {
    const frame = decodeFields(new Uint8Array(data));
    const result = { type: text(frame[7]?.[0]), logId: frame[2]?.[0] ?? 0n, messages: [] };
    if (result.type !== 'msg' || !frame[8]) return result;
    const response = decodeFields(await gunzip(frame[8][0]));
    result.now = Number(response[4]?.[0] ?? 0n);
    result.needAck = !!response[9]?.[0];
    result.internalExt = response[5]?.[0] ?? new Uint8Array();
    // Message { method = 1; payload = 2; msgId = 3 }
    result.messages = (response[1] || []).map(raw => {
        const message = decodeFields(raw);
        return { method: text(message[1]?.[0]), payload: message[2]?.[0] ?? new Uint8Array(), id: String(message[3]?.[0] ?? '') };
    });
    return result;
}

// ChatMessage { common = 1; user = 2; content = 3; eventTime = 15 (seconds) } and
// EmojiChatMessage { common = 1; user = 2; defaultContent = 5 }; Common { msgId = 2; createTime = 4 }, User { nickName = 3 }.
export function readChat(message) {
    const chat = decodeFields(message.payload);
    const common = chat[1] ? decodeFields(chat[1][0]) : {};
    const user = chat[2] ? decodeFields(chat[2][0]) : {};
    const created = Number(chat[15]?.[0] ?? common[4]?.[0] ?? 0n);
    return {
        id: String(common[2]?.[0] ?? message.id),
        content: text(chat[message.method === 'WebcastEmojiChatMessage' ? 5 : 3]?.[0]).trim(),
        nickname: text(user[3]?.[0]),
        createdAt: created && created < 1e12 ? created * 1000 : created
    };
}

// --- Connection ---

let signer = null;

function createSigner() {
    const worker = new Worker(new URL('./danmaku-worker.js', import.meta.url));
    const pending = new Map();
    let nextId = 0;
    const settle = (id, err, signature) => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimeout(request.timer);
        if (err) request.reject(err);
        else request.resolve(signature);
    };
    worker.onmessage = ({ data }) => settle(data.id, data.error ? new Error(data.error) : null, data.signature);
    worker.onerror = event => {
        event.preventDefault?.();
        if (signer === sign) signer = null;
        worker.terminate();
        for (const id of [...pending.keys()]) settle(id, new Error(event.message || '签名脚本加载失败'));
    };
    const sign = input => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject, timer: setTimeout(() => settle(id, new Error('签名超时')), SIGN_TIMEOUT_MS) });
        worker.postMessage({ id, input });
    });
    return sign;
}

export function signInWorker(input) {
    signer ??= createSigner();
    return signer(input);
}

function sleep(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

// Once the browser proves unable to connect directly, later rooms on this page go straight to the relay.
const memory = { directRefused: false };

const defaultEnv = () => ({
    WebSocket: globalThis.WebSocket,
    fetch: (...args) => globalThis.fetch(...args),
    sign: signInWorker,
    sleep,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: id => globalThis.clearInterval(id),
    now: () => Date.now(),
    memory
});

// One websocket connection, directly to Douyin or through the relay at `relay`; resolves when it closes.
async function session(roomId, env, relay, seen, onComment, onStatus, signal) {
    const { url, signInput } = pushAddress(roomId, env.now());
    const signature = await env.sign(signInput);
    if (signal.aborted) return { opened: false };
    return new Promise(resolve => {
        const ws = new env.WebSocket(relay ? relayAddress(relay, roomId, signature) : `${url}&signature=${encodeURIComponent(signature)}`);
        ws.binaryType = 'arraybuffer';
        let openedAt = null, ended = false, heartbeat = null, queue = Promise.resolve();
        const close = () => { try { ws.close(); } catch (err) { /* Already closed. */ } };
        const send = bytes => { if (ws.readyState === 1) ws.send(bytes); };
        signal.addEventListener('abort', close, { once: true });

        async function handle(data) {
            const frame = await readFrame(data);
            if (frame.type !== 'msg' || signal.aborted) return;
            if (frame.needAck) send(encodeFrame({ logId: frame.logId, payloadType: 'ack', payload: frame.internalExt }));
            for (const message of frame.messages) {
                if (message.method === 'WebcastChatMessage' || message.method === 'WebcastEmojiChatMessage') {
                    const chat = readChat(message);
                    // Douyin repeats messages across frames and reconnections.
                    if (seen.has(chat.id)) continue;
                    seen.add(chat.id);
                    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
                    if (chat.content && !(frame.now && chat.createdAt && frame.now - chat.createdAt > BACKLOG_MS)) onComment(chat);
                } else if (message.method === 'WebcastControlMessage' && Number(decodeFields(message.payload)[2]?.[0] ?? 0n) === 3) {
                    ended = true;
                    close();
                }
            }
        }

        ws.onopen = () => {
            openedAt = env.now();
            onStatus(relay ? '弹幕已连接（经本站服务器中转）。' : '弹幕已连接。');
            heartbeat = env.setInterval(() => send(HEARTBEAT), HEARTBEAT_MS);
        };
        ws.onmessage = ({ data }) => { queue = queue.then(() => handle(data)).catch(() => {}); };
        ws.onerror = () => {}; // A close event follows.
        ws.onclose = () => {
            env.clearInterval(heartbeat);
            signal.removeEventListener('abort', close);
            queue.then(() => resolve({ opened: openedAt !== null, ended, lasted: openedAt === null ? 0 : env.now() - openedAt }));
        };
    });
}

// Keeps the room's danmaku flowing until `signal` aborts, the live ends or Douyin keeps refusing the connection.
// `relay` is the websocket address of the site's relay, used when the browser cannot connect to Douyin itself.
export async function connect(roomId, { onComment, onStatus = () => {}, signal, relay = null }, overrides = {}) {
    const env = { ...defaultEnv(), ...overrides };
    const seen = new Set();
    const status = message => { if (!signal.aborted) onStatus(message); };
    let viaRelay = !!relay && env.memory.directRefused;
    let primed = false, directOpened = false, refused = 0, retries = 0;
    status('弹幕连接中…');
    while (!signal.aborted) {
        let result;
        try {
            result = await session(roomId, env, viaRelay ? relay : null, seen, comment => { if (!signal.aborted) onComment(comment); }, status, signal);
        } catch (err) {
            status(`弹幕加载失败（${err.message}）。`);
            return;
        }
        if (signal.aborted) return;
        if (result.ended) {
            status('直播已结束，弹幕已停止。');
            return;
        }
        if (!result.opened) {
            // A refused handshake usually means the browser has no ttwid cookie yet; any Douyin page sets one.
            if (!viaRelay && !primed) {
                primed = true;
                status('正在向抖音获取访客 Cookie…');
                await env.fetch('https://live.douyin.com/', { mode: 'no-cors', credentials: 'include', cache: 'no-store', signal }).catch(() => {});
                continue;
            }
            // Still refused right after Douyin set the cookie: the browser keeps it from Douyin's websocket.
            if (!viaRelay && relay && !directOpened) {
                env.memory.directRefused = viaRelay = true;
                status(RELAY_TEXT);
                continue;
            }
            if (++refused >= 2) {
                status(viaRelay ? RELAY_FAILED_TEXT : BLOCKED_TEXT);
                return;
            }
        } else {
            refused = 0;
            directOpened ||= !viaRelay;
        }
        retries = result.lasted >= 30000 ? 0 : retries + 1;
        const delay = Math.min(60000, 1000 * 2 ** retries);
        status(`弹幕连接中断，${Math.round(delay / 1000)} 秒后重连…`);
        await env.sleep(delay, signal);
        status('弹幕重新连接中…');
    }
}

// --- Overlay ---

const CROSS_SECONDS = 8; // Time for a comment to cross the full width; every comment moves at the same speed.
const LANE_GAP_PX = 32;
const MAX_QUEUE = 40;
const MAX_CHARS = 50;

export class DanmakuOverlay {
    constructor(layer, win = globalThis) {
        this.layer = layer;
        this.win = win;
        this.queue = [];
        this.lanes = [];
        this.timer = null;
    }

    add(content) {
        if (this.win.document?.hidden) return;
        const chars = [...String(content).trim()];
        if (!chars.length) return;
        this.queue.push(chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS).join('') + '…' : chars.join(''));
        // Busy rooms outpace the screen; stale comments are dropped rather than shown late.
        if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
        this.pump();
    }

    pump() {
        const width = this.layer.clientWidth, height = this.layer.clientHeight;
        if (!width || !height) {
            this.queue = [];
            return;
        }
        const fontSize = Math.round(Math.min(28, Math.max(14, height / 20)));
        const laneHeight = Math.round(fontSize * 1.5);
        // The bottom quarter stays clear for the picture's own captions and the video controls.
        const laneCount = Math.max(1, Math.floor(height * 0.75 / laneHeight));
        const speed = width / CROSS_SECONDS;
        const now = this.win.performance.now();
        while (this.queue.length) {
            let lane = 0;
            while (lane < laneCount && (this.lanes[lane] ?? 0) > now) lane++;
            if (lane === laneCount) break;
            const item = this.win.document.createElement('span');
            item.className = 'danmaku-item';
            item.textContent = this.queue.shift();
            item.style.top = `${lane * laneHeight}px`;
            item.style.fontSize = `${fontSize}px`;
            item.style.transform = `translateX(${width}px)`;
            this.layer.appendChild(item);
            const itemWidth = item.offsetWidth;
            // The lane frees up once this comment has fully entered; at equal speeds the next one never catches up.
            this.lanes[lane] = now + (itemWidth + LANE_GAP_PX) / speed * 1000;
            const animation = item.animate([{ transform: `translateX(${width}px)` }, { transform: `translateX(${-itemWidth}px)` }],
                { duration: (width + itemWidth) / speed * 1000, easing: 'linear' });
            animation.onfinish = () => item.remove();
        }
        if (this.queue.length && this.timer === null) {
            this.timer = this.win.setTimeout(() => {
                this.timer = null;
                this.pump();
            }, 200);
        }
    }

    clear() {
        this.win.clearTimeout(this.timer);
        this.timer = null;
        this.queue = [];
        this.lanes = [];
        this.layer.replaceChildren();
    }
}

globalThis.DouyinDanmaku = { connect, DanmakuOverlay };
