/* Signs Douyin danmaku websocket addresses for danmaku.js. douyin-sign.js swaps `window` and `document` for
   stubs, so it runs here instead of on the page. Requests are { id, input }, where input is the signed
   parameter list; the signer takes its md5, as Douyin's own page does. */
importScripts('douyin-sign.js');

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_TABLE = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

// Hex md5 of the UTF-8 bytes of `text`.
function md5(text) {
    const bytes = new TextEncoder().encode(text);
    const words = new Int32Array((((bytes.length + 8) >> 6) + 1) * 16);
    bytes.forEach((byte, i) => { words[i >> 2] |= byte << (i % 4 * 8); });
    words[bytes.length >> 2] |= 0x80 << (bytes.length % 4 * 8);
    words[words.length - 2] = bytes.length * 8;
    let h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
    for (let block = 0; block < words.length; block += 16) {
        let [a, b, c, d] = h;
        for (let i = 0; i < 64; i++) {
            const round = i >> 4;
            const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
            const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
            const shift = MD5_SHIFTS[round * 4 + i % 4];
            const sum = (a + f + MD5_TABLE[i] + words[block + g]) | 0;
            [a, d, c] = [d, c, b];
            b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
        }
        h = [h[0] + a | 0, h[1] + b | 0, h[2] + c | 0, h[3] + d | 0];
    }
    return h.map(word => Array.from({ length: 4 }, (_, i) => ((word >>> (i * 8)) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

onmessage = ({ data }) => {
    try {
        postMessage({ id: data.id, signature: get_sign(md5(data.input)) });
    } catch (err) {
        postMessage({ id: data.id, error: String(err?.message || err) });
    }
};
