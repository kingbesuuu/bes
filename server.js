// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import crypto from 'node:crypto';

// Setup file paths
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, 'db.json');

// Setup database
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

// Init DB if needed
await db.read();
db.data ||= { users: {}, devices: {} };
await db.write();

// Setup app and middleware
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public'))); // Serves admin.html, socket.io.js, etc.

// Config
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'YourStrongAdminPassword!';

// Helper: Get all users
function getAllUsers() {
  return Object.entries(db.data.users).map(([userKey, u]) => ({
    userKey,
    username: u.username,
    balance: u.balance,
    deviceId: u.deviceId,
  }));
}

// Emit user list to admins
async function emitUserListToAdmins() {
  await db.read();
  adminIo.emit('userList', getAllUsers());
}

// --- Real-Time User Socket Tracking ---
const userSockets = {}; // deviceId -> socket.id

io.on('connection', (socket) => {
  socket.on('identify', ({ deviceId }) => {
    if (deviceId) {
      userSockets[deviceId] = socket.id;
      // Optionally: Remove deviceId from userSockets on disconnect
      socket.on('disconnect', () => {
        if (userSockets[deviceId] === socket.id) {
          delete userSockets[deviceId];
        }
      });
    }
  });
});

// Admin namespace socket.io
const adminIo = io.of('/admin');
adminIo.on('connection', (socket) => {
  console.log('[Admin connected]', socket.id);
  emitUserListToAdmins();
});

// --- User Registration Endpoint ---
app.post('/register', async (req, res) => {
  try {
    const { username, deviceId } = req.body;

    if (!username || !deviceId) {
      return res.status(400).json({ success: false, error: 'Username and deviceId are required.' });
    }

    await db.read();

    // Prevent duplicate registration for the same device
    if (db.data.devices[deviceId]) {
      return res.status(400).json({ success: false, error: 'Device already registered.' });
    }

    // Generate a unique userKey
    const userKey = crypto.randomBytes(16).toString('hex');

    db.data.users[userKey] = { username, balance: 0, deviceId };
    db.data.devices[deviceId] = userKey;
    await db.write();

    // Emit updated user list to all admin clients
    await emitUserListToAdmins();

    res.json({ success: true, userKey });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- Admin API Routes ---

app.get('/admin/users', async (req, res) => {
  const { adminSecret } = req.query;
  if (adminSecret !== ADMIN_PASSWORD)
    return res.json({ success: false, error: 'Unauthorized' });

  await db.read();
  res.json({ success: true, users: getAllUsers() });
});

app.get('/admin/get-balance', async (req, res) => {
  const { userKey, adminSecret } = req.query;
  if (adminSecret !== ADMIN_PASSWORD)
    return res.json({ success: false, error: 'Unauthorized' });

  await db.read();
  const user = db.data.users[userKey];
  if (!user) return res.json({ success: false, error: 'User not found' });

  res.json({ success: true, userKey, username: user.username, balance: user.balance });
});

app.post('/admin/update-balance', async (req, res) => {
  const { userKey, balance, adminSecret } = req.body;
  if (adminSecret !== ADMIN_PASSWORD)
    return res.json({ success: false, error: 'Unauthorized' });

  await db.read();
  const user = db.data.users[userKey];
  if (!user) return res.json({ success: false, error: 'User not found' });

  const newBalance = Number(balance);
  if (isNaN(newBalance) || newBalance < 0)
    return res.json({ success: false, error: 'Invalid balance value' });

  user.balance = newBalance;
  await db.write();
  await emitUserListToAdmins();

  // --- Real-Time Balance Update to User ---
  const socketId = userSockets[user.deviceId];
  if (socketId) {
    io.to(socketId).emit('balanceUpdate', newBalance);
  }

  res.json({ success: true });
});

app.post('/admin/delete-user', async (req, res) => {
  const { userKey, adminSecret } = req.body;
  if (adminSecret !== ADMIN_PASSWORD)
    return res.json({ success: false, error: 'Unauthorized' });

  await db.read();
  const user = db.data.users[userKey];
  if (!user) return res.json({ success: false, error: 'User not found' });

  const deviceId = user.deviceId;
  if (deviceId && db.data.devices[deviceId] === userKey) {
    delete db.data.devices[deviceId];
  }

  delete db.data.users[userKey];
  await db.write();
  await emitUserListToAdmins();
  res.json({ success: true });
});

// Serve admin.html at `/admin`
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

// Fallback for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- Game logic and player namespace (add your own below) ---
// const playerIo = io.of('/game');
// playerIo.on('connection', socket => { ... });

server.listen(PORT, () => {
  console.log(`✅ Bingo server running at http://localhost:${PORT}`);
});
