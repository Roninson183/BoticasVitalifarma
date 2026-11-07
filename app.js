/* ============================================================
   app.js — Interfaz y lógica de la botica
   ============================================================ */

// ---------- Utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const money = n => 'S/ ' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LINES = { vitalifarma: 'BOTICAS VITALIFARMA', natural: 'PRODUCTOS NATURALES' };
const EXPIRY_WARN_DAYS = 30;   // avisar si vence dentro de 30 días
const SPLASH_MS = 2000;        // duración de la bienvenida

const state = {
  line: 'vitalifarma',
  view: 'catalog',
  search: '',
  cart: [],            // [{id, qty}]
  method: 'Efectivo',
  received: '',
  range: 7             // días del reporte
};

function daysToExpiry(p) {
  if (!p.expiry) return Infinity;
  const [y, m, d] = p.expiry.split('-').map(Number);
  const exp = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / 86400000);
}
const fmtExpiry = iso => iso ? iso.split('-').reverse().join('/') : 'Sin fecha';

// ---------- Avisos ----------
function toast(msg, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.12);
    setTimeout(() => ctx.close(), 300);
  } catch (e) { /* sin sonido */ }
}

// ---------- Alertas de stock y vencimiento ----------
function getAlerts() {
  const a = { out: [], low: [], expired: [], expiring: [] };
  DB.products().forEach(p => {
    if (p.stock === 0) a.out.push(p);
    else if (p.stock <= p.minStock) a.low.push(p);
    const d = daysToExpiry(p);
    if (d < 0) a.expired.push(p);
    else if (d <= EXPIRY_WARN_DAYS) a.expiring.push(p);
  });
  return a;
}

function updateAlerts() {
  const a = getAlerts();
  const stockCount = a.out.length + a.low.length;
  const total = stockCount + a.expired.length + a.expiring.length;
  const badge = $('#bellCount');
  badge.hidden = total === 0;
  badge.textContent = total;

  const bar = $('#alertBar');
  const parts = [];
  if (stockCount) parts.push(`${stockCount} producto(s) con stock bajo o agotado: reponer cuanto antes`);
  if (a.expired.length) parts.push(`${a.expired.length} vencido(s)`);
  if (parts.length) { bar.hidden = false; bar.textContent = '⚠️ ' + parts.join(' · ') + ' — toque para ver'; }
  else bar.hidden = true;
}

function showAlerts() {
  const a = getAlerts();
  const item = (cls, txt) => `<div class="alert-item ${cls}">${txt}</div>`;
  let html = '<h2>Alertas</h2>';
  const rows = [
    ...a.out.map(p => item('red', `<b>${esc(p.name)}</b>: AGOTADO. Reponer de inmediato.`)),
    ...a.low.map(p => item('orange', `<b>${esc(p.name)}</b>: quedan ${p.stock} (mínimo ${p.minStock}). Reponer cuanto antes.`)),
    ...a.expired.map(p => item('red', `<b>${esc(p.name)}</b>: VENCIDO el ${fmtExpiry(p.expiry)}. Retirar de la venta.`)),
    ...a.expiring.map(p => item('orange', `<b>${esc(p.name)}</b>: vence en ${daysToExpiry(p)} día(s) (${fmtExpiry(p.expiry)}).`))
  ];
  html += rows.length ? rows.join('') : '<p class="empty">Todo en orden. No hay alertas.</p>';
  openModal(html);
}

