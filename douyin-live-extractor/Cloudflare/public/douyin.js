/* Douyin room resolution shared by the Node server, Cloudflare Pages Functions and the page itself
   (browser-parser.js). It lives in public/ so browsers can load it; public/douyin.js and
   Cloudflare/public/douyin.js must stay identical. */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const QUALITY_LABELS = {
    'FULL_HD1': '原画 (Origin)',
    'HD1': '超清 (HD)',
    'SD2': '高清 (SD High)',
    'SD1': '标清 (SD)'
};

export class InputError extends Error {}

function roomFromUrl(url) {
    if (!/(^|\.)(douyin\.com|iesdouyin\.com|amemv\.com)$/.test(url.hostname)) return null;
    if (url.hostname === 'v.douyin.com') return url.pathname.length > 1 ? { shortUrl: url.href } : null;
    // Share redirects carry the internal room id, not the room number used by live.douyin.com.
    const reflow = url.pathname.match(/\/reflow\/(\d+)/);
    if (reflow) return { roomId: reflow[1] };
    const webRid = url.pathname.split('/').filter(part => /^\d+$/.test(part)).pop();
    return webRid ? { webRid } : null;
}

// Accepts a room number, a room or short link, or the whole share text copied from the app.
export function parseRoomInput(input) {
    const text = String(input ?? '').trim();
    if (/^\d+$/.test(text)) return { webRid: text };
    for (const raw of text.match(/https?:\/\/[^\s"'<>，。！？、】）]+/gi) || []) {
        let url;
        try { url = new URL(raw); } catch { continue; }
        const room = roomFromUrl(url);
        if (room) return room;
    }
    return null;
}

async function followShortLink(url, fetchImpl) {
    for (let hop = 0; hop < 5; hop++) {
        const res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': MOBILE_UA } });
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) break;
        url = new URL(location, url).href;
        const room = roomFromUrl(new URL(url));
        if (room && !room.shortUrl) return room;
    }
    throw new InputError('短链接没有跳转到直播间，可能已失效或不是直播分享');
}

function extractJSON(pattern, pageHTML) {
    const match = pageHTML?.match(pattern);
    if (match) {
        return match[1].replace(/\\/g, '').replace(/u0026/g, '&');
    }
    return null;
}

function parsePageRoom(pageHTML) {
    try {
        let jsonStr = extractJSON(/(\{\\"state\\":.*?)]\\n"]\)/, pageHTML);
        if (!jsonStr) {
            jsonStr = extractJSON(/(\{\\"common\\":.*?)]\\n"]\)<\/script><div hidden/, pageHTML);
        }
        if (!jsonStr) return null;

        const roomStoreMatch = jsonStr.match(/"roomStore":(.*?),"linkmicStore"/);
        if (!roomStoreMatch) return null;

        const roomStore = `${roomStoreMatch[1].split(',"has_commerce_goods"')[0]}}}}`;
        const room = JSON.parse(roomStore)?.roomInfo?.room;
        if (!room) return null;

        const anchorNameMatch = roomStore.match(/"nickname":"(.*?)","avatar_thumb/);
        return { room, anchorName: anchorNameMatch ? anchorNameMatch[1] : '' };
    } catch (error) {
        console.error('Error parsing room data:', error);
        return null;
    }
}

async function fetchPageRoom(webRid, fetchImpl) {
    const res = await fetchImpl(`https://live.douyin.com/${webRid}`, {
        headers: {
            'User-Agent': DESKTOP_UA,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': 'https://live.douyin.com/',
            'Cookie': '__ac_nonce=065a4c0c100a89d7b4255'
        }
    });
    if (!res.ok) throw new Error(`Failed to fetch from Douyin: ${res.status}`);
    return parsePageRoom(await res.text());
}

async function fetchReflowRoom(roomId, fetchImpl) {
    const res = await fetchImpl(`https://webcast.amemv.com/webcast/room/reflow/info/?type_id=0&live_id=1&room_id=${roomId}&app_id=1128`, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    if (!res.ok) throw new Error(`Failed to fetch room info: ${res.status}`);
    return (await res.json())?.data?.room || null;
}

// The first room is the primary source; other sources only add addresses on different CDN hosts.
function formatStreams(rooms, field) {
    const streams = {};
    for (const room of rooms) {
        for (const [key, raw] of Object.entries(room?.stream_url?.[field] || {})) {
            const url = raw.replace(/http:\/\//g, 'https://');
            const stream = streams[key] ??= { label: QUALITY_LABELS[key] || key, url, candidates: [] };
            const host = new URL(url).host;
            if (host !== new URL(stream.url).host && !stream.candidates.some(other => new URL(other).host === host)) stream.candidates.push(url);
        }
    }
    return streams;
}

export async function getRoomStreams(input, fetchImpl = fetch) {
    let target = parseRoomInput(input);
    if (!target) throw new InputError('Could not extract valid Room ID from URL');
    if (target.shortUrl) target = await followShortLink(target.shortUrl, fetchImpl);

    let reflow = target.roomId ? await fetchReflowRoom(target.roomId, fetchImpl) : null;
    const webRid = target.webRid || reflow?.owner?.web_rid;
    const page = webRid ? await fetchPageRoom(webRid, fetchImpl).catch(err => { if (!reflow) throw err; return null; }) : null;
    // The platform dispatches each source separately, so a second source can reveal another CDN.
    if (!reflow && page?.room.id_str) reflow = await fetchReflowRoom(page.room.id_str, fetchImpl).catch(() => null);
    // Long bare numbers may be internal room ids copied from share links rather than room numbers.
    if (!page && !reflow && target.webRid?.length >= 18) reflow = await fetchReflowRoom(target.webRid, fetchImpl).catch(() => null);

    const room = page?.room || reflow;
    if (!room) return null;
    const rooms = [page?.room, reflow].filter(Boolean);
    return {
        web_rid: reflow?.owner?.web_rid || (page && target.webRid) || null,
        room_id: room.id_str || target.roomId || null,
        title: room.title,
        status: room.status, // 2 is live usually
        anchor_name: page?.anchorName || reflow?.owner?.nickname || '',
        cover: room.cover?.url_list?.[0],
        viewer_count: room.user_count,
        flv: formatStreams(rooms, 'flv_pull_url'),
        hls: formatStreams(rooms, 'hls_pull_url_map')
    };
}
