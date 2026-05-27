// sync.js — Auto-sync engine for FinanceOS Pro
const cron = require('node-cron');
const db = require('./db');
const pluggy = require('./pluggy');
 
// Sync a single pluggy item for a user
async function syncItem(userId, itemId) {
  let txnCount = 0;
  try {
    const item = await pluggy.getItem(itemId);
 
    if (item.status === 'LOGIN_ERROR' || item.status === 'WAITING_USER_INPUT') {
      db.prepare("UPDATE pluggy_items SET status='LOGIN_ERROR' WHERE item_id=? AND user_id=?").run(itemId, userId);
      return 0;
    }
 
    const accounts = await pluggy.getAccounts(itemId);
 
    for (const account of accounts) {
      // Upsert account
      const existing = db.prepare('SELECT id FROM accounts WHERE pluggy_account_id=?').get(account.id);
      if (!existing) {
        db.prepare(
          'INSERT INTO accounts (user_id, pluggy_item_id, pluggy_account_id, name, type, balance, currency, last_four, credit_limit) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(
          userId, itemId, account.id,
          account.name, account.type,
          account.balance || 0,
          account.currencyCode || 'BRL',
          account.number ? account.number.slice(-4) : null,
          account.creditData?.creditLimit || null
        );
      } else {
        db.prepare('UPDATE accounts SET balance=?, updated_at=datetime("now") WHERE pluggy_account_id=?')
          .run(account.balance || 0, account.id);
      }
 
      // Fetch and insert transactions
      const txns = await pluggy.getAllTransactions(account.id);
      for (const t of txns) {
        const normalized = pluggy.normalizeTransaction(t, account);
        const dup = db.prepare('SELECT id FROM transactions WHERE pluggy_txn_id=?').get(normalized.pluggy_txn_id);
        if (!dup) {
          db.prepare(
            'INSERT INTO transactions (user_id, pluggy_txn_id, description, amount, type, category, source, date, account_name, card_name, imported_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          ).run(
            userId,
            normalized.pluggy_txn_id,
            normalized.description,
            normalized.amount,
            normalized.type,
            normalized.category,
            normalized.source,
            normalized.date,
            normalized.account_name,
            normalized.card_name,
            normalized.imported_from
          );
          txnCount++;
        }
      }
    }
 
    db.prepare("UPDATE pluggy_items SET status='UPDATED', last_sync=datetime('now') WHERE item_id=? AND user_id=?")
      .run(itemId, userId);
 
  } catch (e) {
    console.error('[SYNC ERROR]', e.message);
    db.prepare("UPDATE pluggy_items SET status='LOGIN_ERROR' WHERE item_id=? AND user_id=?").run(itemId, userId);
  }
 
  return txnCount;
}
 
// Sync all items for a user
async function syncAllForUser(userId) {
  const items = db.prepare('SELECT * FROM pluggy_items WHERE user_id=?').all(userId);
  let total = 0;
  for (const item of items) {
    total += await syncItem(userId, item.item_id);
  }
  return total;
}
 
// Daily cron at 7am
function startCronJobs() {
  cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] Starting daily sync...');
    const users = db.prepare('SELECT DISTINCT user_id FROM pluggy_items').all();
    for (const u of users) {
      await syncAllForUser(u.user_id);
    }
    console.log('[CRON] Daily sync complete.');
  });
}
 
module.exports = { syncItem, syncAllForUser, startCronJobs };
