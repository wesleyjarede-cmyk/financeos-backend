
// db.js — SQLite database for FinanceOS Pro
const Database = require('better-sqlite3');
const path = require('path');
 
const db = new Database(path.join(__dirname, 'financeos.db'));
 
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
 
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#6366f1',
    created_at TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS pluggy_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL UNIQUE,
    connector_name TEXT NOT NULL,
    status TEXT DEFAULT 'UPDATING',
    last_sync TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pluggy_item_id TEXT,
    pluggy_account_id TEXT UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    balance REAL DEFAULT 0,
    currency TEXT DEFAULT 'BRL',
    last_four TEXT,
    credit_limit REAL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pluggy_txn_id TEXT UNIQUE,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    category TEXT DEFAULT 'Outros',
    source TEXT DEFAULT 'manual',
    date TEXT NOT NULL,
    account_name TEXT,
    card_name TEXT,
    imported_from TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
 
module.exports = db;
