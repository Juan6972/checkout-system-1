'use strict';

/**
 * ============================================================
 *  CHECKOUT SERVER — Produção
 *  Auditado e refatorado para segurança, performance e robustez
 * ============================================================
 */

require('dotenv').config();

const express     = require('express');
const axios       = require('axios');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const crypto      = require('crypto');
const QRCode      = require('qrcode');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');

const app     = express();
const PORT    = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ─────────────────────────────────────────────
//  LOGGER ESTRUTURADO (sem dados sensíveis)
// ─────────────────────────────────────────────
const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  ts: new Date().toISOString(), msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  ts: new Date().toISOString(), msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', ts: new Date().toISOString(), msg, ...ctx })),
};

/** Mascara dados de cartão antes de logar */
function maskCard(card = {}) {
  if (!card.number) return {};
  return {
    number:          `****${String(card.number).slice(-4)}`,
    holder_name:     card.holder_name,
    expiration_date: card.expiration_date,
    cvv:             '***',
  };
}

// ─────────────────────────────────────────────
//  VERIFICAÇÃO DE AMBIENTE OBRIGATÓRIO
// ─────────────────────────────────────────────
const REQUIRED_ENV = ['FURIAPAY_PUBLIC_KEY', 'FURIAPAY_SECRET_KEY'];
const MISSING_ENV  = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING_ENV.length) {
  console.error(`[FATAL] Variáveis de ambiente faltando: ${MISSING_ENV.join(', ')}`);
  process.exit(1);
}

// ─────────────────────────────────────────────
//  CLIENTE FURIAPAY
// ─────────────────────────────────────────────
const FURIAPAY_BASIC = Buffer.from(
  `${process.env.FURIAPAY_PUBLIC_KEY}:${process.env.FURIAPAY_SECRET_KEY}`
).toString('base64');

