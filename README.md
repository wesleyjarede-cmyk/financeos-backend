# FinanceOS Pro — Backend com Pluggy Open Finance

## Como colocar no ar em 15 minutos (Railway — gratuito)

### PASSO 1 — Criar conta na Pluggy (5 min)

1. Acesse **https://pluggy.ai** e clique em "Get started free"
2. Crie sua conta com e-mail e senha
3. No dashboard, vá em **"API Keys"** (menu lateral)
4. Copie o **Client ID** e o **Client Secret**
5. Ative o **Sandbox mode** para testes (sem banco real)

---

### PASSO 2 — Criar conta no Railway (2 min)

1. Acesse **https://railway.app** e faça login com GitHub
2. Clique em **"New Project"**
3. Escolha **"Deploy from GitHub repo"**
4. Conecte e selecione o repositório com este código

---

### PASSO 3 — Configurar variáveis de ambiente (3 min)

No painel do Railway, vá em **Variables** e adicione:

```
PLUGGY_CLIENT_ID      = (cole seu Client ID da Pluggy)
PLUGGY_CLIENT_SECRET  = (cole seu Client Secret da Pluggy)
JWT_SECRET            = qualquer_string_aleatoria_longa_aqui
PORT                  = 3001
NODE_ENV              = production
FRONTEND_URL          = *
```

---

### PASSO 4 — Deploy automático

O Railway faz o deploy automaticamente. Em ~2 minutos sua API estará em:
`https://seu-projeto.up.railway.app`

---

### PASSO 5 — Conectar ao frontend

No arquivo **FinanceOS_Pro_v4.html**, localize a linha:
```javascript
const API_URL = 'http://localhost:3001';
```
E troque para:
```javascript
const API_URL = 'https://seu-projeto.up.railway.app';
```

---

## Endpoints disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | /api/auth/register | Criar conta |
| POST | /api/auth/login | Login |
| GET | /api/pluggy/connect-token | Token para widget bancário |
| POST | /api/pluggy/item | Salvar banco conectado |
| GET | /api/pluggy/items | Listar bancos conectados |
| POST | /api/pluggy/sync | Sincronizar agora |
| GET | /api/accounts | Listar contas bancárias |
| GET | /api/transactions | Listar transações |
| GET | /api/dashboard | Dados do dashboard |
| GET | /api/health | Status do servidor |

## Bancos suportados pela Pluggy (principais)

- Nubank ✓
- Itaú ✓
- Bradesco ✓
- Banco do Brasil ✓
- Santander ✓
- Caixa Econômica ✓
- Inter ✓
- C6 Bank ✓
- XP Investimentos ✓
- BTG Pactual ✓
- PicPay ✓
- Mercado Pago ✓

## Modo Sandbox (testes sem banco real)

No dashboard da Pluggy, ative o **Sandbox**. Você terá acesso a
bancos fictícios para testar sem precisar conectar sua conta real.
Quando estiver satisfeito, desative o Sandbox e use com bancos reais.
