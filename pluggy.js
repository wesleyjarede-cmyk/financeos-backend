// pluggy.js — Integração com a API da Pluggy via axios
const axios = require('axios');

const BASE = 'https://api.pluggy.ai';
let cachedToken = null;
let tokenExpiry = null;

// Obter token de autenticação
async function getToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  const res = await axios.post(`${BASE}/auth`, {
    clientId: process.env.PLUGGY_CLIENT_ID,
    clientSecret: process.env.PLUGGY_CLIENT_SECRET,
  });
  cachedToken = res.data.apiKey;
  tokenExpiry = Date.now() + 30 * 60 * 1000;
  return cachedToken;
}

function headers(token) {
  return { 'X-API-KEY': token, 'Content-Type': 'application/json' };
}

async function createConnectToken(options = {}) {
  const token = await getToken();
  const body = {};
  if (options.itemId) body.itemId = options.itemId;
  if (options.userId) body.clientUserId = String(options.userId);
  const res = await axios.post(`${BASE}/connect_token`, body, { headers: headers(token) });
  return res.data.accessToken;
}

async function getItem(itemId) {
  const token = await getToken();
  const res = await axios.get(`${BASE}/items/${itemId}`, { headers: headers(token) });
  return res.data;
}

async function getAccounts(itemId) {
  const token = await getToken();
  const res = await axios.get(`${BASE}/accounts?itemId=${itemId}`, { headers: headers(token) });
  return res.data.results || [];
}

async function getAllTransactions(accountId, options = {}) {
  const token = await getToken();
  const from = options.from || daysAgo(90);
  const to = options.to || today();
  let page = 1, all = [], totalPages = 1;
  do {
    const res = await axios.get(`${BASE}/transactions`, {
      headers: headers(token),
      params: { accountId, from, to, pageSize: 500, page },
    });
    all.push(...(res.data.results || []));
    totalPages = res.data.totalPages || 1;
    page++;
  } while (page <= totalPages);
  return all;
}

async function getConnectors() {
  const token = await getToken();
  const res = await axios.get(`${BASE}/connectors?countries=BR&sandbox=true`, { headers: headers(token) });
  return res.data.results || [];
}

async function deleteItem(itemId) {
  const token = await getToken();
  await axios.delete(`${BASE}/items/${itemId}`, { headers: headers(token) });
}

function mapCategory(cat, desc, type) {
  const d = (desc || '').toLowerCase();
  if (type === 'CREDIT') {
    if (d.includes('ifood') || d.includes('rappi') || d.includes('restaurante')) return 'Restaurantes';
    if (d.includes('mercado') || d.includes('supermercado')) return 'Supermercado';
    if (d.includes('uber') || d.includes('99')) return 'Transporte';
    if (d.includes('netflix') || d.includes('spotify') || d.includes('amazon')) return 'Assinaturas';
    if (d.includes('farmácia') || d.includes('drogaria')) return 'Saúde';
    if (d.includes('pagamento') || d.includes('fatura')) return 'Pagamento fatura';
    if (d.includes('estorno')) return 'Estorno';
    return 'Outros (cartão)';
  }
  if (d.includes('salário') || d.includes('holerite')) return 'Salário';
  if (d.includes('aluguel') || d.includes('energia') || d.includes('água')) return 'Moradia';
  if (d.includes('mercado') || d.includes('ifood')) return 'Alimentação';
  if (d.includes('uber') || d.includes('gasolina')) return 'Transporte';
  if (d.includes('farmácia') || d.includes('médico')) return 'Saúde';
  if (d.includes('netflix') || d.includes('spotify')) return 'Lazer';
  return 'Outros (banco)';
}

function normalizeTransaction(t, account) {
  const isCredit = account.type === 'CREDIT';
  const isIncome = t.type === 'CREDIT';
  let type;
  if (isCredit) type = isIncome ? 'pagamento' : 'compra';
  else type = isIncome ? 'receita' : 'despesa';
  return {
    pluggy_txn_id: t.id,
    description: t.description || t.descriptionRaw || 'Transação',
    amount: Math.abs(t.amount),
    type,
    category: mapCategory(t.category, t.description, account.type),
    source: isCredit ? 'cc' : 'bank',
    date: t.date ? new Date(t.date).toISOString().split('T')[0] : today(),
    account_name: account.name,
    card_name: isCredit ? account.name : null,
    imported_from: 'pluggy',
  };
}

function today() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }

module.exports = { createConnectToken, getItem, getAccounts, getAllTransactions, getConnectors, deleteItem, mapCategory, normalizeTransaction };