const furiapay = axios.create({
  baseURL: process.env.FURIAPAY_API_URL || 'https://api.furiapaybr.app/v1',
  headers: {
    Authorization:  `Basic ${FURIAPAY_BASIC}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  },
  timeout: 15000,
});

furiapay.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status;
    const data   = err.response?.data;
    log.error('[FuriaPay] Erro na requisição', { status, data });
    return Promise.reject(err);
  }
);

// ─────────────────────────────────────────────
//  IDEMPOTÊNCIA DE WEBHOOK (memória — substitua por Redis em escala)
// ─────────────────────────────────────────────
const processedWebhooks = new Set();

// ─────────────────────────────────────────────
//  MIDDLEWARES DE SEGURANÇA
// ─────────────────────────────────────────────
app.set('trust proxy', 1);

// Helmet: headers de segurança HTTP
app.use(helmet({ contentSecurityPolicy: false }));

// Compressão gzip
app.use(compression());

// CORS: origens permitidas
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  /\.app\.github\.dev$/,
  /\.trycloudflare\.com$/,
  /\.up\.railway\.app$/,
  /^https?:\/\/localhost/,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server
    const ok = ALLOWED_ORIGINS.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (ok || !IS_PROD) return cb(null, true);
    return cb(new Error('CORS: origem não permitida'));
  },
  methods: ['GET', 'POST'],
}));

// Webhook precisa do body raw para validar assinatura HMAC
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' })); // Limita tamanho do payload

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Rate limiting agressivo em pagamentos
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.ip,
});

// Request ID para rastreamento
app.use((req, _res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  next();
});

// ─────────────────────────────────────────────
//  ARQUIVOS ESTÁTICOS
// ─────────────────────────────────────────────
const frontendDir = path.join(__dirname, '..');

app.get('/',            (_, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get('/index.html',  (_, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get('/styles.css',  (_, res) => res.sendFile(path.join(frontendDir, 'styles.css')));
app.get('/checkout.js', (_, res) => res.sendFile(path.join(frontendDir, 'checkout.js')));

// Expõe server.js e setup.sh APENAS em desenvolvimento (nunca em produção)
if (!IS_PROD) {
  app.get('/server.js', (_, res) => res.sendFile(path.join(__dirname, 'server.js')));
  app.get('/setup.sh',  (_, res) => res.sendFile(path.join(frontendDir, 'setup.sh')));
}

// ─────────────────────────────────────────────
//  HEALTHCHECK
// ─────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────
//  VALIDAÇÃO DE PAYLOAD
// ─────────────────────────────────────────────
function validateOrderPayload({ customer, items, payment }) {
  const errors = [];

  // Cliente
  if (!customer?.name?.trim() || customer.name.trim().split(/\s+/).length < 2)
    errors.push('customer.name: nome completo obrigatório');
  if (!customer?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))
    errors.push('customer.email: e-mail inválido');
  if (!customer?.cpf || !validaCPF(customer.cpf.replace(/\D/g, '')))
    errors.push('customer.cpf: CPF inválido');
  if (!customer?.phone || customer.phone.replace(/\D/g, '').length < 10)
    errors.push('customer.phone: telefone inválido');

  // Itens
  if (!Array.isArray(items) || items.length === 0)
    errors.push('items: lista obrigatória');
  (items || []).forEach((item, i) => {
    if (!item.name)
      errors.push(`items[${i}].name: obrigatório`);
    if (!Number.isInteger(item.price) || item.price <= 0)
      errors.push(`items[${i}].price: deve ser inteiro positivo (centavos)`);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0)
      errors.push(`items[${i}].quantity: deve ser inteiro positivo`);
  });

  // Pagamento
  const method = payment?.method === 'card' ? 'credit_card' : payment?.method;
  if (!['credit_card', 'pix', 'boleto'].includes(method))
    errors.push('payment.method: inválido');

  if (method === 'credit_card') {
    const card = payment?.card || {};
    const num  = (card.number || '').replace(/\D/g, '');
    if (num.length < 13 || num.length > 19)
      errors.push('payment.card.number: inválido');
    if (!card.holder_name?.trim())
      errors.push('payment.card.holder_name: obrigatório');
    if (!card.expiry || !/^\d{2}\/\d{2}$/.test(card.expiry))
      errors.push('payment.card.expiry: formato MM/AA obrigatório');
    if (!card.cvv || !/^\d{3,4}$/.test(card.cvv))
      errors.push('payment.card.cvv: inválido');
    const inst = Number(payment.installments);
    if (!Number.isInteger(inst) || inst < 1 || inst > 12)
      errors.push('payment.installments: deve ser entre 1 e 12');
  }

  return errors;
}

function validaCPF(cpf) {
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += +cpf[i] * (10 - i);
  let r = (s * 10) % 11; if (r >= 10) r = 0;
  if (r !== +cpf[9]) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += +cpf[i] * (11 - i);
  r = (s * 10) % 11; if (r >= 10) r = 0;
  return r === +cpf[10];
}

// ─────────────────────────────────────────────
//  CRIAR TRANSAÇÃO
// ─────────────────────────────────────────────
app.post('/api/orders', paymentLimiter, async (req, res) => {
  const rid = req.requestId;
  const { customer, address, items, payment, shipping } = req.body;

  // Normaliza 'card' → 'credit_card'
  if (payment?.method === 'card') payment.method = 'credit_card';

  // Validação completa server-side
  const errors = validateOrderPayload(req.body);
  if (errors.length) {
    log.warn('Validação falhou', { rid, errors });
    return res.status(422).json({ error: 'Campos inválidos', fields: errors });
  }

  try {
    const payload = buildTransactionPayload({ customer, address, items, payment, shipping, req });

    // Log seguro — cartão mascarado
    const safePayload = { ...payload };
    if (safePayload.card) safePayload.card = maskCard(payload.card);
    log.info('Criando transação', { rid, method: payment.method, amount: payload.amount });

    const { data } = await furiapay.post('/payment-transaction/create', payload);
    const tx = data.data;

    log.info('Transação criada', { rid, id: tx?.id, status: tx?.status });
    return res.status(201).json(await formatResponse(tx, payment.method));

  } catch (err) {
    return handleGatewayError(err, res, rid);
  }
});

// ─────────────────────────────────────────────
//  BUSCAR STATUS
// ─────────────────────────────────────────────
app.get('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id))
    return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data } = await furiapay.get(`/payment-transaction/info/${id}`);
    const tx = data.data || data;
    return res.json({
      id:            tx.id,
      status:        tx.status,
      amount:        tx.amount,
      paymentMethod: tx.payment_method,
      paidAt:        tx.paid_at  || null,
      createdAt:     tx.created_at,
    });
  } catch (err) {
    return handleGatewayError(err, res, req.requestId);
  }
});

// ─────────────────────────────────────────────
//  ESTORNAR TRANSAÇÃO
// ─────────────────────────────────────────────
app.post('/api/orders/:id/refund', async (req, res) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id))
    return res.status(400).json({ error: 'ID inválido' });

  try {
    const { data } = await furiapay.post(`/payment-transaction/${id}/refund`);
    log.info('Estorno solicitado', { id });
    return res.json({ success: true, data });
  } catch (err) {
    return handleGatewayError(err, res, req.requestId);
  }
});

// ─────────────────────────────────────────────
//  SAQUE / TRANSFERÊNCIA PIX
// ─────────────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  const { pix_key, pix_type, amount } = req.body;
  const validTypes = ['cpf', 'cnpj', 'evp', 'phone', 'email'];

  if (!pix_key || !pix_type || amount === undefined)
    return res.status(422).json({ error: 'pix_key, pix_type e amount são obrigatórios' });
  if (!validTypes.includes(pix_type))
    return res.status(422).json({ error: `pix_type inválido. Use: ${validTypes.join(', ')}` });
  if (typeof amount !== 'number' || amount <= 0)
    return res.status(422).json({ error: 'amount deve ser número positivo em reais' });

  try {
    const { data } = await furiapay.post('/wallet-transaction/create/withdrawal', {
      pix_key, pix_type, amount,
      postback_url: process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`,
    });
    log.info('Saque PIX iniciado', { id: data.data?.id, status: data.data?.status, amount });
    return res.json({
      id:              data.data.id,
      status:          data.data.status,
      pix_key:         data.data.pix_key,
      required_amount: data.data.required_amount,
      total_amount:    data.data.total_amount,
      created_at:      data.data.created_at,
    });
  } catch (err) {
    return handleGatewayError(err, res, req.requestId);
  }
});

