# Douyin Live Extractor

This tool extracts live stream URLs (FLV and HLS) from a Douyin live room.
It was ported from the userscript `douyin.js`.

## Installation

1. Navigate to this directory.
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

Run the script with a Douyin Live URL or Room ID:

```bash
node index.js <url_or_room_id>
```

Example:
```bash
node index.js https://live.douyin.com/1234567890
# or
node index.js 1234567890
```

## Note

This script uses `axios` to fetch the page content. Douyin has anti-crawling mechanisms.
If you see errors about failing to extract data, it might be due to missing cookies or verification challenges (captcha).
In that case, you might need to extract `__ac_nonce` or other cookies from your browser and update the `headers` in `index.js`.
