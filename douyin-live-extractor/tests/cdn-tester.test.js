import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../public/cdn-tester.js', import.meta.url), 'utf8');
const header = Buffer.from([70,76,86,1,5,0,0,0,9,0,0,0,0]);
function tag(dts, cts = 0, codec = 7) {
    const payload = Buffer.from([0x10 | codec,1,(cts>>>16)&255,(cts>>>8)&255,cts&255,42]);
    const buf = Buffer.alloc(11 + payload.length + 4);
    buf[0] = 9; buf.writeUIntBE(payload.length,1,3);
    buf.writeUIntBE(dts & 0xffffff,4,3); buf[7] = dts>>>24;
    payload.copy(buf,11); buf.writeUInt32BE(payload.length+11,buf.length-4);
    return buf;
}
function harness() {
    let now = 0;
    const intervals = new Map(), timeouts = new Map(), requests = [], players = [], videos = [];
    let sequence = 0;
    const element = tagName => {
        const element = { children: [], appendChild(child) { this.children.push(child); child.parent = this; },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); } };
        if (tagName === 'video') {
            Object.assign(element, { currentTime: 0, readyState: 0, paused: true, seeking: false, bufferEnd: 0,
                play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
                removeAttribute() {}, load() { this.currentTime = 0; this.readyState = 0; } });
            element.buffered = { get length() { return element.bufferEnd ? 1 : 0; }, start: () => 0, end: () => element.bufferEnd };
            videos.push(element);
        }
        return element;
    };
    class BaseLoader { destroy() { this._onDataArrival = null; } }
    const flvjs = { BaseLoader, isSupported: () => true, Events: { ERROR: 'error' }, createPlayer(data, config) {
        const player = { on() {}, attachMediaElement(video) { this.video = video; }, load() {
            this.loader = new config.customLoader(); let lastAt = now;
            this.loader._onDataArrival = bytes => {
                if (bytes.byteLength <= 13) return;
                if (!this.video.paused && this.video.readyState) this.video.currentTime += (now - lastAt) / 1000;
                lastAt = now; this.video.bufferEnd = now / 1000 + 3;
                if (!this.video.readyState) { this.video.currentTime = now / 1000; this.video.readyState = 4; this.video.onloadeddata?.(); }
            };
            this.loader.open(data);
        }, destroy() { this.destroyed = true; this.loader?.destroy(); } };
        players.push(player); return player;
    } };
    const context = vm.createContext({
        URL, DOMException, AbortController, Uint8Array, DataView, TypeError,
        document: { createElement: element, body: element('body') }, flvjs,
        location: { protocol: 'http:' }, performance: { now: () => now },
        crypto: { subtle: { digest: async (algorithm, value) => Uint8Array.from(createHash('sha256').update(value).digest()).buffer } },
        setInterval: fn => { intervals.set(++sequence,fn); return sequence; }, clearInterval: id => intervals.delete(id),
        setTimeout: (fn, ms) => { fn.delay = ms; timeouts.set(++sequence,fn); return sequence; }, clearTimeout: id => timeouts.delete(id),
        fetch: async (url, options) => {
            let controller;
            const request = { url, signal: options.signal, cancelled: false };
            const stream = new ReadableStream({ start(c) { controller = c; }, cancel() { request.cancelled = true; } });
            request.push = value => controller.enqueue(value);
            options.signal.addEventListener('abort', () => { request.cancelled = true; try { controller.error(new DOMException('aborted','AbortError')); } catch {} }, { once: true });
            requests.push(request);
            return { ok: true, status: 200, url, body: stream };
        }
    });
    vm.runInContext(source, context);
    const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
    return { api: context.CdnTester, context, requests, intervals, timeouts, players, videos, flush, setNow: value => { now=value; }, tick: () => { for (const fn of [...intervals.values()]) fn(); } };
}

test('FLV parser handles fragmented tags, timestamp extension and signed composition time', () => {
    const h=harness(), frames=[];
    const parser=new h.api.FlvParser(frame=>frames.push({dts:frame.dts,pts:frame.pts}));
    const bytes=Buffer.concat([header,tag(0x1000010,-5),tag(0x1000030,8)]);
    for(let i=0;i<bytes.length;i+=7)parser.push(bytes.subarray(i,i+7),123);
    assert.deepEqual(frames,[{dts:0x1000010,pts:0x1000010-5},{dts:0x1000030,pts:0x1000030+8}]);
    assert.equal(parser.pending.length,0);
});

test('unsupported codec and malformed oversized data cannot become a measurement', () => {
    const h=harness();
    assert.throws(()=>new h.api.FlvParser(()=>{}).push(Buffer.concat([header,tag(10,0,12)]),0),/H.264/);
    const malformed=tag(1);malformed.writeUIntBE(0xffffff,1,3);
    assert.throws(()=>new h.api.FlvParser(()=>{}).push(Buffer.concat([header,malformed]),0),/上限/);
});

