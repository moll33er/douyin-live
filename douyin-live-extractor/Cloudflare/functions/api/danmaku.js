import { jwtVerify } from 'jose';
import { relayTarget, openUpstream } from '../../public/danmaku-relay.js';

const REQUIRE_LOGIN_VALUES = new Set(['true', '1', 'yes', 'on']);

function requireLogin(env) {
    return REQUIRE_LOGIN_VALUES.has(String(env.REQUIRE_LOGIN ?? 'true').toLowerCase());
}

// Workers open outgoing websockets with fetch(); it resolves once Douyin has answered the handshake.
async function connectDouyin(url, headers) {
    const response = await fetch(url.replace(/^wss:/, 'https:'), { headers: { ...headers, Upgrade: 'websocket' } });
    if (response.webSocket) return response.webSocket;
    response.body?.cancel().catch(() => {});
    return null;
}

// Relays a room's danmaku websocket for browsers that cannot send Douyin its cookie (see public/danmaku-relay.js).
export async function onRequestGet({ request, env }) {
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    const url = new URL(request.url);

    // 1. Auth Check
    if (requireLogin(env)) {
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
    }

    // 2. Read input
    let target;
    try {
        target = relayTarget(url.searchParams);
    } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
    }

    // 3. Connect to Douyin first, so the browser only sees an open socket when danmaku can flow
    let douyin = null;
    try {
        douyin = await openUpstream(target, connectDouyin);
    } catch (error) {
        return Response.json({ error: error.message }, { status: 502 });
    }
    if (!douyin) {
        return Response.json({ error: 'Douyin refused the danmaku connection' }, { status: 502 });
    }

    // Handing Douyin's socket to the browser unaccepted lets the runtime pass frames and closes through itself.
    return new Response(null, { status: 101, webSocket: douyin });
}
