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
            const timeout = setTimeout(cancel, 6000);
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

    function summarize(states, start, end) {
        const rows = states.map(s => ({ url: s.url, host: s.host, error: s.error || null, eligible: false }));
        const reference = states[0];
        if (reference.error) return { rows, best: null, matchedFrames: 0, error: '参考线路不可用，无法核对相同画面，请重试' };
        const inWindow = frame => frame && frame.at >= start && frame.at <= end;
        const keys = [...reference.frames.keys()].filter(key => inWindow(reference.frames.get(key)));
        const eligible = states.filter((s, i) => {
            if (s.error) return false;
            if (keys.filter(key => inWindow(s.frames.get(key))).length < 30) {
                rows[i].error = '未对齐足够的相同画面：可能为不同直播、不同画质或严重落后';
                return false;
            }
            return true;
        });
        const common = keys.filter(key => eligible.every(s => inWindow(s.frames.get(key))));
        if (eligible.length < 2 || common.length < 30) return { rows, best: null, matchedFrames: common.length, error: '没有两条线路完成足够的同帧比较，无法推荐' };
        const latest = Math.max(...eligible.map(s => Math.max(...[...s.frames.values()].filter(inWindow).map(f => f.pts))));
        for (const s of eligible) {
            const row = rows[states.indexOf(s)];
            const delays = common.map(key => s.frames.get(key).at - Math.min(...eligible.map(peer => peer.frames.get(key).at)));
            row.eligible = true;
            row.arrivalLagMs = median(delays);
            row.pictureLagMs = latest - Math.max(...[...s.frames.values()].filter(inWindow).map(f => f.pts));
        }
        const ranked = rows.filter(r => r.eligible).sort((a, b) => a.pictureLagMs - b.pictureLagMs || a.arrivalLagMs - b.arrivalLagMs);
        return { rows, best: ranked[0], matchedFrames: common.length, error: null };
    }

    async function measure(nodes, signal, onUpdate = () => {}) {
        if (!globalThis.crypto?.subtle) throw new Error('同帧测速需要 HTTPS 或 localhost 页面');
        if (nodes.length < 2) throw new Error('至少需要两条不同线路');
        if (signal.aborted) throw abortError();
        const states = nodes.slice(0, MAX_LINES).map(n => ({ ...n, controller: new AbortController(), frames: new Map(), snapshots: [], latestPts: null, error: null, hashes: new Set(), closed: false, recordedBytes: 0 }));
        const began = performance.now();
        let start = null, end = null, readyTicks = 0, stopping = false, stopMessage = null;
        const fail = (s, message) => { s.error = message; s.controller.abort(); };
        const stop = message => {
            if (stopping) return;
            stopping = true; end = performance.now(); stopMessage = message;
            for (const s of states) s.controller.abort();
        };
        const cancel = () => stop('测速已取消');
        signal.addEventListener('abort', cancel, { once: true });
        const readers = states.map(async s => {
            let reader;
            const parser = new FlvParser(frame => {
                s.latestPts = s.latestPts === null ? frame.pts : Math.max(s.latestPts, frame.pts);
                if (start === null || stopping) return;
                if (s.hashes.size >= 128 || s.frames.size >= 2000 || s.recordedBytes + frame.payload.length > 32 * 1024 * 1024) throw new Error('设备处理或数据量超过测速上限，请降低画质');
                s.recordedBytes += frame.payload.length;
                // Timestamp before hashing; hashing never blocks reads from the network.
                const task = crypto.subtle.digest('SHA-256', frame.payload).then(digest => {
                    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                    const key = frame.dts + ':' + hash;
                    if (!s.frames.has(key)) s.frames.set(key, { at: frame.at, pts: frame.pts });
                }).catch(() => fail(s, '无法校验视频帧')).finally(() => s.hashes.delete(task));
                s.hashes.add(task);
            });
            try {
                const response = await fetch(streamUrl(s.url), { signal: s.controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
                if (!response.ok || !response.body) throw new Error(`线路返回 HTTP ${response.status}`);
                s.url = streamUrl(response.url || s.url); s.host = new URL(s.url).host;
                if (states.some(peer => peer !== s && peer.opened && endpointKey(peer.url) === endpointKey(s.url))) throw new Error('跳转到重复线路，已排除');
                s.opened = true;
                reader = response.body.getReader();
                while (!stopping && !s.error) {
                    const { value, done } = await reader.read();
                    if (done) throw new Error('线路已结束或中断');
                    parser.push(value, performance.now());
                }
            } catch (err) {
                if (!stopping && !s.error) fail(s, networkError(err));
            } finally {
                s.closed = true;
                await reader?.cancel().catch(() => {});
                parser.pending = new Uint8Array();
            }
        });
        const timer = setInterval(() => {
            const now = performance.now();
            for (const s of states) {
                if (s.latestPts !== null) s.snapshots.push({ at: now, pts: s.latestPts });
                s.snapshots = s.snapshots.filter(x => now - x.at <= 9000);
                s.ready = !s.error && !s.closed && warmupReady(s.snapshots, now);
            }
            const active = states.filter(s => !s.error);
            if (states[0].error || active.length < 2) stop('可比较线路不足两条或参考线路已中断');
            else if (start === null) {
                readyTicks = active.every(s => s.ready) ? readyTicks + 1 : 0;
                if (readyTicks >= 3) start = now;
                else if (now - began >= 45000) stop('预热未完成，无法排除启动积压；请降低画质或减少备用线路后重试');
            } else if (now - start >= 12000) stop(null);
            onUpdate({ phase: start === null ? 'warmup' : 'measure', elapsed: (now - began) / 1000,
                remaining: start === null ? null : Math.max(0, Math.ceil((12000 - now + start) / 1000)),
                nodes: states.map(s => ({ url: s.url, host: s.host, error: s.error, ready: s.ready })) });
        }, 500);
        try {
            await Promise.allSettled(readers);
            if (!stopping) stop('所有线路均已中断');
            await Promise.allSettled(states.flatMap(s => [...s.hashes]));
            if (signal.aborted) throw abortError();
            if (start === null || stopMessage) return { rows: states.map(s => ({ url: s.url, host: s.host, eligible: false, error: s.error || stopMessage })), best: null, matchedFrames: 0, error: stopMessage };
            return { ...summarize(states, start, end), measuredAt: new Date().toISOString(), warmupSeconds: (start - began) / 1000 };
        } finally {
            clearInterval(timer); stop(null); signal.removeEventListener('abort', cancel);
            for (const s of states) { s.frames.clear(); s.snapshots = []; }
        }
    }

    return { discover, measure, FlvParser, warmupReady, summarize, streamUrl, endpointKey };
})();
