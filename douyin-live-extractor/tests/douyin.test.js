import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoomInput, getRoomStreams, InputError } from '../public/douyin.js';

const root = new URL('../', import.meta.url);
const SHARE = '1- #在抖音，记录美好生活#【测试主播】正在直播，来和我一起支持Ta吧。复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/AbCdEfGh123/ 0@9.com :5pm';

function roomPage(room) {
    const state = { state: { roomStore: { roomInfo: { room } }, linkmicStore: {} } };
    return `<script>self.__pace_f.push([1,"${JSON.stringify(state).replace(/"/g, '\\"')}]\\n"])</script>`;
}
const pageRoom = {
    id_str: '777', title: '网页标题', status: 2, user_count: 9, cover: { url_list: ['https://cover'] },
    stream_url: {
        flv_pull_url: { SD1: 'http://pull-t5.douyincdn.com/ld.flv?expire=1', HD1: 'http://pull-t5.douyincdn.com/hd.flv?expire=1' },
        hls_pull_url_map: { SD1: 'http://pull-t5.douyincdn.com/ld.m3u8' }
    },
    owner: { nickname: '网页主播', avatar_thumb: {} },
    has_commerce_goods: false
};
const reflowRoom = {
    id_str: '777', title: '接口标题', status: 2, owner: { web_rid: '555', nickname: '接口主播' },
    stream_url: { flv_pull_url: { SD1: 'http://pull-flv-t11.douyincdn.com/ld.flv?expire=2', HD1: 'http://pull-t5.douyincdn.com/hd.flv?expire=2' } }
};

function mockFetch({ page = roomPage(pageRoom), reflow = reflowRoom, short = 'https://webcast.amemv.com/douyin/webcast/reflow/777?u_code=x' } = {}) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push(url);
        const { hostname, searchParams } = new URL(url);
        if (hostname === 'v.douyin.com') {
            assert.equal(options.redirect, 'manual');
            return short ? new Response(null, { status: 302, headers: { location: short } }) : new Response('<html>');
        }
        if (hostname === 'webcast.amemv.com') {
            assert.equal(searchParams.get('room_id'), '777');
            return reflow ? Response.json({ data: { room: reflow } }) : new Response('', { status: 500 });
        }
        if (hostname === 'live.douyin.com') return page ? new Response(page) : new Response('', { status: 500 });
        if (hostname === 'www.douyin.com') return new Response('<html>');
        throw new Error(`unexpected ${url}`);
    };
    return { fetchImpl, calls };
}

test('both deployable backends share an identical Douyin module', () => {
    assert.equal(readFileSync(new URL('public/douyin.js', root), 'utf8'), readFileSync(new URL('Cloudflare/public/douyin.js', root), 'utf8'));
});

test('room input is read from numbers, room links and whole share texts', () => {
    assert.deepEqual(parseRoomInput(SHARE), { shortUrl: 'https://v.douyin.com/AbCdEfGh123/' });
    assert.deepEqual(parseRoomInput(' 12345678901 '), { webRid: '12345678901' });
    assert.deepEqual(parseRoomInput('https://live.douyin.com/12345678901?enter_from=share'), { webRid: '12345678901' });
    assert.deepEqual(parseRoomInput('看这个 https://www.douyin.com/root/live/888，快来'), { webRid: '888' });
    assert.deepEqual(parseRoomInput('https://webcast.amemv.com/douyin/webcast/reflow/7000000000000000001?u_code=1'), { roomId: '7000000000000000001' });
    for (const text of ['', '复制下方链接 0@9.com :5pm', 'https://example.com/123', 'https://v.douyin.com/']) assert.equal(parseRoomInput(text), null);
});

test('share text follows the short link and merges CDN hosts from both sources', async () => {
    const { fetchImpl, calls } = mockFetch();
    const data = await getRoomStreams(SHARE, fetchImpl);
    assert.deepEqual(calls.map(url => new URL(url).hostname), ['v.douyin.com', 'webcast.amemv.com', 'live.douyin.com']);
    assert.equal(data.web_rid, '555');
    assert.equal(data.room_id, '777');
    assert.equal(data.title, '网页标题');
    assert.equal(data.anchor_name, '网页主播');
    assert.deepEqual(data.flv.SD1, {
        label: '标清 (SD)', url: 'https://pull-t5.douyincdn.com/ld.flv?expire=1',
        candidates: ['https://pull-flv-t11.douyincdn.com/ld.flv?expire=2']
    });
    assert.deepEqual(data.flv.HD1.candidates, []);
    assert.deepEqual(data.hls.SD1, { label: '标清 (SD)', url: 'https://pull-t5.douyincdn.com/ld.m3u8', candidates: [] });
});

test('room numbers still work when only one source answers', async () => {
    const pageOnly = await getRoomStreams('https://live.douyin.com/555', mockFetch({ reflow: null }).fetchImpl);
    assert.equal(pageOnly.web_rid, '555');
    assert.equal(pageOnly.flv.SD1.url, 'https://pull-t5.douyincdn.com/ld.flv?expire=1');
    assert.deepEqual(pageOnly.flv.SD1.candidates, []);

    const reflowOnly = await getRoomStreams(SHARE, mockFetch({ page: null }).fetchImpl);
    assert.equal(reflowOnly.web_rid, '555');
    assert.equal(reflowOnly.anchor_name, '接口主播');
    assert.equal(reflowOnly.flv.SD1.url, 'https://pull-flv-t11.douyincdn.com/ld.flv?expire=2');
});

test('unusable input and short links are reported as input errors', async () => {
    await assert.rejects(getRoomStreams('没有链接', mockFetch().fetchImpl), InputError);
    await assert.rejects(getRoomStreams(SHARE, mockFetch({ short: null }).fetchImpl), InputError);
    await assert.rejects(getRoomStreams(SHARE, mockFetch({ short: 'https://www.douyin.com/video/abc' }).fetchImpl), InputError);
});
