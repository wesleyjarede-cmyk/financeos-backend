// ═══════════════════════════════════════════════════════════
// pluggy.js — Integração completa com a API da Pluggy
// Documentação: https://docs.pluggy.ai
// ═══════════════════════════════════════════════════════════
const { PluggyClient } = require('pluggy-node');

let client = null;
let tokenExpiresAt = null;

// ─── INICIALIZAR CLIENTE ─────────────────────────────────
function getClient() {
  if (!process.env.PLUGGY_CLIENT_ID || !process.env.PLUGGY_CLIENT_SECRET) {
    throw new Error('PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET não configurados no .env');
  }
  if (!client) {
    client = new PluggyClient({
      clientId: process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    });
  }
  return client;
}

// ─── GERAR CONNECT TOKEN ─────────────────────────────────
// O Connect Token é usado no frontend para abrir o widget
// de conexão bancária da Pluggy de forma segura
async function createConnectToken(options = {}) {
  const c = getClient();
  const token = await c.createConnectToken(
    options.itemId || null,    // null = nova conexão, itemId = reconectar
    {
      clientUserId: options.userId ? String(options.userId) : undefined,
      webhookUrl: options.webhookUrl || undefined,
    }
  );
  return token.accessToken;
}

// ─── BUSCAR ITEM (conexão bancária) ──────────────────────
async function getItem(itemId) {
  const c = getClient();
  return await c.fetchItem(itemId);
}

// ─── BUSCAR TODAS AS CONTAS DE UM ITEM ───────────────────
async function getAccounts(itemId) {
  const c = getClient();
  const result = await c.fetchAccounts(itemId);
  return result.results || [];
}

// ─── BUSCAR TRANSAÇÕES DE UMA CONTA ──────────────────────
async function getTransactions(accountId, options = {}) {
  const c = getClient();

  // Data padrão: últimos 90 dias
  const to = options.to || new Date().toISOString().split('T')[0];
  const from = options.from || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split('T')[0];
  })();

  const result = await c.fetchTransactions(accountId, {
    from,
    to,
    pageSize: 500,
    page: options.page || 1,
  });

  return {
    transactions: result.results || [],
    total: result.total || 0,
    totalPages: result.totalPages || 1,
    page: result.page || 1,
  };
}

// ─── BUSCAR TODAS AS TRANSAÇÕES (paginado) ───────────────
async function getAllTransactions(accountId, options = {}) {
  const allTxns = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await getTransactions(accountId, { ...options, page });
    allTxns.push(...result.transactions);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  return allTxns;
}

// ─── LISTAR INSTITUIÇÕES DISPONÍVEIS ─────────────────────
async function getConnectors(options = {}) {
  const c = getClient();
  const result = await c.fetchConnectors({
    countries: ['BR'],
    types: options.types || ['PERSONAL_BANK', 'BUSINESS_BANK'],
    sandbox: process.env.NODE_ENV !== 'production',
  });
  return result.results || [];
}

// ─── DELETAR ITEM ────────────────────────────────────────
async function deleteItem(itemId) {
  const c = getClient();
  await c.deleteItem(itemId);
}

// ─── MAPEAR CATEGORIA PLUGGY → CATEGORIA DO SISTEMA ──────
function mapCategory(pluggyCategory, description, accountType) {
  const desc = (description || '').toLowerCase();
  const cat = (pluggyCategory || '').toLowerCase();

  if (accountType === 'CREDIT') {
    // Categorias de cartão
    if (cat.includes('food') || cat.includes('restaurant') || desc.includes('ifood') || desc.includes('rappi')) return 'Restaurantes';
    if (cat.includes('supermarket') || desc.includes('mercado') || desc.includes('supermercado')) return 'Supermercado';
    if (cat.includes('transport') || desc.includes('uber') || desc.includes('99 ')) return 'Transporte';
    if (cat.includes('entertainment') || desc.includes('netflix') || desc.includes('spotify')) return 'Assinaturas';
    if (cat.includes('health') || desc.includes('farmácia') || desc.includes('drogaria')) return 'Saúde';
    if (cat.includes('shopping') || desc.includes('amazon') || desc.includes('mercado livre')) return 'Compras online';
    if (cat.includes('travel') || desc.includes('hotel') || desc.includes('airbnb')) return 'Viagem';
    if (cat.includes('clothing') || desc.includes('renner') || desc.includes('zara')) return 'Vestuário';
    if (desc.includes('pagamento') || desc.includes('pag fatura')) return 'Pagamento fatura';
    if (desc.includes('estorno') || desc.includes('reembolso')) return 'Estorno';
    return 'Outros (cartão)';
  } else {
    // Categorias de conta bancária
    if (cat.includes('salary') || desc.includes('salário') || desc.includes('holerite')) return 'Salário';
    if (desc.includes('aluguel') || desc.includes('condomínio') || desc.includes('energia') || desc.includes('água')) return 'Moradia';
    if (cat.includes('food') || desc.includes('supermercado') || desc.includes('ifood')) return 'Alimentação';
    if (cat.includes('transport') || desc.includes('uber') || desc.includes('gasolina')) return 'Transporte';
    if (cat.includes('health') || desc.includes('farmácia') || desc.includes('médico')) return 'Saúde';
    if (cat.includes('education') || desc.includes('escola') || desc.includes('faculdade')) return 'Educação';
    if (cat.includes('investment') || desc.includes('cdb') || desc.includes('tesouro')) return 'Investimentos';
    if (desc.includes('pix recebido') || desc.includes('transferência recebida')) return 'PIX recebido';
    if (desc.includes('freelance') || desc.includes('freela')) return 'Freelance';
    return 'Outros (banco)';
  }
}

// ─── NORMALIZAR TRANSAÇÃO PLUGGY → FORMATO DO SISTEMA ────
function normalizeTransaction(pluggyTxn, account) {
  const isCredit = account.type === 'CREDIT';
  const isIncome = pluggyTxn.type === 'CREDIT';

  // No cartão de crédito: DEBIT = compra, CREDIT = pagamento
  // Na conta bancária: CREDIT = receita, DEBIT = despesa
  let txnType;
  if (isCredit) {
    txnType = isIncome ? 'pagamento' : 'compra';
  } else {
    txnType = isIncome ? 'receita' : 'despesa';
  }

  const category = mapCategory(
    pluggyTxn.category,
    pluggyTxn.description || pluggyTxn.descriptionRaw,
    account.type
  );

  return {
    pluggy_txn_id: pluggyTxn.id,
    description: pluggyTxn.description || pluggyTxn.descriptionRaw || 'Transação',
    amount: Math.abs(pluggyTxn.amount),
    type: txnType,
    category,
    source: isCredit ? 'cc' : 'bank',
    date: pluggyTxn.date
      ? new Date(pluggyTxn.date).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0],
    account_name: account.name,
    card_name: isCredit ? account.name : null,
    imported_from: 'pluggy',
  };
}

module.exports = {
  getClient,
  createConnectToken,
  getItem,
  getAccounts,
  getTransactions,
  getAllTransactions,
  getConnectors,
  deleteItem,
  mapCategory,
  normalizeTransaction,
};