// ─────────────────────────────────────────────
//  WEBHOOK
// ─────────────────────────────────────────────

// Verificação de URL que a FuriaPay faz via GET
app.get('/webhook', (_, res) => res.status(200).send('OK'));

app.post('/webhook', (req, res) => {
  // ① Responder 200 IMEDIATAMENTE — evita reenvio pela FuriaPay
  res.status(200).json({ received: true });

  // ② Validar assinatura HMAC (timing-safe)
  if (process.env.FURIAPAY_WEBHOOK_SECRET) {
    const signature = req.headers['x-furiapay-signature'] || '';
    const expected  = `sha256=${crypto
      .createHmac('sha256', process.env.FURIAPAY_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex')}`;

    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(signature.padEnd(expected.length)),
        Buffer.from(expected)
      );
    } catch (_) { valid = false; }

    if (!valid) {
      log.warn('Webhook: assinatura inválida — descartado');
      return;
    }
  }

  // ③ Parse do payload
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (_) {
    log.error('Webhook: JSON inválido');
    return;
  }

  const { Id, Status, Amount, PaymentMethod, PaidAt, ExternalId } = event;

  // ④ Idempotência — ignorar duplicatas
  const key = `${Id}::${Status}`;
  if (processedWebhooks.has(key)) {
    log.info('Webhook duplicado ignorado', { Id, Status });
    return;
  }
  processedWebhooks.add(key);
  setTimeout(() => processedWebhooks.delete(key), 24 * 60 * 60 * 1000);

  log.info('Webhook recebido', { Id, Status, PaymentMethod, Amount });

  // ⑤ Processar de forma assíncrona (não bloqueia o event loop)
  setImmediate(() => {
    switch (Status) {
      case 'PAID':         onPaid({ Id, Amount, PaymentMethod, PaidAt, ExternalId }); break;
      case 'REFUSED':      onRefused({ Id, Amount, PaymentMethod }); break;
      case 'REFUNDED':     onRefunded({ Id, Amount }); break;
      case 'CHARGEBACK':
      case 'PRECHARGEBACK': onChargeback({ Id, Status, Amount }); break;
      case 'EXPIRED':      onExpired({ Id }); break;
      case 'ERROR':        log.error('Erro na transação via webhook', { Id }); break;
      case 'PENDING':      break; // Normal para PIX/Boleto recém criados
      default:             log.warn('Webhook: status desconhecido', { Id, Status });
    }
  });
});

// ─────────────────────────────────────────────
//  HANDLERS DE STATUS DE PAGAMENTO
// ─────────────────────────────────────────────
function onPaid({ Id, Amount, PaymentMethod, PaidAt, ExternalId }) {
  log.info('PAGO', { Id, Amount, PaymentMethod, PaidAt, ExternalId });
  // TODO: marcar pedido como pago no banco de dados
  // TODO: liberar acesso ao produto / acionar fulfillment
  // TODO: enviar e-mail de confirmação ao cliente
}

function onRefused({ Id, Amount, PaymentMethod }) {
  log.warn('RECUSADO', { Id, Amount, PaymentMethod });
  // TODO: notificar cliente para tentar outro método
}

function onRefunded({ Id, Amount }) {
  log.info('ESTORNADO', { Id, Amount });
  // TODO: processar estorno interno, notificar cliente
}

function onChargeback({ Id, Status, Amount }) {
  log.warn('CHARGEBACK', { Id, Status, Amount });
  // TODO: acionar time de risco / suporte
}

function onExpired({ Id }) {
  log.info('EXPIRADO', { Id });
  // TODO: cancelar reserva de estoque
}

