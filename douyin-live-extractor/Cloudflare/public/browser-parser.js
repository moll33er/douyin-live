/* Parses rooms in the viewer's own browser, so Douyin dispatches lines for the viewer's network rather than
   the server's. Douyin does not let other sites read its responses, so this needs the optional userscript
   douyin-live-bridge.user.js, which fetches Douyin addresses for the page. Without it the page uses /api/live. */
import { getRoomStreams } from './douyin.js';

const BRIDGE_ATTRIBUTE = 'data-douyin-bridge';
const REQUEST_TIMEOUT_MS = 20000;
let nextId = 0;

function parseHeaders(raw) {
    const headers = new Headers();
    for (const line of String(raw || '').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        try { headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim()); } catch (err) { /* Skip headers the browser rejects. */ }
    }
    return headers;
}

export const available = (doc = globalThis.document) => !!doc?.documentElement?.hasAttribute(BRIDGE_ATTRIBUTE);

// A fetch() stand-in for douyin.js. The userscript follows redirects itself, so a manual redirect is
// reported as a single hop to the final address.
export function bridgeFetch(url, { headers = {}, redirect, signal } = {}, win = globalThis) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const id = ++nextId;
        const finish = (err, response) => {
            clearTimeout(timer);
            win.removeEventListener('message', onMessage);
            signal?.removeEventListener('abort', onAbort);
            if (err) reject(err);
            else resolve(response);
        };
        const onAbort = () => finish(signal.reason);
        const onMessage = ({ source, data }) => {
            if (source !== win || data?.type !== 'douyin-bridge-response' || data.id !== id) return;
            const { status, finalUrl } = data;
            if (data.error || !(status >= 200 && status <= 599)) return finish(new TypeError(data.error || `无效的响应状态 ${status}`));
            if (redirect === 'manual' && finalUrl && finalUrl !== url) {
                return finish(null, new Response(null, { status: 302, headers: { location: finalUrl } }));
            }
            finish(null, new Response([204, 205, 304].includes(status) ? null : data.body, { status, headers: parseHeaders(data.headers) }));
        };
        const timer = setTimeout(() => finish(new TypeError('请求超时')), REQUEST_TIMEOUT_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
        win.addEventListener('message', onMessage);
        win.postMessage({ type: 'douyin-bridge-request', id, url, headers }, win.location.origin);
    });
}

// Gives the same data as /api/live; `timeout` bounds the whole parse, which takes several requests.
export function resolve(input, { signal, timeout = 30000 } = {}, win = globalThis) {
    const limit = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    return getRoomStreams(input, (url, options) => bridgeFetch(url, { ...options, signal: limit }, win));
}

globalThis.DouyinLocalParser = { available, resolve };
