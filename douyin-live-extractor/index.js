import axios from 'axios';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 33333;

// Generate random secret on startup
const JWT_SECRET = crypto.randomBytes(64).toString('hex');
console.log('Generated new JWT Secret for this session.');

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {
  username: 'admin',
  password: 'password123'
};

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    console.warn('config.json not found, using default credentials');
  }
} catch (error) {
  console.error('Error loading config.json:', error);
}

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Login Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === config.username && password === config.password) {
    // Sign token with 24h expiration
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// Authentication Middleware
const authMiddleware = (req, res, next) => {
  const token = req.query.token || req.headers['x-api-key'];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }
    req.user = user;
    next();
  });
};

app.get('/api/live', authMiddleware, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    let rid = url;
    // If input is a full URL, extract the RID
    if (url.includes('douyin.com')) {
      const match = url.match(/\/(\d+)(?:|\/|\?|$)/); // Fixed regex to be safer
      if (match) {
        rid = match[1];
      } else {
        // Try to resolve short links or redirect if needed, but for now just fail if pattern matches
        // For simplified logic, assume the user might pass a raw numeric ID or a standard URL
        // If regex failed but it contains douyin.com, it might be a different format. 
        // Let's stick to the original regex logic but safer.
        const fallbackMatch = url.match(/douyin\.com\/.*?(\d{19})/); // naive fallback for long IDs
        if (fallbackMatch) rid = fallbackMatch[1];
      }
    }

    if (!rid.match(/^\d+$/)) {
      // If after extraction it's still not a number, maybe extraction failed or it WAS a number but regex didn't run
      // Let's rely on the original logic: if valid URL, extract. If not, treat as ID.
      const match = url.match(/\/(\d+)(?:\/|\?|$)/);
      if (match) rid = match[1];
    }

    // Final check
    if (!rid.match(/^\d+$/)) {
      return res.status(400).json({ error: 'Could not extract valid Room ID from URL' });
    }

    console.log(`Processing Room ID: ${rid}`);
    const streamData = await getStreamData(rid);

    if (streamData) {
      res.json({
        success: true,
        data: streamData
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Stream data not found. Room might be offline.'
      });
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Log in via the web interface to generate a token.`);
});

server.on('error', (e) => {
  console.error('Server error:', e);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function getStreamData(rid) {
  const url = `https://live.douyin.com/${rid}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://live.douyin.com/',
    'Cookie': '__ac_nonce=065a4c0c100a89d7b4255'
  };

  try {
    const response = await axios.get(url, { headers });
    const html = response.data;
    return parseStreamData(html);
  } catch (error) {
    console.error('Request failed:', error.message);
    throw error;
  }
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

    // Format streams with labels if needed, or return raw structure. 
    // Returning structured object with labels for API convenience.
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
      status: roomData.status, // 2 is live usually
      anchor_name: anchorName,
      cover: roomData.cover?.url_list?.[0], // Added cover image
      viewer_count: roomData.user_count, // Added viewer count
      flv: formatStreams(replaceHttp(roomData?.stream_url?.flv_pull_url)),
      hls: formatStreams(replaceHttp(roomData?.stream_url?.hls_pull_url_map)),
    };

  } catch (error) {
    console.error("Error parsing room data:", error);
    return null;
  }
}
