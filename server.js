import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust in production for security
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const dbFile = join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

await db.read();
db.data ||= { users: {}, devices: {} };
await db.write();

// Serve static files (including admin.html in /public)
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Admin password — change to strong secret or use env var in production
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'YourStrongAdminPassword!';

// Helper to get all users with keys
function getAllUsers() {
  return Object.entries(db.data.users).map(([userKey, u]) => ({
    userKey,
    username: u.username,
    balance: u.balance,
    deviceId: u.deviceId
  }));
}

// Emit updated user list to all connected admins
async function emitUserListToAdmins() {
  await db.read();
  adminIo.emit('userList', getAllUsers());
}

// Admin Socket.IO namespace
const adminIo = io.of('/admin');
adminIo.on('connection', (socket) => {
  console.log('Admin connected:', socket.id);
  emitUserListToAdmins();
});

// Admin REST API endpoints with adminSecret protection

app.get('/admin/users', async (req, res) => {
  const { adminSecret } = req.query;
  if (adminSecret !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Unauthorized' });
  }
  await db.read();
  return res.json({ success: true, users: getAllUsers() });
});

app.get('/admin/get-balance', async (req, res) => {
  const { userKey, adminSecret } = req.query;
  if (adminSecret !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Unauthorized' });
  }
  await db.read();
  const user = db.data.users[userKey];
  if (!user) return res.json({ success: false, error: 'User not found' });
  return res.json({ success: true, userKey, username: user.username, balance: user.balance });
});

app.post('/admin/update-balance', async (req, res) => {
  const { userKey, balance, adminSecret } = req.body;
  if (adminSecret !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Unauthorized' });
  }
  await db.read();
  if (!db.data.users[userKey]) return res.json({ success: false, error: 'User not found' });

  const newBalance = Number(balance);
  if (isNaN(newBalance) || newBalance < 0) {
    return res.json({ success: false, error: 'Invalid balance value' });
  }

  db.data.users[userKey].balance = newBalance;
  try {
    await db.write();
    await emitUserListToAdmins();
    return res.json({ success: true });
  } catch {
    return res.json({ success: false, error: "Failed to write to database." });
  }
});

app.post('/admin/delete-user', async (req, res) => {
  const { userKey, adminSecret } = req.body;
  if (adminSecret !== ADMIN_PASSWORD) {
    return res.json({ success: false, error: 'Unauthorized' });
  }
  await db.read();
  if (!db.data.users[userKey]) return res.json({ success: false, error: 'User not found' });

  const deviceId = db.data.users[userKey].deviceId;
  if (deviceId && db.data.devices[deviceId] === userKey) {
    delete db.data.devices[deviceId];
  }
  delete db.data.users[userKey];

  try {
    await db.write();
    await emitUserListToAdmins();
    return res.json({ success: true });
  } catch {
    return res.json({ success: false, error: "Failed to write to database." });
  }
});

// --- Game logic and Socket.IO player namespace (unchanged) ---
// [Include your existing game logic and player socket.io handlers here]
// For brevity, omitted here but keep your full game logic as before.

server.listen(PORT, () => {
  console.log(`✅ Bingo server running at http://localhost:${PORT}`);
});
