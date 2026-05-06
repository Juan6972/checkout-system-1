'use strict';

const API_URL = 'https://cautious-invention-7v5p5646ggv9hw6w9-4000.app.github.dev';
const PRODUCT_PRICE = 29700; // centavos

const state = {
  method: 'card',
  discount: 0,
  coupon: null,
  pixCode: '',
  validCoupons: {
    'DESCONTO10': { type: 'percent', value: 10 },
    'PROMO50':    { type: 'fixed',   value: 5000 },
  },
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupMasks();
  updateTotals();
});

// ===== PAYMENT METHOD =====
function selectMethod(method) {
  state.method = method;
  document.querySelectorAll('.cp-method').forEach(el => el.classList.remove('active'));
  document.getElementById(`method-${method}`).classList.add('active');
  document.querySelectorAll('.cp-payment-form').forEach(el => el.classList.add('hidden'));
  document.getElementById(`form-${method}`).classList.remove('hidden');

  document.getElementById('pix-note').style.display = method === 'pix' ? 'flex' : 'none';
  updateTotals();
}

// ===== MASKS =====
function setupMasks() {
  mask('phone', v => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    return d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
  });

  mask('cpf', v => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    return d.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, (_, a, b, c, e) =>
      e ? `${a}.${b}.${c}-${e}` : c ? `${a}.${b}.${c}` : b ? `${a}.${b}` : a
    );
  });

  mask('card-number', v => {
    const d = v.replace(/\D/g, '').slice(0, 16);
    const r = d.replace(/(.{4})/g, '$1 ').trim();
    detectBrand(d);
    return r;
  });

  mask('card-expiry', v => {
    const d = v.replace(/\D/g, '').slice(0, 4);
    return d.replace(/(\d{2})(\d{0,2})/, (_, a, b) => b ? `${a}/${b}` : a);
  });

  mask('card-cvv', v => v.replace(/\D/g, '').slice(0, 4));

  document.getElementById('card-name')?.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
}

function mask(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', e => { e.target.value = fn(e.target.value); });
}

function detectBrand(num) {
  const badge = document.getElementById('card-brand-inline');
  if (!badge) return;
  const brands = { Visa: /^4/, Master: /^5[1-5]|^2[2-7]/, Amex: /^3[47]/, Elo: /^4011|^4312|^5041|^5067/, Hipercard: /^606282/ };
  let found = '';
  for (const [name, re] of Object.entries(brands)) if (re.test(num)) { found = name; break; }
  badge.textContent = found;
}

