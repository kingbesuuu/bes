// deleteAllUsers.js
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join } from 'node:path';

// Adjust this path if needed
const dbFile = join(process.cwd(), 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

async function deleteAllUsers() {
  await db.read();
  db.data.users = {};
  db.data.devices = {};
  await db.write();
  console.log('All users and devices deleted.');
}

deleteAllUsers();
