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
    const intervals = new Map(), timeouts = new Map(), requests = [];
    let sequence = 0;
    const context = vm.createContext({
        URL, DOMException, AbortController, Uint8Array, DataView, TypeError,
        location: { protocol: 'http:' }, performance: { now: () => now },
        crypto: { subtle: { digest: async (algorithm, value) => Uint8Array.from(createHash('sha256').update(value).digest()).buffer } },
        setInterval: fn => { intervals.set(++sequence,fn); return sequence; }, clearInterval: id => intervals.delete(id),
        setTimeout: fn => { timeouts.set(++sequence,fn); return sequence; }, clearTimeout: id => timeouts.delete(id),
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
    return { api: context.CdnTester, context, requests, intervals, timeouts, flush, setNow: value => { now=value; }, tick: () => { for (const fn of [...intervals.values()]) fn(); } };
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
    const result=api.summarize([a,b,wrong],0,3000);
    assert.equal(result.matchedFrames,60);
    assert.equal(result.best.host,'b');
    assert.equal(result.rows[0].arrivalLagMs,0);
    assert.equal(result.rows[1].arrivalLagMs,20);
    assert.equal(result.rows[0].pictureLagMs,160);
    assert.equal(result.rows[2].eligible,false);
    assert.match(result.rows[2].error,/未对齐/);
});

test('a failed reference cannot silently certify an unrelated group', () => {
    const {api}=harness();
    const result=api.summarize([{url:'https://a/x',host:'a',error:'failed',frames:new Map()}],0,100);
    assert.equal(result.best,null);
    assert.match(result.error,/参考线路/);
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

test('measurement excludes startup catchup, reuses connections and releases streams and timers', async () => {
    const h=harness(), phases=[];
    const controller=new AbortController();
    let result;
    const task=h.api.measure([{url:'https://a/live.flv',host:'a'},{url:'https://b/live.flv',host:'b'}],controller.signal,p=>phases.push(p.phase)).then(r=>{result=r;});
    await h.flush();
    for(const request of h.requests)request.push(header);
    await h.flush();
    for(let i=1;i<=65&&!result;i++){
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
    for(let i=1;i<=91&&!result;i++){
        h.setNow(i*500);for(const r of h.requests)r.push(tag(100000+i*250));await h.flush();h.tick();await h.flush();
    }
    await task;
    assert.equal(result.best,null);
    assert.match(result.error,/预热未完成/);
    assert.equal(h.intervals.size,0);
    assert.ok(h.requests.every(r=>r.cancelled));
});
