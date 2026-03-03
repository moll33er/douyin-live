import { SignJWT } from 'jose';

export async function onRequestPost({ request, env }) {
    try {
        const { username, password } = await request.json();

        const VALID_USERNAME = env.USERNAME || "admin";
        const VALID_PASSWORD = env.PASSWORD || "password123";
        const JWT_SECRET = env.JWT_SECRET || "default_unsafe_secret";

        if (username === VALID_USERNAME && password === VALID_PASSWORD) {
            const secret = new TextEncoder().encode(JWT_SECRET);
            const token = await new SignJWT({ username })
                .setProtectedHeader({ alg: 'HS256' })
                .setExpirationTime('24h')
                .sign(secret);

            return Response.json({ success: true, token });
        } else {
            return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
        }
    } catch (error) {
        return Response.json({ success: false, error: 'Bad Request' }, { status: 400 });
    }
}
