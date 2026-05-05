'use strict';

// ===== CONFIG =====
const API_URL = 'http://localhost:4000';
const FURIAPAY_PUBLIC_KEY = 'furiapay_live_mgDq9AZ435C7Jo4dWR0Dx5myFwmzFg0V';
const FURIAPAY_COMPANY_ID = '208a8500318a44cb84a360f1fb4fb214';

// ===== STATE =====
const state = {
  currentStep: 1,
  paymentMethod: 'card',
  shippingCost: 1990,      // cents
  productPrice: 29700,     // cents
  bumpAdded: false,
  bumpPrice: 4700,         // cents
  discount: 0,             // cents
  couponApplied: null,
  validCoupons: {
    'DESCONTO10': { type: 'percent', value: 10, label: '10% de desconto aplicado!' },
    'FRETE0': { type: 'shipping', value: 0, label: 'Frete grátis aplicado!' },
    'PROMO50': { type: 'fixed', value: 5000, label: 'R$ 50,00 de desconto aplicado!' },
  }
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  startCountdown();
  setupMasks();
  setupCardPreview();
  updateTotals();
});

// ===== COUNTDOWN =====
function startCountdown() {
  let totalSeconds = 9 * 60 + 47;
  const el = document.getElementById('countdown');
  const interval = setInterval(() => {
    if (totalSeconds <= 0) { clearInterval(interval); el.textContent = '00:00'; return; }
    totalSeconds--;
    const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    el.textContent = `${m}:${s}`;
    if (totalSeconds < 60) el.style.color = '#ef4444';
  }, 1000);
}

// ===== STEP NAVIGATION =====
function goToStep(targetStep) {
  if (targetStep > state.currentStep && !validateStep(state.currentStep)) return;

  const current = document.getElementById(`step-${state.currentStep}`);
  const target = document.getElementById(`step-${targetStep}`);
  const dots = document.querySelectorAll('.step');
  const lines = document.querySelectorAll('.step-line');

  current.classList.add('collapsed');
  target.classList.remove('collapsed');

  // Update progress
  dots.forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i + 1 < targetStep) dot.classList.add('done');
    if (i + 1 === targetStep) dot.classList.add('active');
  });
  lines.forEach((line, i) => {
    line.classList.toggle('done', i + 1 < targetStep);
  });

  // Update done step dots with checkmarks
  dots.forEach((dot, i) => {
    const inner = dot.querySelector('.step-dot span');
    if (dot.classList.contains('done')) {
      inner.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    } else {
      inner.textContent = i + 1;
    }
  });

  state.currentStep = targetStep;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== VALIDATION =====
function validateStep(step) {
  if (step === 1) return validatePersonalInfo();
  if (step === 2) return validateShipping();
  return true;
}

function validatePersonalInfo() {
  let valid = true;

  valid = validateField('name', val => val.trim().split(' ').length >= 2, 'Informe o nome completo') && valid;
  valid = validateField('email', val => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val), 'E-mail inválido') && valid;
  valid = validateField('phone', val => val.replace(/\D/g, '').length >= 10, 'Telefone inválido') && valid;
  valid = validateField('cpf', val => isValidCPF(val.replace(/\D/g, '')), 'CPF inválido') && valid;

  return valid;
}

function validateShipping() {
  let valid = true;
  valid = validateField('cep', val => val.replace(/\D/g, '').length === 8, 'CEP inválido') && valid;
  valid = validateField('street', val => val.trim().length > 2, 'Informe a rua') && valid;
  valid = validateField('number', val => val.trim().length > 0, 'Informe o número') && valid;
  valid = validateField('city', val => val.trim().length > 1, 'Informe a cidade') && valid;
  valid = validateField('state', val => val.trim().length === 2, 'UF inválida') && valid;
  return valid;
}

