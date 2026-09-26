// ==UserScript==
// @name         抖音直播提取器 · 浏览器解析
// @namespace    https://github.com/moll33er/douyin-live
// @version      1.0.0
// @description  替抖音直播提取器网页请求抖音，让直播间在你的浏览器里解析，线路按你自己的网络分配
// @match        https://douyin-live.pages.dev/*
// @match        https://*.douyin-live.pages.dev/*
// @match        https://tk.000970.xyz/*
// @match        http://localhost:33333/*
// @connect      douyin.com
// @connect      iesdouyin.com
// @connect      amemv.com
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

/* Douyin does not let other sites read its responses, so the page (browser-parser.js) posts requests here and
   this script fetches them with the userscript manager's privileges. Only GET requests to Douyin hosts are served. */
(function () {
    'use strict';
    const DOUYIN_HOST = /(^|\.)(douyin\.com|iesdouyin\.com|amemv\.com)$/;

    window.addEventListener('message', event => {
        const request = event.data;
        if (event.source !== window || !request || request.type !== 'douyin-bridge-request') return;
        const reply = result => window.postMessage({ type: 'douyin-bridge-response', id: request.id, ...result }, location.origin);
        let url;
        try { url = new URL(request.url); } catch (err) { return reply({ error: '地址无效' }); }
        if (url.protocol !== 'https:' || !DOUYIN_HOST.test(url.hostname)) return reply({ error: '只能请求抖音的地址' });
        GM_xmlhttpRequest({
            method: 'GET',
            url: url.href,
            headers: request.headers || {},
            anonymous: true, // The viewer's own Douyin cookies are neither sent nor replaced.
            timeout: 20000,
            onload: res => reply({ status: res.status, headers: res.responseHeaders, body: res.responseText, finalUrl: res.finalUrl }),
            onerror: res => reply({ error: res?.error || '网络错误' }),
            ontimeout: () => reply({ error: '请求超时' })
        });
    });

    const mark = () => document.documentElement.setAttribute('data-douyin-bridge', '1');
    if (document.documentElement) mark();
    else document.addEventListener('DOMContentLoaded', mark, { once: true });
})();