// ===== COUPON =====
function toggleCoupon() {
  const f = document.getElementById('coupon-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

function applyCoupon() {
  const code = document.getElementById('coupon-input')?.value.trim().toUpperCase();
  const msg = document.getElementById('coupon-msg');
  if (!code) return;

  if (state.validCoupons[code]) {
    const c = state.validCoupons[code];
    state.coupon = code;
    state.discount = c.type === 'percent'
      ? Math.round(PRODUCT_PRICE * c.value / 100)
      : Math.min(c.value, PRODUCT_PRICE);
    msg.textContent = '✓ Cupom aplicado!';
    msg.className = 'cp-coupon-msg ok';
  } else {
    state.discount = 0;
    state.coupon = null;
    msg.textContent = 'Cupom inválido ou expirado.';
    msg.className = 'cp-coupon-msg err';
  }
  updateTotals();
}

// ===== TOTALS =====
function updateTotals() {
  const total = PRODUCT_PRICE - state.discount;
  const pixTotal = Math.round(total * 0.95);

  const fmt = c => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

  document.getElementById('subtotal-val').textContent = fmt(PRODUCT_PRICE);
  document.getElementById('discount-row').style.display = state.discount > 0 ? 'flex' : 'none';
  if (state.discount > 0) document.getElementById('discount-val').textContent = `-${fmt(state.discount)}`;

  const inst6 = (total / 600).toFixed(2).replace('.', ',');
  document.getElementById('installments-display').textContent =
    state.method === 'card' ? `6x de R$ ${inst6}*` : fmt(total);
  document.getElementById('cash-display').textContent =
    state.method === 'card' ? `OU ${fmt(total)} À VISTA` : '';
  document.getElementById('pix-price-display').textContent = fmt(pixTotal);
}

// ===== VALIDATION =====
function validate() {
  let ok = true;
  ok = field('name',  v => v.trim().split(' ').length >= 2, 'Informe o nome completo') && ok;
  ok = field('email', v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'E-mail inválido') && ok;
  ok = field('phone', v => v.replace(/\D/g, '').length >= 10, 'Celular inválido') && ok;
  ok = field('cpf',   v => validCPF(v.replace(/\D/g, '')), 'CPF inválido') && ok;

  if (state.method === 'card') {
    const num = document.getElementById('card-number')?.value.replace(/\s/g, '') || '';
    const exp = document.getElementById('card-expiry')?.value || '';
    const cvv = document.getElementById('card-cvv')?.value || '';
    const nom = document.getElementById('card-name')?.value.trim() || '';
    if (num.length < 13) { toast('Número do cartão inválido'); ok = false; }
    else if (nom.split(' ').length < 2) { toast('Informe o nome como no cartão'); ok = false; }
    else if (exp.length < 5) { toast('Validade inválida'); ok = false; }
    else if (cvv.length < 3) { toast('CVV inválido'); ok = false; }
  }
  return ok;
}

function field(id, rule, msg) {
  const el = document.getElementById(id);
  const err = document.getElementById(`${id}-error`);
  if (!el) return true;
  const ok = rule(el.value);
  el.classList.toggle('error', !ok);
  el.classList.toggle('ok', ok);
  if (err) err.textContent = ok ? '' : msg;
  return ok;
}

function validCPF(cpf) {
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

// ===== SUBMIT =====
async function submitOrder() {
  if (!validate()) return;

  document.getElementById('loading').style.display = 'flex';

  try {
    const total = PRODUCT_PRICE - state.discount;
    const payload = {
      customer: {
        name:  document.getElementById('name').value.trim(),
        email: document.getElementById('email').value.trim(),
        phone: document.getElementById('phone').value,
        cpf:   document.getElementById('cpf').value,
      },
      items: [{ name: 'A Grande REVELAÇÃO', quantity: 1, price: total }],
      payment: {
        method:       state.method === 'card' ? 'credit_card' : state.method,
        installments: parseInt(document.getElementById('installments')?.value || '1'),
        card: state.method === 'card' ? {
          number:      document.getElementById('card-number')?.value.replace(/\s/g, ''),
          holder_name: document.getElementById('card-name')?.value.trim(),
          expiry:      document.getElementById('card-expiry')?.value,
          cvv:         document.getElementById('card-cvv')?.value,
        } : undefined,
      },
    };

    const res = await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.reason || data.error || 'Erro ao processar');

    state.lastOrder = data;
    showSuccess(data);
  } catch (err) {
    toast(err.message || 'Erro de conexão. Tente novamente.');
  } finally {
    document.getElementById('loading').style.display = 'none';
  }
}

// ===== SUCCESS =====
function showSuccess(order = {}) {
  document.getElementById('modal-email').textContent =
    document.getElementById('email')?.value || '';
  document.getElementById('modal-order-id').textContent =
    order.orderId || String(Math.floor(Math.random() * 900000) + 100000);

  const pixResult = document.getElementById('pix-result');
  const boletoResult = document.getElementById('boleto-result');
  pixResult.style.display = 'none';
  boletoResult.style.display = 'none';

  if (state.method === 'pix' && order.pix) {
    pixResult.style.display = 'block';
    if (order.pix.qrCodeBase64) {
      document.getElementById('pix-qr-img').src = order.pix.qrCodeBase64;
    }
    if (order.pix.qrCode) state.pixCode = order.pix.qrCode;
    if (order.pix.expiresAt) {
      const exp = new Date(order.pix.expiresAt);
      document.getElementById('pix-expire').textContent =
        `Expira em ${exp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  if (state.method === 'boleto' && order.boleto?.url) {
    boletoResult.style.display = 'block';
    document.getElementById('boleto-link').href = order.boleto.url;
  }

  document.getElementById('modal').style.display = 'flex';
}

function closeModal() { document.getElementById('modal').style.display = 'none'; }

function copyPix() {
  navigator.clipboard.writeText(state.pixCode || '').then(() => {
    toast('Código PIX copiado!', 'success');
  }).catch(() => toast('Não foi possível copiar.', 'info'));
}

// ===== TOAST =====
function toast(msg, type = 'error') {
  document.querySelector('.cp-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'cp-toast';
  t.textContent = msg;
  const colors = { error: '#ef4444', success: '#22c55e', info: '#6C3CE1' };
  t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:${colors[type]};color:#fff;padding:11px 22px;border-radius:8px;font-size:.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:Inter,sans-serif;max-width:90vw;text-align:center;animation:slideUp .25s`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