test('warmup requires a full observation window and rejects catchup, stalls and growing backlog', () => {
    const {api}=harness();
    const samples=rate=>Array.from({length:17},(_,i)=>({at:i*500,pts:100000+i*500*rate}));
    assert.equal(api.warmupReady(samples(1),8000),true);
    assert.equal(api.warmupReady(samples(1).slice(1),8000),false);
    for(const rate of [0,0.8,1.5])assert.equal(api.warmupReady(samples(rate),8000),false);
});

test('ranking compares matching frame arrival times but chooses the latest available picture first', () => {
    const {api}=harness();
    const a={url:'https://a/live.flv',host:'a',frames:new Map(),error:null};
    const b={url:'https://b/live.flv',host:'b',frames:new Map(),error:null};
    const wrong={url:'https://c/other.flv',host:'c',frames:new Map(),error:null};
    for(let i=0;i<60;i++){
        a.frames.set('same-'+i,{at:100+i*40,pts:i*40});
        b.frames.set('same-'+i,{at:120+i*40,pts:i*40});
        wrong.frames.set('different-'+i,{at:100+i*40,pts:i*40});
    }
    b.frames.set('next',{at:2520,pts:2520});
    const result=api.summarize([a,b],0,3000);
    assert.equal(result.matchedFrames,60);
    assert.equal(result.best.host,'b');
    assert.equal(result.rows[0].arrivalLagMs,0);
    assert.equal(result.rows[1].arrivalLagMs,20);
    assert.equal(result.rows[0].pictureLagMs,160);
    const unknown = api.summarize([a,b,wrong],0,3000);
    assert.equal(unknown.best,null);
    assert.equal(unknown.rows[2].eligible,false);
    assert.match(unknown.rows[2].error,/未判定/);
});

test('a failed reference cannot silently certify an unrelated group', () => {
    const {api}=harness();
    const result=api.summarize([{url:'https://a/x',host:'a',error:'failed',frames:new Map()}],0,100);
    assert.equal(result.best,null);
    assert.match(result.error,/共同时间轴/);
});

test('discovery follows redirects, deduplicates rotating signatures and releases every probe', async () => {
    const h=harness();let calls=0,cancelled=0;
    h.context.fetch=async(url,options)=>{
        calls++;
        return {ok:true,status:200,url:`https://edge/live.flv?sign=${calls}`,body:new ReadableStream({start(c){c.enqueue(header);},cancel(){cancelled++;}})};
    };
    const result=await h.api.discover('https://dispatch/live.flv',[],new AbortController().signal);
    assert.equal(result.nodes.length,1);
    assert.equal(calls,4);
    assert.equal(cancelled,4);
    assert.equal(h.timeouts.size,0);
});

test('HTTPS pages reject mixed content before sending a probe', async () => {
    const h=harness();h.context.location.protocol='https:';
    const result=await h.api.discover('http://edge/live.flv',[],new AbortController().signal);
    assert.equal(h.requests.length,0);
    assert.equal(result.nodes.length,0);
    assert.match(result.failures[0].error,/HTTPS 页面/);
});

test('measurement actually seeks each player before comparing and releases players, streams and timers', async () => {
    const h=harness(), phases=[];
    const controller=new AbortController();
    let result;
    const task=h.api.measure([{url:'https://a/live.flv',host:'a'},{url:'https://b/live.flv',host:'b'}],controller.signal,p=>phases.push(p.phase)).then(r=>{result=r;});
    await h.flush();
    for(const request of h.requests)request.push(header);
    await h.flush();
    for(let i=1;i<=90&&!result;i++){
        const elapsed=i*500;
        const offset=elapsed<2000?2000-elapsed:0;
        const frames=Buffer.concat(Array.from({length:5},(_,j)=>tag(100000+elapsed-offset-400+j*100)));
        h.setNow(elapsed);h.requests[0].push(frames);await h.flush();
        h.setNow(elapsed+20);h.requests[1].push(frames);await h.flush();
        h.tick();await h.flush();
        if(elapsed<=8000)assert.equal(phases.includes('measure'),false);
    }
    await task;
    assert.equal(h.requests.length,2, 'no reconnect between warmup and measurement');
    assert.ok(result.warmupSeconds>=10);
    assert.ok(result.matchedFrames>=30);
    assert.equal(result.rows[1].arrivalLagMs,20);
    assert.equal(result.best.host,'a');
    assert.equal(h.intervals.size,0);
    assert.ok(h.requests.every(r=>r.cancelled));
    assert.ok(result.rows.every(r=>r.chases>=1));
    assert.ok(h.players.every(p=>p.destroyed));
    assert.equal(h.context.document.body.children.length,0);
});

test('cancellation closes all active test connections without a recommendation', async () => {
    const h=harness(), controller=new AbortController();
    const task=h.api.measure([{url:'https://a/live.flv',host:'a'},{url:'https://b/live.flv',host:'b'}],controller.signal);
    await h.flush();controller.abort();
    await assert.rejects(task,err=>err.name==='AbortError');
    assert.ok(h.requests.every(r=>r.cancelled));
    assert.equal(h.intervals.size,0);
});

