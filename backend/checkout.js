'use strict';

const API_URL       = 'https://checkout-system-1-production.up.railway.app';
const PRODUCT_PRICE = 29700; // centavos

const state = {
  method:  'card',
  discount: 0,
  coupon:   null,
  pixCode:  '',
  validCoupons: {
    'DESCONTO10': { type: 'percent', value: 10 },
    'PROMO50':    { type: 'fixed',   value: 5000 },
  },
};

// ─── INIT ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupMasks();
  updateTotals();
});

// ─── MÉTODO DE PAGAMENTO ─────────────────────
function selectMethod(method) {
  state.method = method;

  document.querySelectorAll('.method').forEach(el => el.classList.remove('active'));
  document.getElementById(`method-${method}`)?.classList.add('active');

  document.querySelectorAll('.payment-form').forEach(el => el.classList.add('hidden'));
  document.getElementById(`form-${method}`)?.classList.remove('hidden');

  const pixNote        = document.getElementById('pix-note');
  const pixNoteDesktop = document.getElementById('pix-note-desktop');
  const show = method === 'pix';
  if (pixNote)        pixNote.style.display        = show ? 'flex' : 'none';
  if (pixNoteDesktop) pixNoteDesktop.style.display  = show ? 'flex' : 'none';

  updateTotals();
}

// ─── MÁSCARAS ────────────────────────────────
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
  const brands = {
    Visa:      /^4/,
    Master:    /^5[1-5]|^2[2-7]/,
    Amex:      /^3[47]/,
    Elo:       /^4011|^4312|^5041|^5067/,
    Hipercard: /^606282/,
  };
  let found = '';
  for (const [name, re] of Object.entries(brands)) {
    if (re.test(num)) { found = name; break; }
  }
  badge.textContent = found;
}

// ─── CUPOM ───────────────────────────────────
function toggleCoupon() {
  const f = document.getElementById('coupon-form');
  if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

function applyCoupon() {
  _applyCoupon(
    document.getElementById('coupon-input')?.value,
    document.getElementById('coupon-msg')
  );
}

function _applyCoupon(rawCode, msgEl) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code || !msgEl) return;

  if (state.validCoupons[code]) {
    const c = state.validCoupons[code];
    state.coupon   = code;
    state.discount = c.type === 'percent'
      ? Math.round(PRODUCT_PRICE * c.value / 100)
      : Math.min(c.value, PRODUCT_PRICE);
    msgEl.textContent = '✓ Cupom aplicado!';
    msgEl.className = 'coupon-feedback ok';
  } else {
    state.discount = 0;
    state.coupon   = null;
    msgEl.textContent = 'Cupom inválido ou expirado.';
    msgEl.className = 'coupon-feedback err';
  }
  updateTotals();
}

// ─── TOTAIS ───────────────────────────────────
function updateTotals() {
  const total    = PRODUCT_PRICE - state.discount;
  const pixTotal = Math.round(total * 0.95);
  const fmt      = c => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
  const inst6    = (total / 600).toFixed(2).replace('.', ',');
  const isCard   = state.method === 'card';
  const instText = isCard ? `6x de R$ ${inst6}*` : fmt(total);
  const cashText = isCard ? `OU ${fmt(total)} À VISTA` : '';

  // Desktop summary
  _set('subtotal-val',        fmt(PRODUCT_PRICE));
  _set('installments-display', instText);
  _set('cash-display',         cashText);
  _set('pix-price-display-desktop', fmt(pixTotal));
  _setDiscount('discount-row', 'discount-val', state.discount, fmt);

  // Mobile summary
  _set('m-subtotal',            fmt(PRODUCT_PRICE));
  _set('m-installments-display', instText);
  _set('m-cash-display',         cashText);
  _setDiscount('m-discount-row', 'm-discount-val', state.discount, fmt);

  // PIX price in form
  _set('pix-price-display', fmt(pixTotal));
}

function _set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function _setDiscount(rowId, valId, discount, fmt) {
  const row = document.getElementById(rowId);
  const val = document.getElementById(valId);
  if (!row) return;
  if (discount > 0) {
    row.style.display = 'flex';
    if (val) val.textContent = `-${fmt(discount)}`;
  } else {
    row.style.display = 'none';
  }
}

// ─── VALIDAÇÃO ───────────────────────────────
function validate() {
  let ok = true;
  ok = field('name',  v => v.trim().split(/\s+/).length >= 2, 'Informe o nome completo') && ok;
  ok = field('email', v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'E-mail inválido') && ok;
  ok = field('phone', v => v.replace(/\D/g, '').length >= 10, 'Celular inválido') && ok;
  ok = field('cpf',   v => validCPF(v.replace(/\D/g, '')), 'CPF inválido') && ok;

  if (state.method === 'card') {
    const num = document.getElementById('card-number')?.value.replace(/\s/g, '') || '';
    const exp = document.getElementById('card-expiry')?.value || '';
    const cvv = document.getElementById('card-cvv')?.value || '';
    const nom = document.getElementById('card-name')?.value.trim() || '';
    if (num.length < 13)           { toast('Número do cartão inválido'); ok = false; }
    else if (nom.split(/\s+/).length < 2) { toast('Informe o nome como no cartão'); ok = false; }
    else if (exp.length < 5)       { toast('Validade inválida'); ok = false; }
    else if (cvv.length < 3)       { toast('CVV inválido'); ok = false; }
  }
  return ok;
}

function field(id, rule, msg) {
  const el  = document.getElementById(id);
  const err = document.getElementById(`${id}-error`);
  if (!el) return true;
  const ok = rule(el.value);
  el.classList.toggle('error', !ok);
  el.classList.toggle('ok',    ok);
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

// ─── SUBMIT ───────────────────────────────────
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

    const res  = await fetch(`${API_URL}/api/orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
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

// ─── SUCESSO ──────────────────────────────────
function showSuccess(order = {}) {
  document.getElementById('modal-email').textContent =
    document.getElementById('email')?.value || '';
  document.getElementById('modal-order-id').textContent =
    order.orderId || String(Math.floor(Math.random() * 900000) + 100000);

  const pixRes    = document.getElementById('pix-result');
  const boletoRes = document.getElementById('boleto-result');
  if (pixRes)    pixRes.style.display    = 'none';
  if (boletoRes) boletoRes.style.display = 'none';

  if (state.method === 'pix' && order.pix) {
    document.getElementById('pix-result').style.display = 'block';
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
    document.getElementById('boleto-result').style.display = 'block';
    document.getElementById('boleto-link').href = order.boleto.url;
  }

  document.getElementById('modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

function copyPix() {
  navigator.clipboard.writeText(state.pixCode || '').then(() => {
    toast('Código PIX copiado!', 'success');
  }).catch(() => toast('Não foi possível copiar.', 'info'));
}

// ─── TOAST ───────────────────────────────────
function toast(msg, type = 'error') {
  document.querySelector('.cp-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'cp-toast';
  t.textContent = msg;
  const colors = { error: '#ef4444', success: '#22c55e', info: '#1a56db' };
  t.style.background = colors[type] || colors.error;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
