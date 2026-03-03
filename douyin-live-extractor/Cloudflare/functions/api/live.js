import { jwtVerify } from 'jose';

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);

    // 1. Auth Check
    const token = url.searchParams.get('token') || request.headers.get('x-api-key');
    if (!token) {
        return Response.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    const JWT_SECRET = env.JWT_SECRET || "default_unsafe_secret";
    try {
        const secret = new TextEncoder().encode(JWT_SECRET);
        await jwtVerify(token, secret);
    } catch (err) {
        if (err.code === 'ERR_JWT_EXPIRED') {
            return Response.json({ error: 'Token expired', code: 'TOKEN_EXPIRED' }, { status: 401 });
        }
        return Response.json({ error: 'Forbidden: Invalid token' }, { status: 403 });
    }

    // 2. Extract Room ID
    const inputUrl = url.searchParams.get('url');
    if (!inputUrl) {
        return Response.json({ error: 'Missing "url" query parameter' }, { status: 400 });
    }

    try {
        let rid = inputUrl;
        if (inputUrl.includes('douyin.com')) {
            const match = inputUrl.match(/\/(\d+)(?:|\/|\?|$)/);
            if (match) {
                rid = match[1];
            } else {
                const fallbackMatch = inputUrl.match(/douyin\.com\/.*?(\d{19})/);
                if (fallbackMatch) rid = fallbackMatch[1];
            }
        }

        if (!rid.match(/^\d+$/)) {
            const match = inputUrl.match(/\/(\d+)(?:\/|\?|$)/);
            if (match) rid = match[1];
        }

        if (!rid.match(/^\d+$/)) {
            return Response.json({ error: 'Could not extract valid Room ID from URL' }, { status: 400 });
        }

        // 3. Fetch Stream Data
        const streamData = await getStreamData(rid);

        if (streamData) {
            return Response.json({
                success: true,
                data: streamData
            });
        } else {
            return Response.json({
                success: false,
                error: 'Stream data not found. Room might be offline.'
            }, { status: 404 });
        }
    } catch (error) {
        return Response.json({
            success: false,
            error: error.message
        }, { status: 500 });
    }
}

async function getStreamData(rid) {
    const douyinUrl = `https://live.douyin.com/${rid}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://live.douyin.com/',
        'Cookie': '__ac_nonce=065a4c0c100a89d7b4255'
    };

    const response = await fetch(douyinUrl, { headers });
    if (!response.ok) {
        throw new Error(`Failed to fetch from Douyin: ${response.status}`);
    }
    const html = await response.text();
    return parseStreamData(html);
}

function extractJSON(pattern, pageHTML) {
    const match = pageHTML?.match(pattern);
    if (match) {
        return match[1].replace(/\\/g, '').replace(/u0026/g, '&');
    }
    return null;
}

function parseStreamData(pageHTML) {
    try {
        let jsonStr = extractJSON(/(\{\\"state\\":.*?)]\\n"]\)/, pageHTML);
        if (!jsonStr) {
            jsonStr = extractJSON(/(\{\\"common\\":.*?)]\\n"]\)<\/script><div hidden/, pageHTML);
        }

        if (!jsonStr) {
            return null;
        }

        const roomStoreMatch = jsonStr.match(/"roomStore":(.*?),"linkmicStore"/);
        if (!roomStoreMatch) {
            return null;
        }

        const roomStore = `${roomStoreMatch[1].split(',"has_commerce_goods"')[0]}}}}`;
        const roomData = JSON.parse(roomStore)?.roomInfo?.room;
        if (!roomData) {
            return null;
        }

        const anchorNameMatch = roomStore.match(/"nickname":"(.*?)","avatar_thumb/);
        const anchorName = anchorNameMatch ? anchorNameMatch[1] : '';

        const replaceHttp = (obj) => {
            if (!obj) return null;
            return Object.entries(obj).reduce((acc, [key, value]) => {
                acc[key] = value.replace(/http:\/\//g, 'https://');
                return acc;
            }, {});
        };

        const qualityMap = {
            'FULL_HD1': '原画 (Origin)',
            'HD1': '超清 (HD)',
            'SD2': '高清 (SD High)',
            'SD1': '标清 (SD)'
        };

        const formatStreams = (streams) => {
            if (!streams) return {};
            return Object.entries(streams).reduce((acc, [key, val]) => {
                const label = qualityMap[key] || key;
                acc[key] = { label, url: val };
                return acc;
            }, {});
        };

        return {
            title: roomData.title,
            status: roomData.status,
            anchor_name: anchorName,
            cover: roomData.cover?.url_list?.[0],
            viewer_count: roomData.user_count,
            flv: formatStreams(replaceHttp(roomData?.stream_url?.flv_pull_url)),
            hls: formatStreams(replaceHttp(roomData?.stream_url?.hls_pull_url_map)),
        };
    } catch (error) {
        console.error("Error parsing room data:", error);
        return null;
    }
}
