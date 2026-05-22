// ═══════════════════════════════════════════════════════════
// server.js — Servidor principal FinanceOS Pro
// Backend Node.js + Express + Pluggy Open Finance
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const pluggy = require('./pluggy');
const { syncAllForUser, syncItem, startCronJobs } = require('./sync');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-mude-em-producao';

// ─── MIDDLEWARES ─────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());

// Rate limiting — protege contra brute force
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Muitas tentativas. Aguarde 15 minutos.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 100 });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// ─── AUTH MIDDLEWARE ─────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// ════════════════════════════════════════════════════════
// ROTAS DE AUTENTICAÇÃO
// ════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, avatarColor } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    'INSERT INTO users (name, email, password, avatar_color) VALUES (?, ?, ?, ?)'
  ).run(name, email.toLowerCase(), hash, avatarColor || '#6366f1');

  // Criar settings padrão
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);

  const token = jwt.sign({ id: result.lastInsertRowid, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: result.lastInsertRowid, name, email: email.toLowerCase(), avatarColor } });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'E-mail não encontrado' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Senha incorreta' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatarColor: user.avatar_color } });
});

// GET /api/auth/me
app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, avatar_color FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ════════════════════════════════════════════════════════
// ROTAS PLUGGY — Conexão bancária
// ════════════════════════════════════════════════════════

