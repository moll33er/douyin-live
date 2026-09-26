/* Compare decoded pictures on the same browser clock, across two FLV qualities. */
globalThis.QualityTester = (() => {
    const WIDTH = 32, HEIGHT = 18, SAMPLE_MS = 100, WINDOW_MS = 20000;
    const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
    };
    function fingerprint(rgba) {
        const pixels = new Float32Array(rgba.length / 4);
        let mean = 0;
        for (let i = 0; i < pixels.length; i++) {
            pixels[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) / 255;
            mean += pixels[i];
        }
        mean /= pixels.length;
        for (let i = 0; i < pixels.length; i++) pixels[i] -= mean;
        return pixels;
    }

    function compare(a, b) {
        const unknown = error => ({ eligible: false, bestIndex: null, error });
        if (a.length < 60 || b.length < 60) return unknown('有效画面不足，请保持页面在前台后重试。');
        // ponytail: bounded 20-second, ~10 fps windows; no vision library or trained model.
        const distances = a.map(x => Float32Array.from(b, y => {
            let sum = 0;
            for (let k = 0; k < x.pixels.length; k++) sum += (x.pixels[k] - y.pixels[k]) ** 2;
            return sum / x.pixels.length;
        }));
        const nearest = values => {
            let best = 0;
            for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i;
            return best;
        };
        const ab = distances.map(nearest);
        const ba = b.map((_, j) => nearest(distances.map(row => row[j])));
        const unique = (values, frames, index) => {
            const alternative = Math.min(...values.filter((_, i) => Math.abs(frames[i].at - frames[index].at) > 300));
            return values[index] < 0.0064 && alternative > values[index] * 1.8 + 0.00015;
        };
        const matches = [];
        for (let i = 0; i < a.length; i++) {
            const j = ab[i];
            if (ba[j] !== i || !unique(distances[i], b, j) || !unique(distances.map(row => row[j]), a, i)) continue;
            matches.push({ at: a[i].at, otherAt: b[j].at, delta: b[j].at - a[i].at });
        }
        if (matches.length < Math.max(24, Math.min(a.length, b.length) * 0.25)) {
            return unknown('无法可靠匹配：画面可能静止、重复、变化太少，或两路内容差异较大。');
        }
        const deltaMs = median(matches.map(m => m.delta));
        if (Math.abs(deltaMs) > 8000) return unknown('画面时间差可能超过 8 秒，请同步或重新连接后重试。');
        const stable = matches.filter(m => Math.abs(m.delta - deltaMs) <= 200);
        const overlapStart = Math.max(a[0].at, b[0].at - deltaMs);
        const overlapEnd = Math.min(a.at(-1).at, b.at(-1).at - deltaMs);
        if (stable.length < matches.length * 0.9 || stable.at(-1).at - stable[0].at < 6000 ||
            stable[0].at - overlapStart > 2500 || overlapEnd - stable.at(-1).at > 2500 ||
            stable.some((m, i) => i && (m.otherAt <= stable[i - 1].otherAt || m.at - stable[i - 1].at > 2500))) {
            return unknown('画面匹配不连续或延迟波动较大，无法稳定判断谁领先。');
        }
        const middle = Math.floor(stable.length / 2);
        if (Math.abs(median(stable.slice(0, middle).map(m => m.delta)) - median(stable.slice(middle).map(m => m.delta))) > 150) {
            return unknown('测试期间相对延迟发生变化，请网络稳定后重试。');
        }
        const uncertaintyMs = Math.max(200, median(stable.map(m => Math.abs(m.delta - deltaMs))) * 3 + SAMPLE_MS);
        return { eligible: true, deltaMs, uncertaintyMs, matchedFrames: stable.length,
            bestIndex: Math.abs(deltaMs) <= uncertaintyMs ? null : deltaMs > 0 ? 0 : 1 };
    }

    async function measure(sources, signal, onUpdate = () => {}, previews = document.body) {
        if (signal.aborted) throw new DOMException('对比已取消', 'AbortError');
        if (document.hidden) throw new Error('请保持页面在前台后开始对比。');
        if (!globalThis.flvjs?.isSupported()) throw new Error('当前浏览器不支持 FLV 试播。');
        if (sources.length !== 2 || sources[0].key === sources[1].key) throw new Error('请选择两种不同画质。');
        const states = sources.map(source => ({ ...source, url: CdnTester.streamUrl(source.url), samples: [], chases: 0,
            chasedAt: -Infinity, lastFrameAt: null, lastMediaTime: null, stableSince: null, ready: false }));
        if (states[0].url === states[1].url) throw new Error('这两种画质返回了同一播放地址，无法单独比较。');
        let timer, stopped = false, sampleStart = null;
        const began = performance.now();
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        function cleanup() {
            clearInterval(timer);
            signal.removeEventListener('abort', cancel);
            document.removeEventListener('visibilitychange', visibility);
            for (const s of states) {
                if (s.callback != null) s.video?.cancelVideoFrameCallback(s.callback);
                s.player?.destroy();
                if (s.video) {
                    s.video.onerror = null;
                    s.video.pause(); s.video.removeAttribute('src'); s.video.load();
                }
                s.figure?.remove();
            }
        }
        function finish(error) {
            if (stopped) return;
            stopped = true;
            cleanup();
            if (error) reject(error);
            else resolve(compare(states[0].samples, states[1].samples));
        }
        function cancel() { finish(new DOMException('对比已取消', 'AbortError')); }
        function visibility() { if (document.hidden) finish(new Error('页面已进入后台，对比已取消；请保持页面在前台。')); }
        signal.addEventListener('abort', cancel, { once: true });
        document.addEventListener('visibilitychange', visibility);
        try {
            for (const s of states) {
                const video = s.video = document.createElement('video');
                if (!video.requestVideoFrameCallback) throw new Error('浏览器不支持逐帧观测，请使用新版 Chrome 或 Edge。');
                video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous';
                const canvas = document.createElement('canvas');
                canvas.width = WIDTH; canvas.height = HEIGHT;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) throw new Error('浏览器无法读取视频画面。');
                s.figure = document.createElement('figure');
                const caption = document.createElement('figcaption');
                caption.textContent = s.label || s.key;
                s.figure.appendChild(video); s.figure.appendChild(caption); previews.appendChild(s.figure);
                video.onerror = () => finish(new Error(`${s.label || s.key}：试播解码失败。`));
                const frame = (now, metadata) => {
                    if (stopped) return;
                    try {
                        const displayAt = metadata.expectedDisplayTime;
                        if (!Number.isFinite(displayAt) || !Number.isFinite(metadata.mediaTime)) throw new Error('无法获取画面显示时间。');
                        if (video.seeking || video.readyState < 2) { s.stableSince = null; }
                        else {
                            const gap = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : Infinity;
                            // A new connection keeps receiving the CDN's cached pictures faster than real time for a
                            // few seconds; chase at most once a second until that settles. The warmup timeout bounds it.
                            if (!s.chases || (sampleStart === null && gap > 1 && displayAt - s.chasedAt >= 1000)) {
                                if (CdnTester.chase(video)) { s.chases++; s.chasedAt = displayAt; }
                                s.stableSince = null; s.ready = false;
                            } else {
                                const elapsed = s.lastFrameAt === null ? 0 : displayAt - s.lastFrameAt;
                                const advanced = s.lastMediaTime === null ? 0 : (metadata.mediaTime - s.lastMediaTime) * 1000;
                                const stable = elapsed > 0 && elapsed < 500 && Math.abs(advanced - elapsed) < 150 && gap < 1;
                                if (sampleStart !== null && !stable) throw new Error(`${s.label || s.key}：试播卡顿或缓冲积累，无法稳定比较。`);
                                if (stable) s.stableSince ??= displayAt;
                                else s.stableSince = null;
                                s.ready = s.stableSince !== null && displayAt - s.stableSince >= 2000;
                                if (sampleStart !== null && displayAt >= sampleStart && displayAt <= sampleStart + WINDOW_MS &&
                                    (!s.samples.length || displayAt - s.samples.at(-1).at >= SAMPLE_MS - 10)) {
                                    // A delayed callback could read a newer picture than its metadata: reject that run.
                                    if (Math.abs(now - displayAt) > 100) throw new Error('设备处理画面过慢，请降低画质后重试。');
                                    ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
                                    s.samples.push({ at: displayAt, pixels: fingerprint(ctx.getImageData(0, 0, WIDTH, HEIGHT).data) });
                                }
                            }
                        }
                        s.lastFrameAt = displayAt; s.lastMediaTime = metadata.mediaTime;
                        s.callback = video.requestVideoFrameCallback(frame);
                    } catch (err) {
                        finish(err.name === 'SecurityError' ? new Error('无法读取视频画面：线路不允许跨域取图。') : err);
                    }
                };
                s.callback = video.requestVideoFrameCallback(frame);
                s.player = flvjs.createPlayer({ type: 'flv', url: s.url, isLive: true }, {
                    enableStashBuffer: false, lazyLoad: false, autoCleanupSourceBuffer: true
                });
                s.player.on(flvjs.Events.ERROR, () => finish(new Error(`${s.label || s.key}：连接或解码失败，请检查跨域权限、地址有效期与编码格式。`)));
                s.player.attachMediaElement(video); s.player.load();
                if (stopped) break;
                video.play().catch(() => { if (!stopped) finish(new Error('试播未能开始，请重新点击开始对比。')); });
            }
            if (!stopped) timer = setInterval(() => {
                const now = performance.now();
                if (sampleStart === null) {
                    if (now - began > 25000) {
                        const behind = states.find(s => !s.ready && now - s.chasedAt < 3000);
                        finish(new Error(behind ? `${behind.label || behind.key}：缓冲持续积压，无法稳定追到直播位置。` : '加载或追帧超时，请检查网络后重试。'));
                        return;
                    }
                    if (states.every(s => s.ready && now - s.lastFrameAt < 500)) {
                        const ratios = states.map(s => s.video.videoWidth / s.video.videoHeight);
                        if (!ratios.every(Number.isFinite) || Math.abs(ratios[0] / ratios[1] - 1) > 0.03) {
                            finish(new Error('两路画面比例不同，无法可靠匹配。')); return;
                        }
                        sampleStart = now;
                    }
                } else {
                    if (states.some(s => now - s.lastFrameAt > 500)) { finish(new Error('试播画面停滞，无法稳定比较。')); return; }
                    if (now - sampleStart >= WINDOW_MS) { finish(); return; }
                }
                try {
                    onUpdate({ phase: sampleStart === null ? 'prepare' : 'sample',
                        remaining: sampleStart === null ? null : Math.ceil((WINDOW_MS - now + sampleStart) / 1000) });
                } catch (err) { finish(err); }
            }, 250);
        } catch (err) { finish(err); }
        return finished;
    }
    return { measure, compare, fingerprint };
})();
