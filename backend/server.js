'use strict';

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 4000;

// ===== CLIENTE FURIAPAY =====
const FURIAPAY_BASIC = Buffer.from(
  `${process.env.FURIAPAY_PUBLIC_KEY}:${process.env.FURIAPAY_SECRET_KEY}`
).toString('base64');

const furiapay = axios.create({
  baseURL: process.env.FURIAPAY_API_URL || 'https://api.furiapaybr.app/v1',
  headers: {
    Authorization: `Basic ${FURIAPAY_BASIC}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15000,
});

furiapay.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[FuriaPay] ${status} — ${msg}`);
    return Promise.reject(err);
  }
);

// ===== MIDDLEWARES =====
app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

// Webhook precisa do body raw para validar assinatura HMAC
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== HEALTHCHECK =====
app.get('/', (_, res) => res.sendFile(path.join(frontendDir, 'index.html')));

app.get('/health', (_, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV });
});

const path = require('path');
const frontendDir = path.join(__dirname, '..');

app.get('/setup.sh',    (_, res) => res.sendFile(path.join(frontendDir, 'setup.sh')));
app.get('/index.html',  (_, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get('/styles.css',  (_, res) => res.sendFile(path.join(frontendDir, 'styles.css')));
app.get('/checkout.js', (_, res) => res.sendFile(path.join(frontendDir, 'checkout.js')));
app.get('/server.js',   (_, res) => res.sendFile(path.join(__dirname, 'server.js')));

// ===== CRIAR TRANSAÇÃO =====
app.post('/api/orders', paymentLimiter, async (req, res) => {
  const { customer, address, items, payment, shipping } = req.body;

  // Validação server-side
  const missing = [];
  if (!customer?.name)            missing.push('customer.name');
  if (!customer?.email)           missing.push('customer.email');
  if (!customer?.cpf)             missing.push('customer.cpf');
  if (!customer?.phone)           missing.push('customer.phone');
  if (!payment?.method)           missing.push('payment.method');
  if (!items?.length)             missing.push('items');

  if (missing.length) {
    return res.status(422).json({ error: 'Campos obrigatórios faltando', fields: missing });
  }

  // Normaliza 'card' → 'credit_card'
  if (payment.method === 'card') payment.method = 'credit_card';

  const allowedMethods = ['credit_card', 'pix', 'boleto'];
  if (!allowedMethods.includes(payment.method)) {
    return res.status(422).json({ error: 'Método de pagamento inválido' });
  }

  try {
    const payload = buildTransactionPayload({ customer, address, items, payment, shipping, req });
    console.log('[FuriaPay] Payload:', JSON.stringify(payload, null, 2));
    const { data } = await furiapay.post('/payment-transaction/create', payload);

    const tx = data.data;
    console.log(`[FuriaPay] Transação: ${tx?.id} | Status: ${tx?.status}`);

    return res.status(201).json(await formatResponse(tx, payment.method));
  } catch (err) {
    return handleGatewayError(err, res);
  }
});

// ===== BUSCAR TRANSAÇÃO =====
app.get('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;

  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const { data } = await furiapay.get(`/payment-transaction/info/${id}`);
    const tx = data.data || data;
    return res.json({
      id:            tx.id,
      status:        tx.status,
      amount:        tx.amount,
      paymentMethod: tx.payment_method,
      paidAt:        tx.paid_at || null,
      createdAt:     tx.created_at,
    });
  } catch (err) {
    return handleGatewayError(err, res);
  }
});

// ===== ESTORNAR TRANSAÇÃO =====
app.post('/api/orders/:id/refund', async (req, res) => {
  const { id } = req.params;

  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const { data } = await furiapay.post(`/payment-transaction/${id}/refund`);
    console.log(`[FuriaPay] Estorno solicitado: ${id}`);
    return res.json({ success: true, data });
  } catch (err) {
    return handleGatewayError(err, res);
  }
});

// Verificação de URL que a FuriaPay faz via GET antes de ativar o webhook
app.get('/webhook', (_, res) => res.status(200).send('OK'));