// ---------- Modal ----------
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-back" data-act="closeBack"><div class="modal">
    <button class="x" data-act="closeModal" aria-label="Cerrar">✕</button>${html}</div></div>`;
}
function closeModal() {
  if ($('#pfReader')) Scan.stop();   // solo apaga la cámara del formulario de producto
  $('#modalRoot').innerHTML = '';
}

// ---------- Lector de código de barras (cámara) ----------
const Scan = {
  inst: null, last: '', lastT: 0,

  async start(elId, onCode, keepOpen) {
    if (typeof Html5Qrcode === 'undefined') {
      toast('No cargó el lector de códigos. Revise su conexión a internet.', 'error'); return false;
    }
    await this.stop();
    const F = Html5QrcodeSupportedFormats;
    this.inst = new Html5Qrcode(elId, {
      verbose: false,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE]
    });
    try {
      await this.inst.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h * 0.6, 170)) }) },
        code => {
          const now = Date.now();
          // evita leer el mismo producto dos veces seguidas por error
          if (code === this.last && now - this.lastT < 1800) return;
          this.last = code; this.lastT = now;
          beep();
          onCode(code);
        },
        () => { /* sin lectura en este cuadro */ }
      );
      return true;
    } catch (e) {
      this.inst = null;
      toast('No se pudo abrir la cámara. Dé permiso de cámara al navegador (se necesita https o localhost).', 'error', 6000);
      return false;
    }
  },

  async stop() {
    if (!this.inst) return;
    try { await this.inst.stop(); this.inst.clear(); } catch (e) { /* ya detenida */ }
    this.inst = null;
  }
};

// ---------- Navegación ----------
async function go(view) {
  await Scan.stop();
  state.view = view;
  state.search = '';
  render();
}

let charts = [];
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

function render() {
  destroyCharts();
  document.querySelectorAll('#lineTabs button').forEach(b => b.classList.toggle('active', b.dataset.line === state.line));
  document.querySelectorAll('#mainNav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  const v = $('#view');
  v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
  if (state.view === 'catalog') v.innerHTML = viewCatalog();
  else if (state.view === 'products') v.innerHTML = viewProducts();
  else if (state.view === 'sell') { v.innerHTML = viewSell(); renderCart(); }
  else if (state.view === 'reports') { v.innerHTML = viewReports(); drawCharts(); animateKpis(); }
  updateAlerts();
}

// ---------- Catálogo e inventario ----------
function productCard(p, admin) {
  const d = daysToExpiry(p);
  const stockBadge = p.stock === 0 ? '<span class="badge red">Agotado</span>'
    : p.stock <= p.minStock ? '<span class="badge orange">Stock bajo</span>'
    : '<span class="badge green">Disponible</span>';
  let expBadge = '';
  if (d < 0) expBadge = '<span class="badge red">Vencido</span>';
  else if (d <= EXPIRY_WARN_DAYS) expBadge = `<span class="badge orange">Vence en ${d} d</span>`;
  const cls = (p.stock === 0 || d < 0) ? 'bad' : (p.stock <= p.minStock || d <= EXPIRY_WARN_DAYS) ? 'warn' : '';
  const margin = p.price - p.cost;
  return `<article class="product ${cls}">
    <h3>${esc(p.name)}</h3>
    <div class="code">Código: ${esc(p.code)}</div>
    <div class="price">${money(p.price)}</div>
    <div class="meta"><span>Stock: <b>${p.stock}</b></span><span>Vence: <b>${fmtExpiry(p.expiry)}</b></span></div>
    <div class="badges">${stockBadge}${expBadge}</div>
    ${admin ? `<div class="meta"><span>Costo: <b>${money(p.cost)}</b></span><span>Ganancia: <b>${money(margin)}</b></span></div>
    <div class="actions">
      <button class="btn sm" data-act="edit" data-id="${p.id}">Editar</button>
      <button class="btn sm" data-act="restock" data-id="${p.id}">+ Reponer</button>
      <button class="btn sm danger" data-act="del" data-id="${p.id}">Eliminar</button>
    </div>` : ''}
  </article>`;
}

function listHtml(admin) {
  const q = state.search.trim().toLowerCase();
  const items = DB.products()
    .filter(p => p.line === state.line)
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.code.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!items.length) return `<div class="empty">No hay productos en ${LINES[state.line]}${q ? ' con esa búsqueda' : ''}.</div>`;
  return `<div class="products">${items.map(p => productCard(p, admin)).join('')}</div>`;
}

function viewCatalog() {
  return `<h2>Catálogo · ${LINES[state.line]}</h2>
    <div class="toolbar"><input type="search" data-search="catalog" placeholder="Buscar por nombre o código…" value="${esc(state.search)}"></div>
    <div id="list">${listHtml(false)}</div>`;
}

function viewProducts() {
  return `<h2>Inventario · ${LINES[state.line]}</h2>
    <div class="toolbar">
      <input type="search" data-search="products" placeholder="Buscar por nombre o código…" value="${esc(state.search)}">
      <button class="btn primary" data-act="newProduct">+ Nuevo producto</button>
    </div>
    <div id="list">${listHtml(true)}</div>
    <div class="card" style="margin-top:24px">
      <h2 style="font-size:17px">Respaldo de datos</h2>
      <p class="hint" style="margin-bottom:10px">Los datos están en la nube y se sincronizan en todos los dispositivos. Puede descargar una copia cuando quiera.</p>
      <div class="actions">
        <button class="btn" data-act="export">Descargar copia</button>
      </div>
    </div>`;
}

function productForm(id) {
  const p = id ? DB.product(id) : { code: '', name: '', line: state.line, cost: '', price: '', stock: '', minStock: 10, expiry: '' };
  openModal(`<h2>${id ? 'Editar' : 'Nuevo'} producto</h2>
    <form id="pf" data-id="${id || ''}">
      <label>Código de barras</label>
      <div class="row">
        <input id="pfCode" required value="${esc(p.code)}" inputmode="numeric">
        <button type="button" class="btn" data-act="scanForm">📷</button>
      </div>
      <div id="pfReaderWrap" hidden style="margin-top:8px"><div id="pfReader"></div></div>
      <label>Nombre</label>
      <input id="pfName" required value="${esc(p.name)}">
      <label>Sección</label>
      <select id="pfLine">
        <option value="vitalifarma" ${p.line === 'vitalifarma' ? 'selected' : ''}>${LINES.vitalifarma}</option>
        <option value="natural" ${p.line === 'natural' ? 'selected' : ''}>${LINES.natural}</option>
      </select>
      <div class="grid2">
        <div><label>Precio de costo (S/)</label><input id="pfCost" type="number" step="0.01" min="0" required value="${p.cost}"></div>
        <div><label>Precio de venta (S/)</label><input id="pfPrice" type="number" step="0.01" min="0.01" required value="${p.price}"></div>
        <div><label>Stock actual</label><input id="pfStock" type="number" step="1" min="0" required value="${p.stock}"></div>
        <div><label>Stock mínimo (alerta)</label><input id="pfMin" type="number" step="1" min="0" required value="${p.minStock}"></div>
      </div>
      <label>Fecha de vencimiento</label>
      <input id="pfExp" type="date" required value="${p.expiry}">
      <button class="btn primary big" style="margin-top:18px" type="submit">Guardar producto</button>
    </form>`);
}

function saveProductForm(form) {
  const id = form.dataset.id;
  const code = $('#pfCode').value.trim();
  const dup = DB.byCode(code);
  if (dup && dup.id !== id) { toast(`Ese código ya pertenece a "${dup.name}".`, 'error'); return; }
  const p = {
    id: id || undefined,
    code,
    name: $('#pfName').value.trim(),
    line: $('#pfLine').value,
    cost: Number($('#pfCost').value),
    price: Number($('#pfPrice').value),
    stock: parseInt($('#pfStock').value, 10),
    minStock: parseInt($('#pfMin').value, 10),
    expiry: $('#pfExp').value
  };
  if (!p.name || !p.code) { toast('Complete código y nombre.', 'error'); return; }
  if (p.price < p.cost && !confirm('El precio de venta es menor al costo. ¿Guardar de todos modos?')) return;
  DB.saveProduct(p);
  closeModal();
  toast('Producto guardado', 'ok');
  state.line = p.line;
  render();
}

// ---------- Ventas ----------
function viewSell() {
  return `<div class="sell">
    <section class="card">
      <h2>Agregar productos</h2>
      <button class="btn primary big" data-act="scan">📷 Escanear con la cámara</button>
      <div id="readerWrap" hidden>
        <div id="reader"></div>
        <button class="btn" style="margin-top:8px;width:100%" data-act="stopscan">Cerrar cámara</button>
        <p class="hint" style="margin-top:6px">Apunte al código de barras. Cada producto leído se suma a la venta.</p>
      </div>
      <div class="row">
        <input id="manualCode" placeholder="Escribir o pasar lector USB" inputmode="numeric" autocomplete="off">
        <button class="btn" data-act="addcode">Agregar</button>
      </div>
      <input id="sellSearch" type="search" placeholder="O buscar por nombre…" autocomplete="off">
      <div id="sellResults" class="suggest"></div>
    </section>
    <section class="card">
      <h2>Venta actual</h2>
      <label for="sellerName" style="margin-top:0">Vendedor (quién atiende)</label>
      <input id="sellerName" placeholder="Ej: Rosa" value="${esc(getSeller())}" autocomplete="off">
      <div id="cartBox"></div>
    </section>
  </div>`;
}

function cartAdd(p) {
  if (daysToExpiry(p) < 0) { toast(`"${p.name}" está VENCIDO. No se puede vender.`, 'error', 5000); return; }
  if (p.stock <= 0) { toast(`"${p.name}" está agotado.`, 'error'); return; }
  const line = state.cart.find(c => c.id === p.id);
  if (line) {
    if (line.qty + 1 > p.stock) { toast(`Solo hay ${p.stock} de "${p.name}".`, 'warn'); return; }
    line.qty++;
  } else state.cart.push({ id: p.id, qty: 1 });
  renderCart();
}

function addByCode(code) {
  const c = String(code).trim();
  if (!c) return;
  const p = DB.byCode(c);
  if (!p) { toast(`Código ${c} no registrado en el inventario.`, 'error'); return; }
  cartAdd(p);
}

function cartTotal() {
  return state.cart.reduce((s, c) => s + DB.product(c.id).price * c.qty, 0);
}

function renderCart() {
  const box = $('#cartBox');
  if (!box) return;
  if (!state.cart.length) {
    box.innerHTML = '<div class="empty">Aún no hay productos.<br>Escanee o busque para comenzar.</div>';
    return;
  }
  const total = cartTotal();
  const lines = state.cart.map(c => {
    const p = DB.product(c.id);
    return `<div class="cart-line">
      <div><div class="n">${esc(p.name)}</div><div class="u">${money(p.price)} c/u · ${money(p.price * c.qty)}</div></div>
      <div class="qty">
        <button data-act="dec" data-id="${c.id}" aria-label="Quitar uno">−</button>
        <span>${c.qty}</span>
        <button data-act="inc" data-id="${c.id}" aria-label="Agregar uno">+</button>
        <button data-act="rm" data-id="${c.id}" aria-label="Quitar producto">✕</button>
      </div></div>`;
  }).join('');
  box.innerHTML = `${lines}
    <div class="total"><span>Total a pagar</span><b>${money(total)}</b></div>
    <label style="margin-top:0">Método de pago</label>
    <div class="methods">
      ${['Yape', 'Plin', 'Efectivo'].map(m => `<button data-act="method" data-m="${m}" class="${state.method === m ? 'active' : ''}">${m}</button>`).join('')}
    </div>
    ${state.method === 'Efectivo'
      ? `<label>Efectivo recibido (opcional)</label>
         <input id="recv" type="number" step="0.1" min="0" inputmode="decimal" value="${esc(state.received)}" placeholder="0.00">
         <p class="hint" style="margin-top:6px">Vuelto: <span id="changeOut" class="change">${changeText(total)}</span></p>`
      : `<p class="hint" style="margin-top:10px">Confirme que el pago por ${state.method} llegó antes de concretar la venta.</p>`}
    <button class="btn primary big" style="margin-top:14px" data-act="confirm">Concretar venta · ${money(total)}</button>
    <button class="btn big" style="margin-top:8px" data-act="clearCart">Cancelar venta</button>`;
}

function changeText(total) {
  if (state.received === '') return '—';
  const diff = Number(state.received) - total;
  return diff >= 0 ? money(diff) : 'Falta ' + money(-diff);
}

function confirmSale() {
  if (!state.cart.length) return;
  if (!getSeller().trim()) {
    toast('Escriba el nombre del vendedor para registrar la venta.', 'warn');
    const i = $('#sellerName'); if (i) i.focus();
    return;
  }
  const total = cartTotal();
  if (state.method === 'Efectivo' && state.received !== '' && Number(state.received) < total) {
    toast('El efectivo recibido no alcanza para el total.', 'error'); return;
  }
  let sale;
  try { sale = DB.addSale(state.cart, state.method, state.method === 'Efectivo' ? state.received : '', userLabel()); }
  catch (e) { toast(e.message, 'error', 6000); renderCart(); return; }

  // Avisos de stock bajo después de vender
  sale.alerts.forEach(a => {
    if (a.left <= 0) toast(`🚨 "${a.name}" se AGOTÓ. Reponer cuanto antes.`, 'error', 8000);
    else if (a.left <= a.min) toast(`⚠️ Stock bajo de "${a.name}": quedan ${a.left}. Reponer cuanto antes.`, 'warn', 8000);
  });

  state.cart = []; state.received = '';
  Scan.stop().then(() => {
    openModal(`<div class="receipt">
      <div style="font-size:42px">✅</div>
      <h2>Venta registrada</h2>
      <div class="big">${money(sale.total)}</div>
      <p>Pago: <b>${sale.method}</b></p>
      ${sale.change != null && sale.change >= 0 ? `<p>Vuelto: <b>${money(sale.change)}</b></p>` : ''}
      <button class="btn primary big" style="margin-top:16px" data-act="closeModal">Nueva venta</button>
    </div>`);
    render();
  });
}

// ---------- Reportes ----------
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function reportData() {
  const n = state.range;
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (n - 1));
  const sales = DB.sales().filter(s => s.ts >= start.getTime());

  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    days.push({ key: dayKey(d.getTime()), label: d.toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric' }), total: 0, profit: 0 });
  }
  const byDay = Object.fromEntries(days.map(d => [d.key, d]));
  const prod = {}; const pay = { Yape: 0, Plin: 0, Efectivo: 0 };
  let units = 0;

  sales.forEach(s => {
    const d = byDay[dayKey(s.ts)];
    if (d) { d.total += s.total; d.profit += s.profit; }
    pay[s.method] = (pay[s.method] || 0) + s.total;
    s.lines.forEach(l => {
      units += l.qty;
      prod[l.name] = prod[l.name] || { name: l.name, qty: 0, revenue: 0 };
      prod[l.name].qty += l.qty; prod[l.name].revenue += l.price * l.qty;
    });
  });

  return {
    sales, days, pay, units,
    top: Object.values(prod).sort((a, b) => b.qty - a.qty).slice(0, 8),
    total: sales.reduce((s, x) => s + x.total, 0),
    profit: sales.reduce((s, x) => s + x.profit, 0)
  };
}

function viewReports() {
  const r = reportData();
  const hist = r.sales.slice().reverse().slice(0, 20).map(s => `
    <div class="h-row">
      <span>${new Date(s.ts).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}<br><small class="hint">${esc(s.by || '')}</small></span>
      <span>${s.method}</span><span>${money(s.total)}</span><span>${money(s.profit)}</span>
    </div>`).join('');

  return `<h2>Reportes de ventas</h2>
    <div class="toolbar">
      <select id="rangeSel" data-range>
        <option value="7" ${state.range === 7 ? 'selected' : ''}>Últimos 7 días (semana)</option>
        <option value="14" ${state.range === 14 ? 'selected' : ''}>Últimos 14 días</option>
        <option value="30" ${state.range === 30 ? 'selected' : ''}>Últimos 30 días</option>
      </select>
    </div>
    <div class="kpis">
      <div class="kpi"><small>Ventas totales</small><b data-v="${r.total}" data-m="1">${money(r.total)}</b></div>
      <div class="kpi profit"><small>Ganancia neta</small><b data-v="${r.profit}" data-m="1">${money(r.profit)}</b></div>
      <div class="kpi"><small>N.º de ventas</small><b data-v="${r.sales.length}">${r.sales.length}</b></div>
      <div class="kpi"><small>Unidades vendidas</small><b data-v="${r.units}">${r.units}</b></div>
    </div>
    ${typeof Chart === 'undefined' ? '<div class="card empty">No cargaron los gráficos. Revise su conexión a internet.</div>' : `
    <div class="charts">
      <div class="card wide"><h2 style="font-size:17px">Ventas y ganancia neta por día</h2><div class="chart-box"><canvas id="chDays"></canvas></div></div>
      <div class="card"><h2 style="font-size:17px">Productos más vendidos (unidades)</h2><div class="chart-box"><canvas id="chTop"></canvas></div></div>
      <div class="card"><h2 style="font-size:17px">Ventas por método de pago</h2><div class="chart-box"><canvas id="chPay"></canvas></div></div>
    </div>`}
    <div class="card history">
      <h2 style="font-size:17px">Últimas ventas</h2>
      <div class="h-row head"><span>Fecha</span><span>Pago</span><span>Total</span><span>Ganancia</span></div>
      ${hist || '<div class="empty">Todavía no hay ventas en este periodo.</div>'}
    </div>`;
}

function drawCharts() {
  if (typeof Chart === 'undefined') return;
  const r = reportData();
  const green = '#1d2399', mint = '#8a95ff', amber = '#e3a11c';
  const common = { responsive: true, maintainAspectRatio: false };

  charts.push(new Chart($('#chDays'), {
    type: 'bar',
    data: {
      labels: r.days.map(d => d.label),
      datasets: [
        { label: 'Ventas (S/)', data: r.days.map(d => +d.total.toFixed(2)), backgroundColor: green, borderRadius: 6 },
        { label: 'Ganancia neta (S/)', data: r.days.map(d => +d.profit.toFixed(2)), backgroundColor: mint, borderRadius: 6 }
      ]
    },
    options: { ...common, scales: { y: { beginAtZero: true } } }
  }));

  charts.push(new Chart($('#chTop'), {
    type: 'bar',
    data: { labels: r.top.map(t => t.name), datasets: [{ label: 'Unidades', data: r.top.map(t => t.qty), backgroundColor: green, borderRadius: 6 }] },
    options: { ...common, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
  }));

  charts.push(new Chart($('#chPay'), {
    type: 'doughnut',
    data: { labels: Object.keys(r.pay), datasets: [{ data: Object.values(r.pay).map(v => +v.toFixed(2)), backgroundColor: ['#6a2c91', '#1aa6c7', '#2e9e70'] }] },
    options: { ...common, plugins: { legend: { position: 'bottom' } } }
  }));
}

function animateKpis() {
  document.querySelectorAll('.kpi b[data-v]').forEach(el => {
    const end = Number(el.dataset.v), isMoney = !!el.dataset.m, t0 = performance.now(), dur = 700;
    const step = t => {
      const k = Math.min(1, (t - t0) / dur), val = end * (1 - Math.pow(1 - k, 3));
      el.textContent = isMoney ? money(val) : Math.round(val);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- Eventos ----------
const actions = {
  tab(el) { Scan.stop(); state.line = el.dataset.line; state.search = ''; render(); },
  nav(el) { go(el.dataset.view); },
  bell: showAlerts,
  closeModal,
  closeBack(el, e) { if (e.target === el) closeModal(); },

  // Inventario
  newProduct() { productForm(null); },
  edit(el) { productForm(el.dataset.id); },
  restock(el) {
    const p = DB.product(el.dataset.id);
    openModal(`<h2>Reponer stock</h2><p><b>${esc(p.name)}</b><br>Stock actual: ${p.stock}</p>
      <form id="rf" data-id="${p.id}"><label>Cantidad que ingresa</label>
      <input id="rfQty" type="number" min="1" step="1" required autofocus>
      <button class="btn primary big" style="margin-top:16px" type="submit">Agregar al stock</button></form>`);
  },
  del(el) {
    const p = DB.product(el.dataset.id);
    if (confirm(`¿Eliminar "${p.name}" del inventario?`)) { DB.removeProduct(p.id); toast('Producto eliminado', 'ok'); render(); }
  },
  scanForm() {
    $('#pfReaderWrap').hidden = false;
    Scan.start('pfReader', code => {
      $('#pfCode').value = code;
      Scan.stop().then(() => { const w = $('#pfReaderWrap'); if (w) w.hidden = true; });
    });
  },
  export() {
    const blob = new Blob([DB.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `respaldo-botica-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  },

  // Venta
  async scan() {
    $('#readerWrap').hidden = false;
    const ok = await Scan.start('reader', addByCode);
    if (!ok) $('#readerWrap').hidden = true;
  },
  async stopscan() { await Scan.stop(); $('#readerWrap').hidden = true; },
  addcode() { const i = $('#manualCode'); addByCode(i.value); i.value = ''; i.focus(); },
  addid(el) { const p = DB.product(el.dataset.id); if (p) cartAdd(p); $('#sellSearch').value = ''; $('#sellResults').innerHTML = ''; },
  inc(el) { const p = DB.product(el.dataset.id); const l = state.cart.find(c => c.id === p.id); if (l.qty + 1 > p.stock) toast(`Solo hay ${p.stock} de "${p.name}".`, 'warn'); else { l.qty++; renderCart(); } },
  dec(el) { const l = state.cart.find(c => c.id === el.dataset.id); l.qty--; if (l.qty <= 0) state.cart = state.cart.filter(c => c !== l); renderCart(); },
  rm(el) { state.cart = state.cart.filter(c => c.id !== el.dataset.id); renderCart(); },
  method(el) { state.method = el.dataset.m; renderCart(); },
  confirm: confirmSale,
  clearCart() { if (confirm('¿Cancelar la venta actual?')) { state.cart = []; state.received = ''; renderCart(); } }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'pf') saveProductForm(e.target);
  if (e.target.id === 'rf') {
    const qty = parseInt($('#rfQty').value, 10);
    if (qty > 0) { DB.restock(e.target.dataset.id, qty); closeModal(); toast('Stock actualizado', 'ok'); render(); }
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.search) {
    state.search = t.value;
    $('#list').innerHTML = listHtml(t.dataset.search === 'products');
  } else if (t.id === 'sellSearch') {
    const q = t.value.trim().toLowerCase();
    const box = $('#sellResults');
    if (q.length < 2) { box.innerHTML = ''; return; }
    const res = DB.products().filter(p => p.name.toLowerCase().includes(q)).slice(0, 6);
    box.innerHTML = res.length
      ? res.map(p => `<button data-act="addid" data-id="${p.id}"><span>${esc(p.name)}</span><b>${money(p.price)} · stock ${p.stock}</b></button>`).join('')
      : '<p class="hint">Sin resultados.</p>';
  } else if (t.id === 'sellerName') {
    try { localStorage.setItem(SELLER_KEY, t.value); } catch (err) { /* sin guardar */ }
  } else if (t.id === 'recv') {
    state.received = t.value;
    $('#changeOut').textContent = changeText(cartTotal());
  }
});

