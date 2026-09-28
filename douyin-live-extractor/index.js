import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRoomStreams, InputError } from './public/douyin.js';
import { relayTarget, openUpstream, pipeSockets } from './public/danmaku-relay.js';

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
  password: 'password123',
  requireLogin: true
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

const REQUIRE_LOGIN = config.requireLogin !== false;

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Login Endpoint
app.get('/api/config', (req, res) => {
  res.json({ requireLogin: REQUIRE_LOGIN });
});

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
  if (!REQUIRE_LOGIN) {
    return next();
  }

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
    console.log(`Processing input: ${url}`);
    const streamData = await getRoomStreams(url);

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
    if (error instanceof InputError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    console.error('Error processing request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(REQUIRE_LOGIN ? `Log in via the web interface to generate a token.` : `Login is disabled by config.`);
});

// Danmaku relay (/api/danmaku): browsers that cannot send Douyin its cookie get the room's push websocket
// through this server, which connects with its own visitor cookie (see public/danmaku-relay.js).
const relayServer = new WebSocketServer({ noServer: true });

function connectDouyin(url, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      socket.onopen = socket.onerror = socket.onclose = null;
      resolve(socket);
    };
    socket.onerror = socket.onclose = () => resolve(null);
  });
}

server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/danmaku') return reject('404 Not Found');

  if (REQUIRE_LOGIN) {
    try {
      jwt.verify(url.searchParams.get('token') || req.headers['x-api-key'] || '', JWT_SECRET);
    } catch (err) {
      return reject('401 Unauthorized');
    }
  }

  let target;
  try {
    target = relayTarget(url.searchParams);
  } catch (error) {
    return reject('400 Bad Request');
  }

  // Connect to Douyin first, so the browser only sees an open socket when danmaku can flow.
  let douyin = null;
  try {
    douyin = await openUpstream(target, connectDouyin);
  } catch (error) {
    console.error('Danmaku relay:', error.message);
  }
  if (!douyin) return reject('502 Bad Gateway');
  if (socket.destroyed) return douyin.close();

  // A handshake that ws rejects closes the socket without piping; Douyin's side is closed with it.
  let piped = false;
  socket.once('close', () => { if (!piped) douyin.close(); });
  relayServer.handleUpgrade(req, socket, head, (client) => {
    piped = true;
    client.binaryType = 'arraybuffer';
    pipeSockets(client, douyin);
  });
});

server.on('error', (e) => {
  console.error('Server error:', e);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
