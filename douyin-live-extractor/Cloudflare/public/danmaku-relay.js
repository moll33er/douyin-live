/* Server side of the danmaku relay, shared by index.js and Cloudflare's functions/api/danmaku.js. Browsers that
   block third-party cookies (Safari, every iOS browser, private windows) never send Douyin the ttwid cookie its push
   websocket requires, so danmaku.js falls back to the site's server: it signs the address as usual and the server
   opens it with a visitor cookie of its own, then passes frames through unchanged. */
import { pushAddress } from './danmaku.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COOKIE_TTL_MS = 60 * 60 * 1000;

let visitor = null;

// The Douyin push address for a relay request's `room_id` and `signature`; throws for invalid ones.
export function relayTarget(params, now = Date.now()) {
    const signature = params.get('signature') || '';
    if (!/^[\w+/=-]{8,128}$/.test(signature)) throw new Error('签名无效');
    return `${pushAddress(params.get('room_id') || '', now).url}&signature=${encodeURIComponent(signature)}`;
}

// Douyin hands out a visitor ttwid with its live homepage; one is reused for an hour.
export async function visitorCookie(fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now()) {
    if (visitor && visitor.expires > now) return visitor.value;
    const response = await fetchImpl('https://live.douyin.com/', { headers: { 'User-Agent': USER_AGENT } });
    response.body?.cancel().catch(() => {});
    const value = response.headers.getSetCookie().map(cookie => /^ttwid=([^;]+)/.exec(cookie)?.[1]).find(Boolean);
    if (!value) throw new Error('抖音没有返回访客 Cookie');
    visitor = { value, expires: now + COOKIE_TTL_MS };
    return value;
}

// Opens `target` through `connect(url, headers)`, which resolves to an open websocket, or null when refused.
export async function openUpstream(target, connect, fetchImpl) {
    const ttwid = await visitorCookie(fetchImpl);
    const socket = await connect(target, { Cookie: `ttwid=${ttwid}`, 'User-Agent': USER_AGENT });
    // The cookie may have gone stale; the next attempt fetches a fresh one.
    if (!socket) visitor = null;
    return socket;
}

// Passes frames both ways until either side closes or fails, then closes the other side too. The Node server
// relays this way; Cloudflare's runtime passes frames through itself.
export function pipeSockets(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
        const end = () => {
            try { to.close(); } catch (err) { /* Already closed. */ }
        };
        from.addEventListener('message', event => { if (to.readyState === 1) to.send(event.data); });
        from.addEventListener('close', end);
        from.addEventListener('error', end);
    }
}
