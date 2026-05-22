// ═══════════════════════════════════════════════════════════
// db.js — Banco de dados SQLite local
// Armazena usuários, itens Pluggy e transações sincronizadas
// ═══════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'financeos.db'));

// Ativa WAL para melhor performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── CRIAR TABELAS ───────────────────────────────────────
db.exec(`
  -- Usuários do sistema
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    avatar_color TEXT   DEFAULT '#6366f1',
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  -- Conexões bancárias via Pluggy (cada banco conectado = 1 item)
  CREATE TABLE IF NOT EXISTS pluggy_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id         TEXT    NOT NULL UNIQUE,   -- ID do item na Pluggy
    institution_name TEXT   NOT NULL,           -- Nome do banco (ex: "Nubank")
    institution_id  INTEGER,                    -- ID da instituição na Pluggy
    status          TEXT    DEFAULT 'UPDATING', -- UPDATED | UPDATING | LOGIN_ERROR
    last_sync       TEXT,
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  -- Contas bancárias (corrente, poupança, cartão)
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id         INTEGER REFERENCES pluggy_items(id) ON DELETE SET NULL,
    pluggy_account_id TEXT,                     -- ID da conta na Pluggy
    name            TEXT    NOT NULL,
    type            TEXT    NOT NULL,           -- BANK | CREDIT
    subtype         TEXT,                       -- CHECKING | SAVINGS | CREDIT_CARD
    number          TEXT,                       -- Últimos 4 dígitos
    balance         REAL    DEFAULT 0,
    credit_limit    REAL    DEFAULT 0,
    color           TEXT    DEFAULT '#6366f1',
    manual          INTEGER DEFAULT 0,          -- 1 = adicionada manualmente
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  -- Transações bancárias e de cartão
  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
    pluggy_txn_id   TEXT    UNIQUE,             -- ID da transação na Pluggy (evita duplicatas)
    description     TEXT    NOT NULL,
    amount          REAL    NOT NULL,
    type            TEXT    NOT NULL,           -- DEBIT | CREDIT
    category        TEXT,                       -- Categoria detectada
    source          TEXT    NOT NULL,           -- 'bank' | 'cc'
    date            TEXT    NOT NULL,
    account_name    TEXT,
    card_name       TEXT,
    imported_from   TEXT    DEFAULT 'pluggy',   -- 'pluggy' | 'manual' | 'csv'
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  -- Configurações por usuário
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme         INTEGER DEFAULT 0,
    login_bg      INTEGER DEFAULT 0,
    notif_budget  INTEGER DEFAULT 1,
    notif_weekly  INTEGER DEFAULT 1,
    notif_big_txn INTEGER DEFAULT 0,
    sync_daily    INTEGER DEFAULT 1,
    sync_on_open  INTEGER DEFAULT 0,
    last_sync     TEXT
  );

  -- Log de sincronizações
  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    item_id     INTEGER REFERENCES pluggy_items(id) ON DELETE CASCADE,
    status      TEXT,   -- 'success' | 'error'
    txn_count   INTEGER DEFAULT 0,
    message     TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
`);

module.exports = db;