// ===== SAQUE / TRANSFERÊNCIA PIX =====
app.post('/api/withdraw', async (req, res) => {
  const { pix_key, pix_type, amount } = req.body;

  const validTypes = ['cpf', 'cnpj', 'evp', 'phone', 'email'];
  if (!pix_key || !pix_type || !amount) {
    return res.status(422).json({ error: 'pix_key, pix_type e amount são obrigatórios' });
  }
  if (!validTypes.includes(pix_type)) {
    return res.status(422).json({ error: `pix_type inválido. Use: ${validTypes.join(', ')}` });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(422).json({ error: 'amount deve ser um número positivo em reais (ex: 10.00)' });
  }

  try {
    const { data } = await furiapay.post('/wallet-transaction/create/withdrawal', {
      pix_key,
      pix_type,
      amount,       // em reais
      postback_url: process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`,
    });

    console.log(`[Saque] ID: ${data.data?.id} | Status: ${data.data?.status} | R$ ${amount}`);

    return res.json({
      id:             data.data.id,
      status:         data.data.status,
      pix_key:        data.data.pix_key,
      required_amount: data.data.required_amount,
      total_amount:   data.data.total_amount,
      created_at:     data.data.created_at,
    });
  } catch (err) {
    return handleGatewayError(err, res);
  }
});

// ===== WEBHOOK =====
app.post('/webhook', (req, res) => {
  // Validação de assinatura se o secret estiver configurado
  if (process.env.FURIAPAY_WEBHOOK_SECRET) {
    const signature = req.headers['x-furiapay-signature'];
    const expected = crypto
      .createHmac('sha256', process.env.FURIAPAY_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

    if (signature !== `sha256=${expected}`) {
      console.warn('[Webhook] Assinatura inválida — ignorado');
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (_) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  // Formato FuriaPay: { Id, Status, Amount (reais), PaymentMethod, ... }
  const { Id, Status, Amount, PaymentMethod, PaidAt, ExternalId } = event;
  console.log(`[Webhook] ID: ${Id} | Status: ${Status} | Método: ${PaymentMethod} | R$ ${Amount}`);

  switch (Status) {
    case 'PAID':
      onPaid({ Id, Amount, PaymentMethod, PaidAt, ExternalId });
      break;
    case 'REFUSED':
      onRefused({ Id, Amount, PaymentMethod });
      break;
    case 'REFUNDED':
      onRefunded({ Id, Amount });
      break;
    case 'CHARGEBACK':
    case 'PRECHARGEBACK':
      onChargeback({ Id, Status, Amount });
      break;
    case 'EXPIRED':
      onExpired({ Id });
      break;
    case 'ERROR':
      console.error(`[Webhook] Erro na transação ${Id}`);
      break;
    case 'PENDING':
      // Transação criada mas ainda não paga — normal para PIX e Boleto
      break;
    default:
      console.log(`[Webhook] Status não tratado: ${Status}`);
  }

  // Responder 200 imediatamente — a FuriaPay pode reenviar se demorar
  res.status(200).json({ received: true });
});

// ===== HANDLERS DE STATUS =====
function onPaid({ Id, Amount, PaymentMethod, PaidAt, ExternalId }) {
  console.log(`[Pago] Transação ${Id} | R$ ${Amount} | ${PaymentMethod} | ${PaidAt}`);
  // TODO: marcar pedido como pago no banco de dados
  // TODO: liberar acesso ao produto / acionar fulfillment
  // TODO: enviar e-mail de confirmação ao cliente
}

function onRefused({ Id, Amount, PaymentMethod }) {
  console.log(`[Recusado] Transação ${Id} | R$ ${Amount}`);
  // TODO: notificar cliente para tentar outro cartão
}

function onRefunded({ Id, Amount }) {
  console.log(`[Estornado] Transação ${Id} | R$ ${Amount}`);
  // TODO: processar estorno no seu sistema, notificar cliente
}

function onChargeback({ Id, Status, Amount }) {
  console.warn(`[Chargeback] Transação ${Id} | Status: ${Status} | R$ ${Amount}`);
  // TODO: acionar time de risco / suporte
}

function onExpired({ Id }) {
  console.log(`[Expirado] Transação ${Id} — PIX/Boleto não pago no prazo`);
  // TODO: cancelar reserva de estoque se houver
}

// ===== MONTAGEM DO PAYLOAD =====
function buildTransactionPayload({ customer, address, items, payment, shipping, req }) {
  const totalCents = items.reduce((acc, i) => acc + i.price * i.quantity, 0)
                   + (shipping?.cost || 0);

  const base = {
    amount: totalCents,                               // em centavos
    payment_method: payment.method,                   // credit_card | pix | boleto
    postback_url: process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1',
    customer: {
      name:  customer.name.trim(),
      email: customer.email.toLowerCase().trim(),
      phone: customer.phone.replace(/\D/g, ''),
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
      unit_price: item.price,                         // em centavos
    })),
    metadata: {
      provider_name: process.env.STORE_NAME || 'Minha Loja',
    },
  };

  if (shipping?.cost) {
    base.shipping = {
      name:   shipping.type || 'PAC',
      amount: shipping.cost,                          // em centavos
    };
  }

  if (payment.method === 'credit_card') {
    const card = payment.card || {};
    const [expMonth, expYear] = (card.expiry || '').split('/');
    // FuriaPay expects MM/YYYY — expand 2-digit year to 4 digits
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
    base.pix = { expiration_seconds: 3600 };          // 1 hora
  }

  if (payment.method === 'boleto') {
    base.boleto = { due_days: 3 };
  }

  return base;
}

// ===== FORMATA RESPOSTA PARA O FRONTEND =====
// Resposta FuriaPay: { data: { id, amount, status, pix: { qr_code, expiration_date } } }
async function formatResponse(data, method) {
  const base = {
    orderId: data.id,
    status:  data.status,
    amount:  data.amount,
    method,
  };

  if (method === 'pix') {
    const rawCode = data.pix?.qr_code || '';
    // Gera imagem QR Code em base64 a partir do código EMV
    let qrCodeBase64 = null;
    if (rawCode) {
      try {
        qrCodeBase64 = await QRCode.toDataURL(rawCode, { width: 280, margin: 2 });
      } catch (e) {
        console.error('[QRCode] Erro ao gerar imagem:', e.message);
      }
    }
    return {
      ...base,
      pix: {
        qrCode:       rawCode,
        qrCodeBase64: qrCodeBase64,
        expiresAt:    data.pix?.expiration_date,
      },
    };
  }

  if (method === 'boleto') {
    return {
      ...base,
      boleto: {
        url:     data.boleto?.url,
        barCode: data.boleto?.bar_code,
        dueDate: data.boleto?.due_date,
      },
    };
  }

  return base;
}

// ===== TRATAMENTO DE ERROS DO GATEWAY =====
function handleGatewayError(err, res) {
  const status = err.response?.status;

  if (status === 400) {
    console.error('[FuriaPay 400] Resposta:', JSON.stringify(err.response.data, null, 2));
    return res.status(422).json({
      error:   'Dados inválidos para o gateway',
      details: err.response.data,
    });
  }

  if (status === 401) {
    console.error('[FuriaPay] Falha na autenticação — verifique as credenciais no .env');
    return res.status(500).json({ error: 'Erro de configuração do servidor' });
  }

  if (status === 500) {
    return res.status(502).json({ error: 'Erro interno no gateway de pagamento' });
  }

  if (err.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Gateway não respondeu a tempo. Tente novamente.' });
  }

  console.error('[Server] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
}

// ===== START =====
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Ambiente  : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   FuriaPay  : ${process.env.FURIAPAY_API_URL}`);
  console.log(`   Frontend  : ${process.env.FRONTEND_URL || 'http://localhost:3456'}\n`);

  if (!process.env.FURIAPAY_WEBHOOK_SECRET) {
    console.warn('⚠️  FURIAPAY_WEBHOOK_SECRET vazio — webhooks chegam sem validação de assinatura');
  }
});