// GET /api/pluggy/connect-token
// Gera token para abrir o widget de conexão bancária
app.get('/api/pluggy/connect-token', auth, async (req, res) => {
  try {
    const token = await pluggy.createConnectToken({
      userId: req.user.id,
      itemId: req.query.itemId || null,
    });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pluggy/item
// Salva um item (banco conectado) após o widget ser fechado
app.post('/api/pluggy/item', auth, async (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId obrigatório' });

  try {
    const item = await pluggy.getItem(itemId);
    const conn = item.connector || {};

    // Salvar item no banco
    const existing = db.prepare('SELECT id FROM pluggy_items WHERE item_id = ?').get(itemId);
    let dbItemId;

    if (existing) {
      db.prepare(`
        UPDATE pluggy_items SET status = ?, last_sync = datetime('now') WHERE item_id = ?
      `).run(item.status, itemId);
      dbItemId = existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO pluggy_items (user_id, item_id, institution_name, institution_id, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.user.id, itemId, conn.name || 'Banco', conn.id || null, item.status);
      dbItemId = result.lastInsertRowid;
    }

    // Sincronizar imediatamente
    const dbItem = db.prepare('SELECT * FROM pluggy_items WHERE id = ?').get(dbItemId);
    const syncResult = await syncItem(dbItem, req.user.id);

    res.json({
      success: true,
      bank: conn.name,
      newTransactions: syncResult.txnCount,
      error: syncResult.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pluggy/items
// Lista todos os bancos conectados do usuário
app.get('/api/pluggy/items', auth, (req, res) => {
  const items = db.prepare(`
    SELECT pi.*, 
      (SELECT COUNT(*) FROM bank_accounts ba WHERE ba.item_id = pi.id) as account_count,
      (SELECT COUNT(*) FROM sync_log sl WHERE sl.item_id = pi.id AND sl.status = 'error' ORDER BY sl.created_at DESC LIMIT 1) as has_error
    FROM pluggy_items pi WHERE pi.user_id = ?
    ORDER BY pi.institution_name
  `).all(req.user.id);
  res.json(items);
});

// DELETE /api/pluggy/items/:id
app.delete('/api/pluggy/items/:id', auth, async (req, res) => {
  const item = db.prepare('SELECT * FROM pluggy_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });

  try {
    await pluggy.deleteItem(item.item_id);
  } catch (e) {
    console.warn('Erro ao deletar item na Pluggy:', e.message);
  }

  db.prepare('DELETE FROM pluggy_items WHERE id = ?').run(item.id);
  res.json({ success: true });
});

// POST /api/pluggy/sync
// Sincronizar todos os bancos manualmente
app.post('/api/pluggy/sync', auth, async (req, res) => {
  try {
    const result = await syncAllForUser(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pluggy/connectors
// Lista bancos disponíveis para conexão
app.get('/api/pluggy/connectors', auth, async (req, res) => {
  try {
    const connectors = await pluggy.getConnectors();
    res.json(connectors.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ROTAS DE CONTAS BANCÁRIAS
// ════════════════════════════════════════════════════════

// GET /api/accounts
app.get('/api/accounts', auth, (req, res) => {
  const accounts = db.prepare(`
    SELECT ba.*, pi.institution_name, pi.status as sync_status
    FROM bank_accounts ba
    LEFT JOIN pluggy_items pi ON pi.id = ba.item_id
    WHERE ba.user_id = ?
    ORDER BY ba.type, ba.name
  `).all(req.user.id);
  res.json(accounts);
});

// POST /api/accounts (conta manual)
app.post('/api/accounts', auth, (req, res) => {
  const { bank, type, subtype, number, balance, color } = req.body;
  if (!bank) return res.status(400).json({ error: 'Nome do banco obrigatório' });

  const result = db.prepare(`
    INSERT INTO bank_accounts (user_id, name, type, subtype, number, balance, color, manual)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(req.user.id, bank, type || 'BANK', subtype || 'CHECKING', number || '****', balance || 0, color || '#6366f1');

  res.json({ id: result.lastInsertRowid, bank, type, balance });
});

// PATCH /api/accounts/:id
app.patch('/api/accounts/:id', auth, (req, res) => {
  const { balance, color, name } = req.body;
  const acc = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });

  if (balance !== undefined) db.prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?').run(balance, acc.id);
  if (color) db.prepare('UPDATE bank_accounts SET color = ? WHERE id = ?').run(color, acc.id);
  if (name) db.prepare('UPDATE bank_accounts SET name = ? WHERE id = ?').run(name, acc.id);

  res.json({ success: true });
});

// DELETE /api/accounts/:id
app.delete('/api/accounts/:id', auth, (req, res) => {
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ? AND manual = 1').get(req.params.id, req.user.id);
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada ou sincronizada via API' });
  db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(acc.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
// ROTAS DE TRANSAÇÕES
// ════════════════════════════════════════════════════════

// GET /api/transactions
app.get('/api/transactions', auth, (req, res) => {
  const { source, from, to, category, type, limit = 500, offset = 0 } = req.query;

  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [req.user.id];

  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (from)   { sql += ' AND date >= ?'; params.push(from); }
  if (to)     { sql += ' AND date <= ?'; params.push(to); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (type)   { sql += ' AND type = ?'; params.push(type); }

  sql += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const txns = db.prepare(sql).all(...params);
  const total = db.prepare(
    sql.replace('SELECT *', 'SELECT COUNT(*) as cnt').replace(' ORDER BY date DESC LIMIT ? OFFSET ?', '')
  ).get(...params.slice(0, -2))?.cnt || 0;

  res.json({ transactions: txns, total });
});

// POST /api/transactions (lançamento manual)
app.post('/api/transactions', auth, (req, res) => {
  const { description, amount, type, category, source, date, account_name, card_name } = req.body;
  if (!description || !amount || !type || !source) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });

  const result = db.prepare(`
    INSERT INTO transactions (user_id, description, amount, type, category, source, date, account_name, card_name, imported_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
  `).run(req.user.id, description, Math.abs(amount), type, category || 'Outros', source, date || new Date().toISOString().split('T')[0], account_name || null, card_name || null);

  res.json({ id: result.lastInsertRowid });
});

// DELETE /api/transactions/:id
app.delete('/api/transactions/:id', auth, (req, res) => {
  const txn = db.prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!txn) return res.status(404).json({ error: 'Transação não encontrada' });
  db.prepare('DELETE FROM transactions WHERE id = ?').run(txn.id);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
// ROTAS DE DASHBOARD / RELATÓRIOS
// ════════════════════════════════════════════════════════

// GET /api/dashboard
app.get('/api/dashboard', auth, (req, res) => {
  const uid = req.user.id;
  const from = req.query.from || daysAgo(30);
  const to = req.query.to || today();

  const bankIncome = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND source='bank' AND type='receita' AND date BETWEEN ? AND ?`).get(uid, from, to).total;
  const bankExpense = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND source='bank' AND type='despesa' AND date BETWEEN ? AND ?`).get(uid, from, to).total;
  const ccSpend = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND source='cc' AND type='compra' AND date BETWEEN ? AND ?`).get(uid, from, to).total;
  const ccPayment = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND source='cc' AND type='pagamento' AND date BETWEEN ? AND ?`).get(uid, from, to).total;
  const totalBalance = db.prepare(`SELECT COALESCE(SUM(balance),0) as total FROM bank_accounts WHERE user_id=? AND type='BANK'`).get(uid).total;

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) as total, source, COUNT(*) as count
    FROM transactions WHERE user_id=? AND type IN ('despesa','compra') AND date BETWEEN ? AND ?
    GROUP BY category, source ORDER BY total DESC
  `).all(uid, from, to);

  const monthlyEvolution = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
      SUM(CASE WHEN type='receita' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type='despesa' THEN amount ELSE 0 END) as bank_expense,
      SUM(CASE WHEN type='compra' THEN amount ELSE 0 END) as cc_spend
    FROM transactions WHERE user_id=? AND date >= ?
    GROUP BY month ORDER BY month
  `).all(uid, daysAgo(180));

  const lastSync = db.prepare("SELECT last_sync FROM user_settings WHERE user_id=?").get(uid)?.last_sync;
  const connectedBanks = db.prepare("SELECT COUNT(*) as cnt FROM pluggy_items WHERE user_id=? AND status='UPDATED'").get(uid).cnt;

  res.json({
    summary: { bankIncome, bankExpense, ccSpend, ccPayment, totalBalance, savingRate: bankIncome > 0 ? ((bankIncome - bankExpense - ccSpend) / bankIncome * 100).toFixed(1) : 0 },
    byCategory,
    monthlyEvolution,
    lastSync,
    connectedBanks,
  });
});

// GET /api/sync/log
app.get('/api/sync/log', auth, (req, res) => {
  const logs = db.prepare(`
    SELECT sl.*, pi.institution_name
    FROM sync_log sl
    JOIN pluggy_items pi ON pi.id = sl.item_id
    WHERE sl.user_id = ?
    ORDER BY sl.created_at DESC LIMIT 20
  `).all(req.user.id);
  res.json(logs);
});

// GET /api/settings
app.get('/api/settings', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  res.json(s || {});
});

// PATCH /api/settings
app.patch('/api/settings', auth, (req, res) => {
  const { theme, login_bg, notif_budget, notif_weekly, notif_big_txn, sync_daily, sync_on_open } = req.body;
  db.prepare(`
    INSERT INTO user_settings (user_id, theme, login_bg, notif_budget, notif_weekly, notif_big_txn, sync_daily, sync_on_open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme, login_bg = excluded.login_bg,
      notif_budget = excluded.notif_budget, notif_weekly = excluded.notif_weekly,
      notif_big_txn = excluded.notif_big_txn, sync_daily = excluded.sync_daily,
      sync_on_open = excluded.sync_on_open
  `).run(req.user.id, theme || 0, login_bg || 0, notif_budget ? 1 : 0, notif_weekly ? 1 : 0, notif_big_txn ? 1 : 0, sync_daily ? 1 : 0, sync_on_open ? 1 : 0);
  res.json({ success: true });
});

// ─── HEALTH CHECK ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.0.0',
    timestamp: new Date().toISOString(),
    pluggy: !!process.env.PLUGGY_CLIENT_ID ? 'configured' : 'not configured',
  });
});

// ─── HELPERS ─────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }

// ─── INICIAR SERVIDOR ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         FinanceOS Pro — Backend v4.0         ║
╠══════════════════════════════════════════════╣
║  Servidor:  http://localhost:${PORT}            ║
║  Pluggy:    ${process.env.PLUGGY_CLIENT_ID ? '✓ Configurado           ' : '✗ Configure o .env      '}║
║  Banco:     financeos.db (SQLite)            ║
╚══════════════════════════════════════════════╝
  `);
  startCronJobs();
});

module.exports = app;
