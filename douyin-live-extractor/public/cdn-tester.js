/* Browser-side FLV arrival measurements. No video proxy or third-party timing service. */
globalThis.CdnTester = (() => {
    const MAX_LINES = 5;
    const abortError = () => new DOMException('测速已取消', 'AbortError');
    const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
    };
    function streamUrl(value) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请提供 HTTP(S) 播放地址');
        if (globalThis.location?.protocol === 'https:' && url.protocol === 'http:') throw new Error('HTTPS 页面无法测量 HTTP 线路，请提供有效的 HTTPS 地址');
        url.hash = '';
        return url.href;
    }
    const endpointKey = value => { const url = new URL(value); return url.host + url.pathname; };
    const networkError = err => err instanceof TypeError ? '无法读取线路：网络或跨域访问受限' : err.message;

    async function discover(source, extras, signal, onUpdate = () => {}) {
        const nodes = [], failures = [], seen = new Set();
        let repeats = 0;
        // Explicit alternatives are checked before repeating the dispatcher. Never invent hosts or signatures.
        const attempts = [source, ...extras.slice(0, MAX_LINES), ...Array(7).fill(source)];
        for (let index = 0; index < attempts.length && nodes.length < MAX_LINES; index++) {
            if (signal.aborted) throw abortError();
            if (index > extras.length && repeats >= 3) break;
            const controller = new AbortController();
            const cancel = () => controller.abort();
            signal.addEventListener('abort', cancel, { once: true });
            const timeout = setTimeout(cancel, 15000);
            let reader;
            try {
                const url = streamUrl(attempts[index]);
                const response = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
                if (!response.ok || !response.body) throw new Error(`线路返回 HTTP ${response.status}`);
                reader = response.body.getReader();
                const signature = [];
                while (signature.length < 3) {
                    const { value, done } = await reader.read();
                    if (done) throw new Error('线路未返回视频数据');
                    signature.push(...value.subarray(0, 3 - signature.length));
                }
                if (String.fromCharCode(...signature) !== 'FLV') throw new Error('该地址没有返回 FLV 视频');
                const resolved = streamUrl(response.url || url);
                const key = endpointKey(resolved);
                if (!seen.has(key)) {
                    seen.add(key);
                    nodes.push({ url: resolved, host: new URL(resolved).host });
                    repeats = 0;
                } else if (index > extras.length) repeats++;
            } catch (err) {
                if (signal.aborted) throw abortError();
                failures.push({ url: attempts[index], error: controller.signal.aborted ? '连接超时' : networkError(err) });
                // A slow first response is not evidence of old pictures. Give it a full loading trial.
                if (controller.signal.aborted) {
                    const url = streamUrl(attempts[index]);
                    if (!seen.has(endpointKey(url))) {
                        seen.add(endpointKey(url));
                        nodes.push({ url, host: new URL(url).host, pending: true });
                    }
                }
                if (index > extras.length) repeats++;
            } finally {
                controller.abort();
                await reader?.cancel().catch(() => {});
                clearTimeout(timeout);
                signal.removeEventListener('abort', cancel);
            }
            onUpdate({ phase: 'discover', nodes, failures, attempt: index + 1 });
        }
        return { nodes, failures };
    }

    class FlvParser {
        constructor(onFrame) { this.onFrame = onFrame; this.pending = new Uint8Array(); this.headerRead = false; }
        push(chunk, at) {
            const bytes = new Uint8Array(this.pending.length + chunk.length);
            bytes.set(this.pending); bytes.set(chunk, this.pending.length);
            if (bytes.length > 16 * 1024 * 1024) throw new Error('视频数据缓冲超过测速上限');
            let offset = 0;
            if (!this.headerRead) {
                if (bytes.length < 13) { this.pending = bytes; return; }
                if (bytes[0] !== 70 || bytes[1] !== 76 || bytes[2] !== 86) throw new Error('非 FLV 视频数据');
                offset = new DataView(bytes.buffer).getUint32(5) + 4;
                if (offset > 1024 * 1024) throw new Error('无效的 FLV 文件头');
                if (bytes.length < offset) { this.pending = bytes; return; }
                this.headerRead = true;
            }
            const read24 = i => bytes[i] * 65536 + bytes[i + 1] * 256 + bytes[i + 2];
            while (bytes.length - offset >= 15) {
                const size = read24(offset + 1), end = offset + 11 + size;
                if (size > 8 * 1024 * 1024) throw new Error('视频帧超过测速上限');
                if (end + 4 > bytes.length) break;
                if (bytes[offset] === 9 && size >= 5) {
                    const payload = bytes.subarray(offset + 11, end);
                    if ((payload[0] & 15) !== 7) throw new Error('目前同帧测速仅支持 H.264 FLV，请更换画质或线路');
                    if (payload[1] === 1) {
                        const dts = (read24(offset + 4) + bytes[offset + 7] * 0x1000000) >>> 0;
                        const raw = payload[2] * 65536 + payload[3] * 256 + payload[4];
                        const pts = dts + (raw & 0x800000 ? raw - 0x1000000 : raw);
                        this.onFrame({ dts, pts, at, payload });
                    }
                }
                offset = end + 4;
            }
            this.pending = bytes.slice(offset);
        }
    }

    function warmupReady(samples, now) {
        const recent = samples.filter(s => now - s.at <= 8500);
        if (recent.length < 17 || recent.at(-1).at - recent[0].at < 8000) return false;
        const first = recent[0], last = recent.at(-1);
        const rate = (last.pts - first.pts) / (last.at - first.at);
        const offsets = recent.map(s => s.at - s.pts);
        return rate >= 0.95 && rate <= 1.05 && Math.max(...offsets) - Math.min(...offsets) <= 450 &&
            Math.abs(offsets.at(-1) - offsets[0]) <= 200;
    }

    function aligned(states) {
        if (states.length < 2) return false;
        const reached = new Set([states[0]]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const a of reached) for (const b of states) {
                if (reached.has(b)) continue;
                const ah = a.history || a.frames, bh = b.history || b.frames;
                let matches = 0;
                for (const key of ah.keys()) if (bh.has(key) && ++matches >= 30) break;
                if (matches >= 30) { reached.add(b); changed = true; }
            }
        }
        return reached.size === states.length;
    }

    function summarize(states, start, end) {
        const rows = states.map(s => ({ url: s.url, host: s.host, error: s.error || null, eligible: false,
            loadMs: s.loadMs ?? null, chases: s.chases || 0, reconnects: s.reconnects || 0, bufferGapMs: s.bufferGapMs ?? null }));
        const inWindow = frame => frame && frame.at >= start && frame.at <= end;
        const eligible = states.filter(s => !s.error && [...s.frames.values()].some(inWindow));
        if (!aligned(eligible)) {
            for (const row of rows) row.error ||= '时间轴未判定：可能领先或落后较多，也可能不是同一码流';
            return { rows, best: null, matchedFrames: 0, error: '未确认所有可用线路的共同时间轴，不推荐“最新线路”' };
        }
        const keys = [...eligible[0].frames.keys()].filter(key => inWindow(eligible[0].frames.get(key)));
        const common = keys.filter(key => eligible.every(s => inWindow(s.frames.get(key))));
        const latest = Math.max(...eligible.map(s => Math.max(...[...s.frames.values()].filter(inWindow).map(f => f.pts))));
        for (const s of eligible) {
            const row = rows[states.indexOf(s)];
            const delays = common.map(key => s.frames.get(key).at - Math.min(...eligible.map(peer => peer.frames.get(key).at)));
            row.eligible = true;
            row.arrivalLagMs = common.length >= 30 ? median(delays) : null;
            row.pictureLagMs = latest - Math.max(...[...s.frames.values()].filter(inWindow).map(f => f.pts));
        }
        const ranked = rows.filter(r => r.eligible).sort((a, b) => a.pictureLagMs - b.pictureLagMs || (a.arrivalLagMs ?? Infinity) - (b.arrivalLagMs ?? Infinity));
        const incomplete = rows.some(r => !r.eligible);
        return { rows, best: incomplete ? null : ranked[0], matchedFrames: common.length,
            error: incomplete ? '部分候选仍未判定；可手动使用已验证线路，暂不推荐全部候选中的最新线路' : null };
    }

    function bufferGap(video) {
        if (!video.buffered.length || video.readyState < 2) return null;
        return Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
    }

    function chase(video) {
        if (!video.buffered.length || video.readyState < 2 || video.seeking) return false;
        const last = video.buffered.length - 1;
        video.currentTime = Math.max(video.buffered.start(last), video.buffered.end(last) - 0.35);
        return true;
    }

    async function measure(nodes, signal, onUpdate = () => {}, previews = document.body) {
        if (!globalThis.crypto?.subtle) throw new Error('同帧测速需要 HTTPS 或 localhost 页面');
        if (!globalThis.flvjs?.isSupported()) throw new Error('当前浏览器不支持 FLV 试播追帧');
        if (nodes.length < 2) throw new Error('至少需要两条不同线路');
        if (signal.aborted) throw abortError();
        const states = nodes.slice(0, MAX_LINES).map(n => ({ ...n, frames: new Map(), history: new Map(), hashes: new Set(),
            generation: 0, reconnects: 0, chases: 0, error: null, loadMs: null }));
        const began = performance.now(), networkTasks = new Set();
        let start = null, end = null, stopping = false, stopMessage = null, alignmentSince = null;
        let finish;
        const finished = new Promise(resolve => { finish = resolve; });
        const retire = s => {
            s.generation++;
            s.player?.destroy(); s.player = null;
            if (s.video) { s.video.onloadeddata = null; s.video.pause(); s.video.removeAttribute('src'); s.video.load(); }
            s.figure?.remove(); s.figure = null;
        };
        const fail = (s, message) => { s.error = message; s.stage = '未判定'; retire(s); };
        const stop = message => {
            if (stopping) return;
            stopping = true; end = performance.now(); stopMessage = message;
            for (const s of states) { s.finalGeneration = s.generation; retire(s); }
            finish();
        };
        const cancel = () => stop('测速已取消');
        signal.addEventListener('abort', cancel, { once: true });

        function launch(s) {
            retire(s);
            const generation = s.generation;
            const current = () => !stopping && s.generation === generation;
            Object.assign(s, { latestPts: null, snapshots: [], ready: false, problem: null, firstImageAt: null,
                openedAt: performance.now(), chaseAt: null, attemptChases: 0, stage: s.reconnects ? '重连加载' : '加载首帧' });
            s.video = document.createElement('video');
            s.video.muted = true; s.video.playsInline = true;
            s.figure = document.createElement('figure');
            const caption = document.createElement('figcaption'); caption.textContent = s.host;
            s.figure.appendChild(s.video); s.figure.appendChild(caption); previews.appendChild(s.figure);
            s.video.onloadeddata = () => {
                if (!current() || s.firstImageAt !== null) return;
                s.firstImageAt = performance.now();
                s.loadMs ??= s.firstImageAt - s.openedAt;
            };
            const parser = new FlvParser(frame => {
                if (!current()) return;
                s.latestPts = s.latestPts === null ? frame.pts : Math.max(s.latestPts, frame.pts);
                if (s.hashes.size >= 128) throw new Error('设备处理速度不足，请降低画质');
                // Keep only compact fingerprints across startup/reconnects, so a far-ahead stream can be aligned later.
                const task = crypto.subtle.digest('SHA-256', frame.payload).then(digest => {
                    if (!current() && !(stopping && s.finalGeneration === generation)) return;
                    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                    const key = frame.dts + ':' + hash;
                    s.history.set(key, { pts: frame.pts, at: frame.at });
                    if (s.history.size > 7200) s.history.delete(s.history.keys().next().value);
                    if (start !== null && frame.at >= start) s.frames.set(key, { at: frame.at, pts: frame.pts });
                }).catch(() => { if (current()) s.problem = '无法校验视频帧'; }).finally(() => s.hashes.delete(task));
                s.hashes.add(task);
            });
            // flv.js and the timestamp observer consume the SAME fetch connection.
            class ProbeLoader extends flvjs.BaseLoader {
                constructor() { super('cdn-probe'); this._needStash = false; this.controller = new AbortController(); }
                open(dataSource) {
                    this._status = 1;
                    const task = this.read(dataSource).finally(() => networkTasks.delete(task));
                    networkTasks.add(task);
                }
                async read(dataSource) {
                    let reader, total = 0;
                    try {
                        const response = await fetch(streamUrl(dataSource.url), { signal: this.controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
                        if (!response.ok || !response.body) throw new Error(`线路返回 HTTP ${response.status}`);
                        if (!current() || this.controller.signal.aborted) { await response.body.cancel(); return; }
                        s.url = streamUrl(response.url || dataSource.url); s.host = new URL(s.url).host;
                        if (states.some(peer => peer !== s && peer.player && !peer.error && endpointKey(peer.url) === endpointKey(s.url))) throw new Error('跳转到重复线路');
                        caption.textContent = s.host;
                        reader = response.body.getReader(); this._status = 2;
                        while (current() && !this.controller.signal.aborted) {
                            const { value, done } = await reader.read();
                            if (!current() || this.controller.signal.aborted) break;
                            if (done) throw new Error('线路已结束或中断');
                            parser.push(value, performance.now());
                            const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                            this._onDataArrival?.(chunk, total, total + value.byteLength); total += value.byteLength;
                        }
                    } catch (err) {
                        if (current() && !this.controller.signal.aborted) { this._status = 3; s.problem = networkError(err); }
                    } finally {
                        this.controller.abort(); await reader?.cancel().catch(() => {}); parser.pending = new Uint8Array();
                    }
                }
                abort() { this.controller.abort(); this._status = 4; }
                destroy() { this.abort(); super.destroy(); }
            }
            s.player = flvjs.createPlayer({ type: 'flv', url: s.url, isLive: true }, {
                customLoader: ProbeLoader, enableWorker: false, enableStashBuffer: false, lazyLoad: false,
                autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10
            });
            s.player.on(flvjs.Events.ERROR, () => { if (current()) s.problem = '试播连接或解码失败'; });
            s.player.attachMediaElement(s.video); s.player.load();
            s.video.play().catch(err => { if (current() && err.name !== 'AbortError') s.problem = '无法开始试播'; });
        }
        const retry = (s, reason) => {
            if (s.reconnects < 1 && start === null) { s.reconnects++; launch(s); alignmentSince = null; }
            else fail(s, `${reason}；未判定画面新鲜度`);
        };

        let timer;
        try {
            for (const s of states) launch(s);
            timer = setInterval(() => {
                if (stopping) return;
                const now = performance.now();
                for (const s of states) {
                    if (s.error) continue;
                    if (s.problem) { retry(s, s.problem); continue; }
                    const gap = bufferGap(s.video); s.bufferGapMs = gap === null ? null : gap * 1000;
                    if (s.firstImageAt === null) {
                        if (now - s.openedAt >= 20000) retry(s, '首帧加载超时');
                        continue;
                    }
                    if (s.chaseAt === null || (gap !== null && gap > 1 && now - s.chaseAt >= 2000)) {
                        if (s.attemptChases >= 3) { retry(s, '追帧后仍有积压'); continue; }
                        if (chase(s.video)) {
                            s.chases++; s.attemptChases++; s.chaseAt = now; s.snapshots = []; s.ready = false; s.stage = '追帧后观察';
                        }
                        continue;
                    }
                    if (s.latestPts !== null) s.snapshots.push({ at: now, pts: s.latestPts, media: s.video.currentTime });
                    s.snapshots = s.snapshots.filter(x => now - x.at <= 9000);
                    const mediaProgress = s.snapshots.length > 1 ? s.snapshots.at(-1).media - s.snapshots[0].media : 0;
                    s.ready = gap !== null && gap <= 0.8 && !s.video.paused && !s.video.seeking && mediaProgress >= 6 && warmupReady(s.snapshots, now);
                    if (s.ready) s.stage = '追帧就绪';
                    if (!s.ready && now - s.openedAt >= 40000) retry(s, '未确认追帧完成');
                }
                const active = states.filter(s => !s.error);
                let phase = 'prepare';
                if (active.length < 2) stop('可比较线路不足两条，其余线路仍未判定');
                else if (start === null && active.every(s => s.ready)) {
                    const verified = aligned(active);
                    const latest = Math.max(...active.map(s => s.latestPts));
                    const lagging = verified ? active.filter(s => s.reconnects === 0 && latest - s.latestPts > 1000) : [];
                    if (lagging.length) for (const s of lagging) retry(s, '尝试重连以消除当前连接积压');
                    else {
                        alignmentSince ??= now; phase = 'align';
                        if (verified || now - alignmentSince >= 30000) { start = now; for (const s of states) s.frames.clear(); }
                    }
                }
                if (start !== null) {
                    phase = 'measure';
                    if (now - start >= 12000) {
                        for (const s of active) if (bufferGap(s.video) === null || bufferGap(s.video) > 0.8 || s.video.seeking || s.video.paused) fail(s, '结束时播放器未追平，未判定');
                        stop(null);
                    }
                } else if (now - began >= 100000) stop('加载、追帧或时间轴校验未完成；不能判断全部候选中谁最新');
                onUpdate({ phase, elapsed: (now - began) / 1000, remaining: start === null ? null : Math.max(0, Math.ceil((12000 - now + start) / 1000)),
                    nodes: states.map(s => ({ url: s.url, host: s.host, error: s.error, ready: s.ready, stage: s.stage, loadMs: s.loadMs, chases: s.chases, reconnects: s.reconnects })) });
            }, 500);
            await finished;
            await Promise.allSettled([...networkTasks]);
            await Promise.allSettled(states.flatMap(s => [...s.hashes]));
            if (signal.aborted) throw abortError();
            if (start === null || stopMessage) return { rows: states.map(s => ({ url: s.url, host: s.host, eligible: false, error: s.error || stopMessage, loadMs: s.loadMs, chases: s.chases, reconnects: s.reconnects })), best: null, matchedFrames: 0, error: stopMessage };
            return { ...summarize(states, start, end), measuredAt: new Date().toISOString(), warmupSeconds: (start - began) / 1000 };
        } finally {
            clearInterval(timer); stop(null); signal.removeEventListener('abort', cancel);
            await Promise.allSettled([...networkTasks]);
            for (const s of states) { s.frames.clear(); s.history.clear(); s.snapshots = []; }
        }
    }

    return { discover, measure, FlvParser, warmupReady, summarize, aligned, chase, streamUrl, endpointKey };
})();