function validateField(id, rule, errorMsg) {
  const input = document.getElementById(id);
  const error = document.getElementById(`${id}-error`);
  if (!input) return true;
  const ok = rule(input.value);
  input.classList.toggle('error', !ok);
  input.classList.toggle('success', ok);
  if (error) error.textContent = ok ? '' : errorMsg;
  return ok;
}

// ===== CPF VALIDATION =====
function isValidCPF(cpf) {
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === parseInt(cpf[10]);
}

// ===== INPUT MASKS =====
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

  mask('cep', v => {
    const d = v.replace(/\D/g, '').slice(0, 8);
    return d.replace(/(\d{5})(\d{0,3})/, (_, a, b) => b ? `${a}-${b}` : a);
  });

  mask('card-number', v => {
    const d = v.replace(/\D/g, '').slice(0, 16);
    return d.replace(/(.{4})/g, '$1 ').trim();
  });

  mask('card-expiry', v => {
    const d = v.replace(/\D/g, '').slice(0, 4);
    return d.replace(/(\d{2})(\d{0,2})/, (_, a, b) => b ? `${a}/${b}` : a);
  });

  mask('card-cvv', v => v.replace(/\D/g, '').slice(0, 4));

  // Live card preview
  document.getElementById('card-name')?.addEventListener('input', e => {
    const el = document.getElementById('card-holder-display');
    if (el) el.textContent = e.target.value.toUpperCase() || 'SEU NOME';
  });
}

function mask(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', e => {
    const pos = e.target.selectionStart;
    const old = e.target.value;
    e.target.value = fn(e.target.value);
    try { e.target.setSelectionRange(pos, pos); } catch(_) {}
  });
}

// ===== CARD PREVIEW =====
function setupCardPreview() {
  const numEl = document.getElementById('card-number');
  const expEl = document.getElementById('card-expiry');

  numEl?.addEventListener('input', e => {
    const display = document.getElementById('card-number-display');
    const raw = e.target.value.replace(/\s/g, '');
    let formatted = raw.padEnd(16, '•').replace(/(.{4})/g, '$1 ').trim();
    if (display) display.textContent = formatted;

    // Detect brand
    detectCardBrand(raw);
  });

  expEl?.addEventListener('input', e => {
    const el = document.getElementById('card-expiry-display');
    if (el) el.textContent = e.target.value || 'MM/AA';
  });
}

function detectCardBrand(number) {
  const badge = document.getElementById('card-brand-badge');
  const brands = {
    Visa: /^4/,
    Master: /^5[1-5]|^2[2-7]/,
    Amex: /^3[47]/,
    Elo: /^4011|^4312|^4389|^4514|^4576|^5041|^5067|^509/,
    Hipercard: /^606282/,
  };
  let found = '';
  for (const [name, regex] of Object.entries(brands)) {
    if (regex.test(number)) { found = name; break; }
  }
  if (badge) badge.textContent = found;
}

// ===== CEP LOOKUP =====
async function fetchCEP() {
  const cep = document.getElementById('cep').value.replace(/\D/g, '');
  if (cep.length !== 8) {
    showFieldError('cep', 'CEP deve ter 8 dígitos');
    return;
  }
  const btn = document.querySelector('.btn-cep');
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = await res.json();
    if (data.erro) { showFieldError('cep', 'CEP não encontrado'); return; }
    document.getElementById('street').value = data.logradouro || '';
    document.getElementById('neighborhood').value = data.bairro || '';
    document.getElementById('city').value = data.localidade || '';
    document.getElementById('state').value = data.uf || '';
    document.getElementById('number').focus();
    document.getElementById('cep').classList.add('success');
    clearFieldError('cep');
  } catch (_) {
    showFieldError('cep', 'Erro ao buscar CEP. Tente novamente.');
  } finally {
    btn.textContent = 'Buscar';
    btn.disabled = false;
  }
}

function showFieldError(id, msg) {
  const el = document.getElementById(`${id}-error`);
  if (el) el.textContent = msg;
  document.getElementById(id)?.classList.add('error');
}
function clearFieldError(id) {
  const el = document.getElementById(`${id}-error`);
  if (el) el.textContent = '';
}

