'use strict';

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

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
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3456',
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
app.get('/health', (_, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV });
});

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

  const allowedMethods = ['credit_card', 'pix', 'boleto'];
  if (!allowedMethods.includes(payment.method)) {
    return res.status(422).json({ error: 'Método de pagamento inválido' });
  }

  try {
    const payload = buildTransactionPayload({ customer, address, items, payment, shipping, req });
    const { data } = await furiapay.post('/payment-transaction/create', payload);

    console.log(`[FuriaPay] Transação criada: ${data.Id} | Status: ${data.Status}`);

    return res.status(201).json(formatResponse(data, payment.method));
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
    return res.json({
      id:            data.Id,
      status:        data.Status,
      amount:        data.Amount,        // em reais
      paymentMethod: data.PaymentMethod,
      paidAt:        data.PaidAt || null,
      createdAt:     data.CreatedAt,
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
    base.card = {
      token:        payment.cardToken,
      holder_name:  payment.holderName,
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
function formatResponse(data, method) {
  const base = {
    orderId: data.Id,
    status:  data.Status,
    amount:  data.Amount,
    method,
  };

  if (method === 'pix') {
    return {
      ...base,
      pix: {
        qrCode:       data.Pix?.QrCode       || data.pix?.qr_code,
        qrCodeBase64: data.Pix?.QrCodeBase64 || data.pix?.qr_code_url,
        expiresAt:    data.Pix?.ExpiresAt    || data.pix?.expires_at,
      },
    };
  }

  if (method === 'boleto') {
    return {
      ...base,
      boleto: {
        url:     data.Boleto?.Url     || data.boleto?.url,
        barCode: data.Boleto?.BarCode || data.boleto?.bar_code,
        dueDate: data.Boleto?.DueDate || data.boleto?.due_date,
      },
    };
  }

  return base;
}

// ===== TRATAMENTO DE ERROS DO GATEWAY =====
function handleGatewayError(err, res) {
  const status = err.response?.status;

  if (status === 400) {
    return res.status(422).json({
      error:   'Dados inválidos para o gateway',
      details: err.response.data?.errors || err.response.data,
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
