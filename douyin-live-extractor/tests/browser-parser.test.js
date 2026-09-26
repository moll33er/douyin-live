import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { available, bridgeFetch, resolve } from '../public/browser-parser.js';

const root = new URL('../', import.meta.url);
const userscript = readFileSync(new URL('public/douyin-live-bridge.user.js', root), 'utf8');
const SHARE = '【测试主播】正在直播，来和我一起支持Ta吧。复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/AbCdEfGh123/ 0@9.com :5pm';

function roomPage(room) {
    const state = { state: { roomStore: { roomInfo: { room } }, linkmicStore: {} } };
    return `<script>self.__pace_f.push([1,"${JSON.stringify(state).replace(/"/g, '\\"')}]\\n"])</script>`;
}
const pageRoom = {
    id_str: '777', title: '网页标题', status: 2,
    stream_url: { flv_pull_url: { SD1: 'http://pull-t5.douyincdn.com/ld.flv?expire=1' } },
    owner: { nickname: '网页主播', avatar_thumb: {} },
    has_commerce_goods: false
};
const reflowRoom = {
    id_str: '777', title: '接口标题', status: 2, owner: { web_rid: '555', nickname: '接口主播' },
    stream_url: { flv_pull_url: { SD1: 'http://pull-flv-t11.douyincdn.com/ld.flv?expire=2' } }
};

// The page and the userscript share one window: every message reaches every listener, asynchronously.
function pageWindow() {
    const listeners = new Set();
    const win = {
        location: { origin: 'https://douyin-live.pages.dev' },
        addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
        removeEventListener: (type, fn) => listeners.delete(fn),
        postMessage(data, origin) {
            assert.equal(origin, win.location.origin);
            setTimeout(() => { for (const fn of [...listeners]) fn({ source: win, data: structuredClone(data) }); });
        },
        listeners: () => listeners.size
    };
    return win;
}

// Runs the userscript in `win`; its GM_xmlhttpRequest answers with `serve(url)`, following redirects like the real one.
function installUserscript(win, serve) {
    const requests = [];
    const attributes = new Map();
    const document = { documentElement: { setAttribute: (name, value) => attributes.set(name, value), hasAttribute: name => attributes.has(name) } };
    const GM_xmlhttpRequest = details => {
        requests.push(details);
        Promise.resolve().then(() => serve(details.url)).then(res => {
            if (res.error) details.onerror({ error: res.error });
            else details.onload({ status: 200, responseHeaders: '', finalUrl: details.url, ...res });
        });
    };
    vm.runInNewContext(userscript, { window: win, location: win.location, document, URL, GM_xmlhttpRequest });
    return { document, requests };
}

test('the userscript marks the page and only fetches Douyin addresses over HTTPS', async () => {
    const win = pageWindow();
    const { document, requests } = installUserscript(win, () => ({ responseText: 'ok' }));
    assert.equal(available(document), true);
    assert.equal(available({ documentElement: { hasAttribute: () => false } }), false);
    for (const url of ['https://example.com/', 'http://live.douyin.com/1', 'https://douyin.com.example.com/', 'not a url']) {
        await assert.rejects(bridgeFetch(url, {}, win), TypeError);
    }
    assert.equal(requests.length, 0);

    const res = await bridgeFetch('https://live.douyin.com/1', { headers: { 'User-Agent': 'UA' } }, win);
    assert.equal(await res.text(), 'ok');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].anonymous, true);
    assert.deepEqual(requests[0].headers, { 'User-Agent': 'UA' });
    assert.equal(win.listeners(), 1, 'only the userscript keeps listening');
});

test('bridge responses behave like fetch for the parser', async () => {
    const win = pageWindow();
    installUserscript(win, url => url.startsWith('https://v.douyin.com/')
        ? { finalUrl: 'https://webcast.amemv.com/douyin/webcast/reflow/777', responseText: '<html>' }
        : { status: 404, responseHeaders: 'Content-Type: text/plain\r\nBad Header: 1\r\n', responseText: 'missing' });
    const missing = await bridgeFetch('https://live.douyin.com/1', {}, win);
    assert.equal(missing.status, 404);
    assert.equal(missing.ok, false);
    assert.equal(missing.headers.get('content-type'), 'text/plain');
    assert.equal(await missing.text(), 'missing');
    // The userscript already followed the short link, so a manual redirect becomes one hop to where it ended.
    const hop = await bridgeFetch('https://v.douyin.com/x/', { redirect: 'manual' }, win);
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get('location'), 'https://webcast.amemv.com/douyin/webcast/reflow/777');
    assert.equal(await (await bridgeFetch('https://v.douyin.com/x/', {}, win)).text(), '<html>');
});

test('network errors reject and cancelled requests stop listening', async () => {
    const win = pageWindow();
    installUserscript(win, url => url.endsWith('/down') ? { error: 'Refused to connect' } : new Promise(() => {}));
    await assert.rejects(bridgeFetch('https://live.douyin.com/down', {}, win), { name: 'TypeError', message: 'Refused to connect' });
    const controller = new AbortController();
    const pending = bridgeFetch('https://live.douyin.com/slow', { signal: controller.signal }, win);
    await new Promise(done => setTimeout(done, 10));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(win.listeners(), 1);
});

test('a whole share text is parsed through the userscript', async () => {
    const win = pageWindow();
    const { requests } = installUserscript(win, url => {
        const { hostname } = new URL(url);
        if (hostname === 'v.douyin.com') return { finalUrl: 'https://webcast.amemv.com/douyin/webcast/reflow/777?u_code=x', responseText: '<html>' };
        if (hostname === 'webcast.amemv.com') return { responseHeaders: 'Content-Type: application/json\r\n', responseText: JSON.stringify({ data: { room: reflowRoom } }) };
        if (hostname === 'live.douyin.com') return { responseText: roomPage(pageRoom) };
        return { error: `unexpected ${url}` };
    });
    const data = await resolve(SHARE, {}, win);
    assert.deepEqual(requests.map(request => new URL(request.url).hostname), ['v.douyin.com', 'webcast.amemv.com', 'live.douyin.com']);
    assert.ok(requests.every(request => request.anonymous && request.headers['User-Agent']));
    assert.equal(data.web_rid, '555');
    assert.equal(data.room_id, '777');
    assert.equal(data.anchor_name, '网页主播');
    assert.deepEqual(data.flv.SD1, {
        label: '标清 (SD)', url: 'https://pull-t5.douyincdn.com/ld.flv?expire=1',
        candidates: ['https://pull-flv-t11.douyincdn.com/ld.flv?expire=2']
    });
});

test('a stalled parse is abandoned after its time limit', async () => {
    const win = pageWindow();
    installUserscript(win, () => new Promise(() => {}));
    await assert.rejects(resolve('555', { timeout: 50 }, win), { name: 'TimeoutError' });
    assert.equal(win.listeners(), 1);
});