document.addEventListener('change', e => {
  if (e.target.dataset.range !== undefined) { state.range = Number(e.target.value); render(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'manualCode') { e.preventDefault(); actions.addcode(); }
  if (e.key === 'Escape') closeModal();
});

// ---------- Conexión y sincronización ----------
let splashDone = false;
let connError = '';
let dataLoaded = false;
let firstData = true;
let reportTimer = null;

const SELLER_KEY = 'vitalifarma_vendedor';
function getSeller() { try { return localStorage.getItem(SELLER_KEY) || ''; } catch (e) { return ''; } }
const userLabel = () => getSeller().trim() || 'Sin nombre';

// Explica en español los errores de configuración de Firebase
function authHint(code) {
  const map = {
    'config/missing': 'Falta configurar firebase-config.js con los datos de su proyecto Firebase.',
    'auth/operation-not-allowed': 'Active el acceso "Anónimo" en Firebase → Authentication → Método de acceso.',
    'auth/admin-restricted-operation': 'Active el acceso "Anónimo" en Firebase → Authentication → Método de acceso.',
    'auth/configuration-not-found': 'Falta iniciar Authentication en Firebase (botón "Comenzar" en la sección Authentication).',
    'auth/invalid-api-key': 'La apiKey de firebase-config.js no es correcta. Vuelva a copiarla desde Firebase.',
    'auth/network-request-failed': 'Sin conexión a internet.'
  };
  return map[code] || null;
}

function showApp() {
  if (!splashDone || !(dataLoaded || connError)) return;
  window.__ready = true;
  $('#app').hidden = false;
  const f = $('#fatal');
  f.hidden = !connError;
  f.textContent = connError;
  render();
}

// Se ejecuta cada vez que cambian los datos (desde cualquier dispositivo)
function refresh() {
  updateAlerts();
  if (state.view === 'catalog' || state.view === 'products') {
    const l = $('#list');
    if (l) l.innerHTML = listHtml(state.view === 'products');
  } else if (state.view === 'sell') {
    // si otro dispositivo vendió el mismo producto, ajusta lo que hay en el carrito
    state.cart = state.cart.filter(c => {
      const p = DB.product(c.id);
      if (!p) return false;
      if (c.qty > p.stock) c.qty = p.stock;
      return c.qty > 0;
    });
    renderCart();
  } else if (state.view === 'reports') {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => { if (state.view === 'reports') render(); }, 300);
  }
  if (firstData) {
    firstData = false;
    const a = getAlerts();
    const low = a.out.length + a.low.length;
    if (low) toast(`⚠️ ${low} producto(s) con stock bajo o agotado. Reponer cuanto antes.`, 'warn', 7000);
  }
}

DB.onAuth((user, err) => {
  connError = err ? (authHint(err.code) || `No se pudo conectar (${err.code || 'error desconocido'}).`) : '';
  showApp();
});
DB.onChange(() => {
  if (!dataLoaded) { dataLoaded = true; showApp(); return; }
  refresh();
});
DB.onRemoteLow(p => toast(`⚠️ Se vendió "${p.name}" en otro equipo: quedan ${p.stock}. Reponer cuanto antes.`, 'warn', 8000));
DB.onError(msg => toast(msg, 'error', 6000));

// ---------- Inicio ----------
setTimeout(() => {
  splashDone = true;
  const sp = $('#splash');
  if (sp) { sp.classList.add('hide'); setTimeout(() => sp.remove(), 600); }
  showApp();
}, SPLASH_MS);
