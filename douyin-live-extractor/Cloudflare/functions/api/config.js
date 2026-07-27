const REQUIRE_LOGIN_VALUES = new Set(['true', '1', 'yes', 'on']);

function requireLogin(env) {
    return REQUIRE_LOGIN_VALUES.has(String(env.REQUIRE_LOGIN ?? 'true').toLowerCase());
}

export async function onRequestGet({ env }) {
    return Response.json({ requireLogin: requireLogin(env) });
}