test('continuously growing backlog times out without reporting a fastest node', async () => {
    const h=harness();let result;
    const task=h.api.measure([{url:'https://a/live.flv',host:'a'},{url:'https://b/live.flv',host:'b'}],new AbortController().signal).then(r=>{result=r;});
    await h.flush();for(const r of h.requests)r.push(header);await h.flush();
    for(const r of h.requests)r.sentHeader = true;
    for(let i=1;i<=210&&!result;i++){
        h.setNow(i*500);for(const r of h.requests.filter(r=>!r.cancelled)) { if(!r.sentHeader){r.push(header);r.sentHeader=true;} r.push(tag(100000+i*250)); }await h.flush();h.tick();await h.flush();
    }
    await task;
    assert.equal(result.best,null);
    assert.match(result.error,/未判定|未完成/);
    assert.equal(h.intervals.size,0);
    assert.ok(h.requests.every(r=>r.cancelled));
});

test('slow first response remains a candidate instead of being labelled old', async () => {
    const h=harness();let result;
    const task=h.api.discover('https://slow/live.flv',[],new AbortController().signal).then(r=>{result=r;});
    for(let i=0;i<8&&!result;i++) {
        await h.flush();
        for(const fn of [...h.timeouts.values()]){assert.equal(fn.delay,15000);fn();}
        await h.flush();
    }
    await task;
    assert.equal(result.nodes.length,1);
    assert.equal(result.nodes[0].pending,true);
    assert.equal(h.timeouts.size,0);
});

test('history alignment keeps a node twenty seconds ahead even without common frames in the final window', () => {
    const {api}=harness();
    const old={host:'old',url:'https://old/live.flv',frames:new Map(),history:new Map()};
    const newer={host:'new',url:'https://new/live.flv',frames:new Map(),history:new Map()};
    for(let i=0;i<60;i++) {
        old.history.set('identity-'+i,{pts:120000+i*40,at:2000});
        newer.history.set('identity-'+i,{pts:120000+i*40,at:1000});
        old.frames.set('old-'+i,{pts:130000+i*40,at:30000+i*40});
        newer.frames.set('new-'+i,{pts:150000+i*40,at:30000+i*40});
    }
    const result=api.summarize([old,newer],30000,42000);
    assert.equal(result.best.host,'new');
    assert.equal(result.rows[0].pictureLagMs,20000);
    assert.equal(result.rows[1].arrivalLagMs,null);
});

test('an unmeasured candidate prevents claiming a global winner even if two others align', () => {
    const {api}=harness();
    const frames=new Map(Array.from({length:60},(_,i)=>['id'+i,{at:100+i,pts:i*40}]));
    const result=api.summarize([{host:'failed',error:'timeout',frames:new Map()},
        {host:'a',frames}, {host:'b',frames}],0,1000);
    assert.equal(result.best,null);
    assert.equal(result.rows[1].eligible,true);
    assert.match(result.error,/部分候选仍未判定/);
});

async function runPlaybackScenario(lagForRequest, delayForRequest=()=>0) {
    const h=harness();let result;
    const task=h.api.measure([{url:'https://a/live.flv',host:'a'},{url:'https://b/live.flv',host:'b'}],new AbortController().signal).then(r=>{result=r;});
    await h.flush();
    for(let i=1;i<=190&&!result;i++) {
        const now=i*500;h.setNow(now);
        for(const r of [...h.requests].filter(r=>!r.cancelled)) {
            if(!r.sentHeader){r.push(header);r.sentHeader=true;}
            if(now<delayForRequest(r,h))continue;
            const lag=lagForRequest(r,h);
            r.push(Buffer.concat(Array.from({length:5},(_,j)=>tag(100000+now-lag-400+j*100))));
            await h.flush();
        }
        h.tick();await h.flush();
    }
    await task;return {h,result};
}

test('a three-second first picture can win after actual player catchup', async () => {
    const {h,result}=await runPlaybackScenario(r=>r.url.includes('//a/')?0:2000,r=>r.url.includes('//a/')?3000:0);
    assert.equal(result.best.host,'a');
    assert.ok(result.rows[0].loadMs>=3000);
    assert.ok(result.rows[0].loadMs>result.rows[1].loadMs);
    assert.ok(result.rows.every(r=>r.chases>=1));
    assert.equal(result.rows[1].reconnects,1);
    assert.ok(h.requests.every(r=>r.cancelled));
});

test('a stale connection gets one reload trial and can become the freshest node', async () => {
    const {result}=await runPlaybackScenario((r,h)=>r.url.includes('//a/')?(h.requests.filter(x=>x.url===r.url).length>1?0:3000):1000);
    assert.equal(result.best.host,'a');
    assert.equal(result.rows[0].reconnects,1);
    assert.ok(result.rows[0].chases>=2);
});