// ===== CEP on Enter =====
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cep')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchCEP();
  });
});

// ===== SHIPPING =====
function selectShipping(el, type, cents) {
  document.querySelectorAll('.shipping-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  state.shippingCost = cents;
  updateTotals();
}

// ===== PAYMENT METHOD =====
function selectPaymentMethod(method, btn) {
  document.querySelectorAll('.payment-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.payment-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`panel-${method}`)?.classList.remove('hidden');
  state.paymentMethod = method;

  const pixNote = document.getElementById('pix-note');
  if (pixNote) pixNote.style.display = method === 'pix' ? 'flex' : 'none';
  updateTotals();
}

// ===== ORDER BUMP =====
function toggleBump() {
  state.bumpAdded = !state.bumpAdded;
  const checkbox = document.getElementById('bump-checkbox');
  checkbox?.classList.toggle('checked', state.bumpAdded);
  updateTotals();
}

// ===== COUPON =====
function toggleCoupon() {
  const form = document.getElementById('coupon-form');
  if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function applyCoupon() {
  const code = document.getElementById('coupon-input')?.value.trim().toUpperCase();
  const feedback = document.getElementById('coupon-feedback');
  if (!code) return;

  if (state.validCoupons[code]) {
    const coupon = state.validCoupons[code];
    state.couponApplied = code;

    if (coupon.type === 'percent') {
      state.discount = Math.round(state.productPrice * coupon.value / 100);
    } else if (coupon.type === 'fixed') {
      state.discount = Math.min(coupon.value, state.productPrice);
    } else if (coupon.type === 'shipping') {
      state.shippingCost = 0;
      document.querySelectorAll('.shipping-option').forEach(o => o.classList.remove('selected'));
    }

    if (feedback) { feedback.textContent = coupon.label; feedback.className = 'coupon-feedback success'; }
    document.getElementById('discount-row').style.display = 'flex';
  } else {
    if (feedback) { feedback.textContent = 'Cupom inválido ou expirado.'; feedback.className = 'coupon-feedback error'; }
    state.discount = 0;
    state.couponApplied = null;
  }
  updateTotals();
}

// ===== TOTALS =====
function updateTotals() {
  const sub = state.productPrice + (state.bumpAdded ? state.bumpPrice : 0);
  const total = sub - state.discount + state.shippingCost;
  const pixTotal = Math.round(total * 0.95);

  fmt('subtotal', sub);
  fmt('total-price', total);
  fmt('pix-price', pixTotal);
  fmt('discount-value', -state.discount, true);
  fmt('shipping-cost', state.shippingCost, false, true);

  const discRow = document.getElementById('discount-row');
  if (discRow) discRow.style.display = state.discount > 0 ? 'flex' : 'none';
}

function fmt(id, cents, negative = false, isShipping = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (isShipping && cents === 0) { el.textContent = 'Grátis'; return; }
  const prefix = negative && cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  el.textContent = `${prefix}R$ ${(abs / 100).toFixed(2).replace('.', ',')}`;
}

// ===== SUBMIT =====
async function submitOrder() {
  if (!validatePayment()) return;

  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'flex';

  try {
    const payload = buildOrderPayload();
    const res = await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.reason || data.error || 'Erro ao processar pagamento');
    }

    state.lastOrder = data;
    showSuccess(data);
  } catch (err) {
    showToast(err.message || 'Erro de conexão. Verifique sua internet.');
  } finally {
    if (loadingOverlay) loadingOverlay.style.display = 'none';
  }
}

function buildOrderPayload() {
  const items = [
    { name: 'Curso Completo de Marketing Digital', quantity: 1, price: state.productPrice },
  ];
  if (state.bumpAdded) {
    items.push({ name: 'Mentoria em Grupo (4 semanas)', quantity: 1, price: state.bumpPrice });
  }

  const base = {
    customer: {
      name: document.getElementById('name')?.value.trim(),
      email: document.getElementById('email')?.value.trim(),
      cpf: document.getElementById('cpf')?.value,
      phone: document.getElementById('phone')?.value,
    },
    address: {
      cep: document.getElementById('cep')?.value,
      street: document.getElementById('street')?.value,
      number: document.getElementById('number')?.value,
      complement: document.getElementById('complement')?.value,
      neighborhood: document.getElementById('neighborhood')?.value,
      city: document.getElementById('city')?.value,
      state: document.getElementById('state')?.value,
    },
    items,
    shipping: { type: 'pac', cost: state.shippingCost },
  };

  if (state.paymentMethod === 'card') {
    return {
      ...base,
      payment: {
        method: 'card',
        // Em produção: substitua por token gerado pelo SDK FuriaPay no frontend
        // Ex: const token = await FuriaPay.tokenizeCard({ number, holder, expiry, cvv })
        cardToken: 'CARD_TOKEN_DO_SDK_FURIAPAY',
        holderName: document.getElementById('card-name')?.value.trim(),
        installments: document.getElementById('installments')?.value || '1',
      },
    };
  }

  return { ...base, payment: { method: state.paymentMethod } };
}

function validatePayment() {
  if (state.paymentMethod === 'card') {
    let valid = true;
    const num = document.getElementById('card-number')?.value.replace(/\s/g, '') || '';
    const name = document.getElementById('card-name')?.value.trim() || '';
    const exp = document.getElementById('card-expiry')?.value || '';
    const cvv = document.getElementById('card-cvv')?.value || '';

    if (num.length < 13) { showToast('Número do cartão inválido'); valid = false; }
    else if (name.split(' ').length < 2) { showToast('Informe o nome como no cartão'); valid = false; }
    else if (exp.length < 5) { showToast('Data de validade inválida'); valid = false; }
    else if (cvv.length < 3) { showToast('CVV inválido'); valid = false; }
    return valid;
  }
  return true;
}

function showSuccess(orderData = {}) {
  const modal = document.getElementById('success-modal');
  const emailDisplay = document.getElementById('confirm-email');
  const orderNumEl = document.getElementById('order-number');
  const pixFinal = document.getElementById('pix-qr-final');

  if (emailDisplay) emailDisplay.textContent = document.getElementById('email')?.value || 'seu e-mail';
  if (orderNumEl) orderNumEl.textContent = orderData.orderId || String(Math.floor(Math.random() * 900000) + 100000);

  if (state.paymentMethod === 'pix' && pixFinal) {
    pixFinal.style.display = 'block';
    // Se o backend retornou QR Code real, exibe a imagem
    if (orderData.pix?.qrCodeBase64) {
      const img = document.querySelector('.fake-qr');
      if (img) {
        const realImg = document.createElement('img');
        realImg.src = orderData.pix.qrCodeBase64;
        realImg.style.cssText = 'width:140px;height:140px;border-radius:4px';
        img.replaceWith(realImg);
      }
    }
    // Guarda o código para copiar
    if (orderData.pix?.qrCode) state.pixCode = orderData.pix.qrCode;
  } else if (pixFinal) {
    pixFinal.style.display = 'none';
  }

  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('success-modal');
  if (modal) modal.style.display = 'none';
}

function copyPixCode() {
  const code = state.pixCode || '00020126...';
  navigator.clipboard.writeText(code).then(() => {
    showToast('Código PIX copiado!', 'success');
  }).catch(() => {
    showToast('Não foi possível copiar. Copie manualmente.', 'info');
  });
}

// ===== TOAST =====
function showToast(msg, type = 'error') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  toast.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:${type === 'success' ? '#22c55e' : type === 'info' ? '#6C3CE1' : '#ef4444'};
    color:white; padding:12px 24px; border-radius:8px; font-size:.88rem;
    font-weight:600; z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,.2);
    animation:slideUp .3s ease; font-family:Inter,sans-serif; max-width:90vw; text-align:center;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== UTILS =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
