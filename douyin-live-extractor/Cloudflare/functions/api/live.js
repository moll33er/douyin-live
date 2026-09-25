import { jwtVerify } from 'jose';
import { getRoomStreams, InputError } from '../../lib/douyin.js';

const REQUIRE_LOGIN_VALUES = new Set(['true', '1', 'yes', 'on']);

function requireLogin(env) {
    return REQUIRE_LOGIN_VALUES.has(String(env.REQUIRE_LOGIN ?? 'true').toLowerCase());
}

export async function onRequestGet({ request, env }) {
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
    const inputUrl = url.searchParams.get('url');
    if (!inputUrl) {
        return Response.json({ error: 'Missing "url" query parameter' }, { status: 400 });
    }

    try {
        // 3. Resolve room number, link or share text and fetch stream data
        const streamData = await getRoomStreams(inputUrl);

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
        if (error instanceof InputError) {
            return Response.json({ success: false, error: error.message }, { status: 400 });
        }
        return Response.json({
            success: false,
            error: error.message
        }, { status: 500 });
    }
}
