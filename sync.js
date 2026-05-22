// ═══════════════════════════════════════════════════════════
// sync.js — Motor de sincronização automática
// Roda diariamente e sincroniza todos os bancos conectados
// ═══════════════════════════════════════════════════════════
const cron = require('node-cron');
const db = require('./db');
const pluggy = require('./pluggy');

// ─── SINCRONIZAR UM ITEM ESPECÍFICO ──────────────────────
async function syncItem(pluggyItem, userId) {
  console.log(`[SYNC] Sincronizando ${pluggyItem.institution_name} (item: ${pluggyItem.item_id})...`);

  let txnCount = 0;
  let errorMsg = null;

  try {
    // 1. Verificar status do item na Pluggy
    const item = await pluggy.getItem(pluggyItem.item_id);

    if (item.status === 'LOGIN_ERROR' || item.status === 'WAITING_USER_INPUT') {
      throw new Error(`Banco ${pluggyItem.institution_name} precisa de reautenticação`);
    }

    // 2. Buscar contas do item
    const accounts = await pluggy.getAccounts(pluggyItem.item_id);

    for (const account of accounts) {
      // 3. Atualizar ou criar conta no banco local
      const existingAccount = db.prepare(
        'SELECT id FROM bank_accounts WHERE pluggy_account_id = ?'
      ).get(account.id);

      let accountDbId;
      if (existingAccount) {
        // Atualizar saldo
        db.prepare(`
          UPDATE bank_accounts
          SET balance = ?, credit_limit = ?, name = ?
          WHERE pluggy_account_id = ?
        `).run(
          account.balance || 0,
          account.creditData?.creditLimit || 0,
          account.name,
          account.id
        );
        accountDbId = existingAccount.id;
      } else {
        // Criar nova conta
        const result = db.prepare(`
          INSERT INTO bank_accounts
            (user_id, item_id, pluggy_account_id, name, type, subtype, number, balance, credit_limit, color, manual)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          userId,
          pluggyItem.id,
          account.id,
          account.name,
          account.type,
          account.subtype || null,
          account.number ? account.number.slice(-4) : '****',
          account.balance || 0,
          account.creditData?.creditLimit || 0,
          pickColor(account.type)
        );
        accountDbId = result.lastInsertRowid;
      }

      // 4. Buscar transações dos últimos 90 dias
      const txns = await pluggy.getAllTransactions(account.id, {
        from: daysAgo(90),
        to: today(),
      });

      // 5. Inserir transações novas (ignorar duplicatas pelo pluggy_txn_id)
      const insertTxn = db.prepare(`
        INSERT OR IGNORE INTO transactions
          (user_id, account_id, pluggy_txn_id, description, amount, type, category,
           source, date, account_name, card_name, imported_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pluggy')
      `);

      const insertMany = db.transaction((txns) => {
        for (const t of txns) {
          const norm = pluggy.normalizeTransaction(t, account);
          const result = insertTxn.run(
            userId, accountDbId, norm.pluggy_txn_id,
            norm.description, norm.amount, norm.type,
            norm.category, norm.source, norm.date,
            norm.account_name, norm.card_name
          );
          if (result.changes > 0) txnCount++;
        }
      });

      insertMany(txns);
    }

    // 6. Atualizar status do item
    db.prepare(`
      UPDATE pluggy_items SET status = 'UPDATED', last_sync = datetime('now') WHERE id = ?
    `).run(pluggyItem.id);

    // 7. Registrar no log
    db.prepare(`
      INSERT INTO sync_log (user_id, item_id, status, txn_count, message)
      VALUES (?, ?, 'success', ?, ?)
    `).run(userId, pluggyItem.id, txnCount, `Sincronizado com sucesso. ${txnCount} novas transações.`);

    console.log(`[SYNC] ✓ ${pluggyItem.institution_name}: ${txnCount} novas transações`);

  } catch (err) {
    errorMsg = err.message;
    console.error(`[SYNC] ✗ ${pluggyItem.institution_name}:`, err.message);

    db.prepare(`
      INSERT INTO sync_log (user_id, item_id, status, txn_count, message)
      VALUES (?, ?, 'error', 0, ?)
    `).run(userId, pluggyItem.id, errorMsg);

    if (err.message.includes('reautenticação') || err.message.includes('LOGIN_ERROR')) {
      db.prepare(`UPDATE pluggy_items SET status = 'LOGIN_ERROR' WHERE id = ?`).run(pluggyItem.id);
    }
  }

  return { txnCount, error: errorMsg };
}

// ─── SINCRONIZAR TODOS OS BANCOS DE UM USUÁRIO ───────────
async function syncAllForUser(userId) {
  const items = db.prepare(
    "SELECT * FROM pluggy_items WHERE user_id = ? AND status != 'LOGIN_ERROR'"
  ).all(userId);

  if (!items.length) return { total: 0, items: [] };

  const results = [];
  let total = 0;

  for (const item of items) {
    const r = await syncItem(item, userId);
    results.push({ bank: item.institution_name, ...r });
    total += r.txnCount;
  }

  // Atualizar data de último sync do usuário
  db.prepare(`
    INSERT OR REPLACE INTO user_settings (user_id, last_sync)
    VALUES (?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET last_sync = datetime('now')
  `).run(userId);

  return { total, items: results };
}

// ─── SINCRONIZAR TODOS OS USUÁRIOS (cron diário) ─────────
async function syncAllUsers() {
  const users = db.prepare(`
    SELECT DISTINCT u.id, u.name
    FROM users u
    JOIN pluggy_items pi ON pi.user_id = u.id
    JOIN user_settings us ON us.user_id = u.id
    WHERE us.sync_daily = 1
  `).all();

  console.log(`[CRON] Iniciando sync diário para ${users.length} usuário(s)...`);

  for (const user of users) {
    console.log(`[CRON] Sincronizando usuário: ${user.name}`);
    await syncAllForUser(user.id);
  }

  console.log('[CRON] Sync diário concluído.');
}

// ─── AGENDAR CRON DIÁRIO (todo dia às 7h) ────────────────
function startCronJobs() {
  // Todos os dias às 7:00 da manhã
  cron.schedule('0 7 * * *', () => {
    console.log('[CRON] Disparando sincronização diária...');
    syncAllUsers().catch(err => console.error('[CRON] Erro:', err.message));
  }, { timezone: 'America/Sao_Paulo' });

  console.log('[CRON] Job diário agendado para 07:00 (horário de Brasília)');
}

// ─── HELPERS ─────────────────────────────────────────────
function today() {
  return new Date().toISOString().split('T')[0];
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function pickColor(type) {
  return type === 'CREDIT' ? '#f59e0b' : '#6366f1';
}

module.exports = { syncItem, syncAllForUser, syncAllUsers, startCronJobs };