// ─────────────────────────────────────────────
//  MONTAGEM DO PAYLOAD FURIAPAY
// ─────────────────────────────────────────────
function buildTransactionPayload({ customer, address, items, payment, shipping, req }) {
  const totalCents = items.reduce((acc, i) => acc + i.price * i.quantity, 0)
                   + (shipping?.cost || 0);

  const clientIp = (req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';

  const base = {
    amount:         totalCents,
    payment_method: payment.method,
    postback_url:   process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`,
    ip:             clientIp,
    customer: {
      name:     customer.name.trim(),
      email:    customer.email.toLowerCase().trim(),
      phone:    customer.phone.replace(/\D/g, ''),
      document: {
        type:   'cpf',
        number: customer.cpf.replace(/\D/g, ''),
      },
      address: address ? {
        zip_code:     address.cep?.replace(/\D/g, ''),
        street:       address.street,
        number:       address.number,
        complement:   address.complement || '',
        neighborhood: address.neighborhood,
        city:         address.city,
        state:        address.state?.toUpperCase(),
        country:      'BR',
      } : undefined,
    },
    items: items.map(item => ({
      title:      item.name,
      quantity:   item.quantity,
      unit_price: item.price,
    })),
    metadata: {
      provider_name: process.env.STORE_NAME || 'Minha Loja',
      request_id:    req.requestId,
    },
  };

  if (shipping?.cost) {
    base.shipping = { name: shipping.type || 'PAC', amount: shipping.cost };
  }

  if (payment.method === 'credit_card') {
    const card = payment.card || {};
    const [expMonth, expYear] = (card.expiry || '').split('/');
    const expYearFull = expYear?.length === 2 ? `20${expYear}` : expYear;
    base.card = {
      number:          card.number?.replace(/\D/g, ''),
      holder_name:     card.holder_name,
      expiration_date: expMonth && expYearFull ? `${expMonth}/${expYearFull}` : undefined,
      cvv:             card.cvv,
    };
    base.installments = Number(payment.installments) || 1;
  }

  if (payment.method === 'pix') {
    base.pix = { expiration_seconds: 3600 };
  }

  if (payment.method === 'boleto') {
    base.boleto = { due_days: 3 };
  }

  return base;
}

// ─────────────────────────────────────────────
//  FORMATA RESPOSTA PARA O FRONTEND
// ─────────────────────────────────────────────
async function formatResponse(data, method) {
  const base = { orderId: data.id, status: data.status, amount: data.amount, method };

  if (method === 'pix') {
    const rawCode = data.pix?.qr_code || '';
    let qrCodeBase64 = null;
    if (rawCode) {
      try {
        qrCodeBase64 = await QRCode.toDataURL(rawCode, { width: 280, margin: 2 });
      } catch (e) {
        log.error('QRCode: falha ao gerar imagem', { message: e.message });
      }
    }
    return { ...base, pix: { qrCode: rawCode, qrCodeBase64, expiresAt: data.pix?.expiration_date } };
  }

  if (method === 'boleto') {
    return { ...base, boleto: { url: data.boleto?.url, barCode: data.boleto?.bar_code, dueDate: data.boleto?.due_date } };
  }

  return base;
}

// ─────────────────────────────────────────────
//  TRATAMENTO DE ERROS DO GATEWAY
// ─────────────────────────────────────────────
function handleGatewayError(err, res, rid = '') {
  const status = err.response?.status;
  const data   = err.response?.data;

  if (status === 400) {
    log.error('FuriaPay 400', { rid, data });
    const msg = data?.error_messages?.[0]?.message || data?.title || 'Dados inválidos para o gateway';
    return res.status(422).json({ error: msg });
  }
  if (status === 401) {
    log.error('FuriaPay: autenticação falhou', { rid });
    return res.status(500).json({ error: 'Erro de configuração do servidor' });
  }
  if (status === 500) {
    log.error('FuriaPay: erro interno do gateway', { rid });
    return res.status(502).json({ error: 'Erro interno no gateway. Tente novamente.' });
  }
  if (err.code === 'ECONNABORTED') {
    log.error('FuriaPay: timeout', { rid });
    return res.status(504).json({ error: 'Gateway não respondeu a tempo. Tente novamente.' });
  }

  log.error('Erro inesperado', { rid, message: err.message });
  return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
}

// ─────────────────────────────────────────────
//  HANDLER GLOBAL DE ERROS (404 + erros não tratados)
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.message?.includes('CORS'))
    return res.status(403).json({ error: 'Origem não permitida' });
  log.error('Erro não tratado', { message: err.message });
  // Nunca expõe stack trace em produção
  res.status(500).json({ error: IS_PROD ? 'Erro interno' : err.message });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  log.info('Servidor iniciado', {
    port:     PORT,
    env:      process.env.NODE_ENV || 'development',
    furiapay: process.env.FURIAPAY_API_URL,
    frontend: process.env.FRONTEND_URL || `http://localhost:${PORT}`,
  });

  if (!process.env.FURIAPAY_WEBHOOK_SECRET) {
    log.warn('FURIAPAY_WEBHOOK_SECRET não configurado — webhooks chegam SEM validação de assinatura');
  }
});
