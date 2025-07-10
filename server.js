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
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const dbFile = join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);
await db.read();
db.data ||= { users: {}, devices: {} };
await db.write();

// === Serve static files from /public ===
app.use(express.static(join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- Admin endpoints ---
const ADMIN_PASSWORD = 'your_admin_password'; // CHANGE THIS!

app.get('/admin/get-balance', async (req, res) => {
  const { username, adminSecret } = req.query;
  if (adminSecret !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' });
  const user = Object.values(db.data.users).find(u => u.username === username);
  if (!user) return res.json({ success: false, error: 'User not found' });
  return res.json({ success: true, balance: user.balance });
});

app.post('/admin/update-balance', async (req, res) => {
  const { username, balance, adminSecret } = req.body;
  if (adminSecret !== ADMIN_PASSWORD) return res.json({ success: false, error: 'Unauthorized' });
  const userKey = Object.keys(db.data.users).find(k => db.data.users[k].username === username);
  if (!userKey) return res.json({ success: false, error: 'User not found' });
  db.data.users[userKey].balance = Number(balance);
  await db.write();
  return res.json({ success: true });
});

// === Game State ===
let players = {};
let calledNumbers = new Set();
let lockedSeeds = [];
let allCallPool = [];
let callInterval = null;
let winner = null;
let balanceMap = {};
let currentCards = {};
let playerUserKeys = {};
let playerDevices = {};
let countdown = 60;
let countdownInterval = null;
let gameStarted = false;

function shuffle(array) {
  let m = array.length, t, i;
  while (m) {
    i = Math.floor(Math.random() * m--);
    t = array[m]; array[m] = array[i]; array[i] = t;
  }
  return array;
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateCard(seed) {
  const rand = mulberry32(seed);
  const ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
  const card = [];
  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const nums = new Set();
    while (nums.size < 5) {
      const n = Math.floor(rand() * (max - min + 1)) + min;
      nums.add(n);
    }
    card.push([...nums]);
  }
  card[2][2] = 'FREE';
  return card;
}

function checkBingo(card, markedSet) {
  for (let r = 0; r < 5; r++) {
    if (card.every((col) => col[r] === 'FREE' || markedSet.has(col[r]))) return true;
  }
  for (let c = 0; c < 5; c++) {
    if (card[c].every((val) => val === 'FREE' || markedSet.has(val))) return true;
  }
  if ([0, 1, 2, 3, 4].every(i => card[i][i] === 'FREE' || markedSet.has(card[i][i]))) return true;
  if ([0, 1, 2, 3, 4].every(i => card[i][4 - i] === 'FREE' || markedSet.has(card[i][4 - i]))) return true;
  return false;
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
    io.emit('countdown', 0);
  }
  countdown = 60;
}

function startCountdown() {
  countdown = 60;
  io.emit('countdown', countdown);
  countdownInterval = setInterval(() => {
    if (Object.keys(players).length < 2) {
      stopCountdown();
      return;
    }
    countdown--;
    io.emit('countdown', countdown);
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      startCallingNumbers();
      io.emit('gameStarted', { playerCount: Object.keys(players).length });
      gameStarted = true;
    }
  }, 1000);
}

function startCallingNumbers() {
  allCallPool = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
  callInterval = setInterval(() => {
    if (allCallPool.length === 0 || winner) {
      clearInterval(callInterval);
      callInterval = null;
      return;
    }
    const number = allCallPool.shift();
    calledNumbers.add(number);
    io.emit('numberCalled', number);
  }, 5000);
}

function resetGame() {
  calledNumbers = new Set();
  lockedSeeds = [];
  winner = null;
  allCallPool = [];
  gameStarted = false;
  for (const id in players) {
    if (players[id].seed) lockedSeeds.push(players[id].seed);
  }
  io.emit('reset');
}

// === Socket.IO ===
io.on('connection', (socket) => {
  socket.on('register', async ({ username, id, seed, deviceId }) => {
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(username) || !id || !deviceId) {
      socket.emit('blocked', "Only real Telegram usernames and device IDs are allowed.");
      return;
    }
    // One device, one account, one card per game
    if (Object.values(playerDevices).includes(deviceId)) {
      socket.emit('blocked', "You are already playing from this device.");
      return;
    }
    // Only one card per user per game
    if (Object.values(players).some(p => p.username === username)) {
      socket.emit('blocked', "You already picked a card.");
      return;
    }
    if (lockedSeeds.includes(seed)) {
      socket.emit('blocked', "Card already picked by another player.");
      return;
    }
    playerUserKeys[socket.id] = `${username}_${id}`;
    playerDevices[socket.id] = deviceId;
    players[socket.id] = { username, id, seed, deviceId };
    lockedSeeds.push(seed);
    currentCards[socket.id] = generateCard(seed);

    // Welcome gift only once per device or username
    let isNew = false;
    let userKey = `${username}_${id}`;
    if (!db.data.users[userKey]) {
      db.data.users[userKey] = { balance: 10, username, id, deviceId };
      db.data.devices[deviceId] = userKey;
      isNew = true;
      await db.write();
    } else if (!db.data.devices[deviceId]) {
      db.data.devices[deviceId] = userKey;
      await db.write();
    }

    // Deduct entry fee (10) if not already deducted for this round
    if (db.data.users[userKey].balance < 10) {
      socket.emit('blocked', "❌ You need at least 10 balance to join the game.");
      delete players[socket.id];
      delete currentCards[socket.id];
      delete playerUserKeys[socket.id];
      delete playerDevices[socket.id];
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
      io.emit('playerCount', Object.keys(players).length);
      return;
    }
    db.data.users[userKey].balance -= 10;
    await db.write();

    balanceMap[socket.id] = db.data.users[userKey].balance;
    socket.emit('balanceUpdate', balanceMap[socket.id]);
    socket.emit('welcomeGift', isNew);
    io.emit('playerCount', Object.keys(players).length);
    io.emit('lockedSeeds', lockedSeeds);

    if (
      Object.keys(players).length >= 2 &&
      !countdownInterval &&
      !gameStarted
    ) {
      startCountdown();
    }
  });

  socket.on('balanceUpdate', async (newBalance) => {
    const userKey = playerUserKeys[socket.id];
    if (userKey) {
      db.data.users[userKey].balance = newBalance;
      await db.write();
    }
  });

  socket.emit('init', {
    calledNumbers: Array.from(calledNumbers),
    balance: balanceMap[socket.id] || 0,
    lockedSeeds
  });

  socket.on('checkBingo', async (markedArr) => {
    if (!currentCards[socket.id] || winner) return;
    const card = currentCards[socket.id];
    const markedSet = new Set(markedArr.map(Number));
    const userKey = playerUserKeys[socket.id];
    const valid = Array.from(markedSet).every(n => calledNumbers.has(n) || n === 'FREE');
    if (!valid) {
      socket.emit('blocked', "Not yet!");
      return;
    }
    if (checkBingo(card, markedSet)) {
      const playerCount = Object.keys(players).length;
      const winPoint = Math.floor(playerCount * 10 * 0.8);
      winner = { username: players[socket.id].username, card };

      db.data.users[userKey].balance += winPoint;
      await db.write();

      balanceMap[socket.id] = db.data.users[userKey].balance;
      socket.emit('balanceUpdate', balanceMap[socket.id]);

      if (callInterval) {
        clearInterval(callInterval);
        callInterval = null;
      }

      io.emit('winner', { username: players[socket.id].username, card, winPoint });
      io.emit('stopCalling');

      setTimeout(resetGame, 15000);
    } else {
      socket.emit('blocked', "Not yet!");
    }
  });

  socket.on('playAgain', () => {
    socket.emit('reset');
  });

  socket.on('endGame', () => {
    const seed = players[socket.id]?.seed;
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUserKeys[socket.id];
    delete playerDevices[socket.id];
    if (seed) {
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
    }
    io.emit('playerCount', Object.keys(players).length);
    if (Object.keys(players).length < 2) {
      stopCountdown();
    }
  });

  socket.on('disconnect', () => {
    const seed = players[socket.id]?.seed;
    delete players[socket.id];
    delete currentCards[socket.id];
    delete playerUserKeys[socket.id];
    delete playerDevices[socket.id];
    if (seed) {
      lockedSeeds = lockedSeeds.filter(s => s !== seed);
      io.emit('lockedSeeds', lockedSeeds);
    }
    io.emit('playerCount', Object.keys(players).length);
    if (Object.keys(players).length < 2) {
      stopCountdown();
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Bingo server running at http://localhost:${PORT}`);
});
