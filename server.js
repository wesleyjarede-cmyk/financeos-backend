// server.js — FinanceOS Pro Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pluggy = require('./pluggy');
const db = require('./db');
const { syncAllForUser, syncItem, startCronJobs } = require('./sync');
 
const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-mude-em-producao';
 
// MIDDLEWARES
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);
 
// AUTH MIDDLEWARE
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Token required' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}
 
// REGISTER
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatorios' });
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (exists) return res.status(409).json({ error: 'Email ja cadastrado' });
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)').run(name, email, hash);
    const token = jwt.sign({ id: r.lastInsertRowid, email, name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: r.lastInsertRowid, name, email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
// LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) return res.status(401).json({ error: 'Credenciais invalidas' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais invalidas' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
// PLUGGY CONNECT TOKEN
app.post('/api/pluggy/connect-token', auth, async (req, res) => {
  try {
    const { itemId } = req.body;
    const token = await pluggy.createConnectToken({ itemId, userId: req.user.id });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
// PLUGGY ITEMS
app.get('/api/pluggy/items', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM pluggy_items WHERE user_id=?').all(req.user.id);
  res.json(items);
});
 
app.post('/api/pluggy/items', auth, async (req, res) => {
  try {
    const { itemId } = req.body;
    const item = await pluggy.getItem(itemId);
    const existing = db.prepare('SELECT id FROM pluggy_items WHERE item_id=? AND user_id=?').get(itemId, req.user.id);
    if (!existing) {
      db.prepare('INSERT INTO pluggy_items (user_id,item_id,connector_name,status) VALUES (?,?,?,?)').run(
        req.user.id, itemId, item.connector?.name || 'Banco', item.status
      );
    }
    const count = await syncItem(req.user.id, itemId);
    res.json({ success: true, synced: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
app.delete('/api/pluggy/items/:itemId', auth, async (req, res) => {
  try {
    await pluggy.deleteItem(req.params.itemId);
    db.prepare('DELETE FROM pluggy_items WHERE item_id=? AND user_id=?').run(req.params.itemId, req.user.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
// SYNC
app.post('/api/sync', auth, async (req, res) => {
  try {
    const count = await syncAllForUser(req.user.id);
    res.json({ synced: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
// TRANSACTIONS
app.get('/api/transactions', auth, (req, res) => {
  const { source, category, from, to, limit = 200 } = req.query;
  let q = 'SELECT * FROM transactions WHERE user_id=?';
  const p = [req.user.id];
  if (source) { q += ' AND source=?'; p.push(source); }
  if (category) { q += ' AND category=?'; p.push(category); }
  if (from) { q += ' AND date>=?'; p.push(from); }
  if (to) { q += ' AND date<=?'; p.push(to); }
  q += ' ORDER BY date DESC LIMIT ?'; p.push(Number(limit));
  res.json(db.prepare(q).all(...p));
});
 
app.post('/api/transactions', auth, (req, res) => {
  try {
    const { description, amount, type, category, source, date, account_name, card_name } = req.body;
    const r = db.prepare(
      'INSERT INTO transactions (user_id,description,amount,type,category,source,date,account_name,card_name,imported_from) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(req.user.id, description, amount, type, category, source || 'manual', date, account_name, card_name, 'manual');
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
app.delete('/api/transactions/:id', auth, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});
 
// ACCOUNTS
app.get('/api/accounts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts WHERE user_id=?').all(req.user.id));
});
 
// WEBHOOK
app.get('/api/webhook', (req, res) => {
  res.json({ status: 'ok', service: 'FinanceOS Pro Webhook', timestamp: new Date().toISOString() });
});
 
app.post('/api/webhook', (req, res) => {
  const { event, itemId } = req.body || {};
  console.log('[WEBHOOK] ' + event + ' | Item: ' + itemId);
  try {
    if (event === 'item/updated') {
      db.prepare("UPDATE pluggy_items SET status='UPDATED', last_sync=datetime('now') WHERE item_id=?").run(itemId);
    }
    if (event === 'item/login_error') {
      db.prepare("UPDATE pluggy_items SET status='LOGIN_ERROR' WHERE item_id=?").run(itemId);
    }
  } catch(e) { console.error('[WEBHOOK]', e.message); }
  res.json({ received: true });
});
 
// HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});
 
// START
app.listen(PORT, () => {
  console.log('FinanceOS Pro running on port ' + PORT);
  startCronJobs();
});
