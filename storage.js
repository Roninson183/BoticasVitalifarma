/* ============================================================
   storage.js — Datos compartidos en la nube (Firebase)
   - Productos y ventas se sincronizan en tiempo real entre
     todos los dispositivos del personal.
   - Cada vendedor entra con su correo y clave.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, updateDoc, increment,
  writeBatch, query, where, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const configured = !String(firebaseConfig.apiKey).startsWith("PEGUE");
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let auth = null, fs = null;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // La caché local permite seguir viendo datos si se corta el internet un momento
  fs = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
}

// ---------- Estado local (se actualiza solo desde la nube) ----------
let products = [];
let sales = [];
let unsubs = [];
const changeCbs = new Set();
let lowCb = () => {};
let errCb = () => {};

const emit = () => changeCbs.forEach(cb => cb());

function fail(err) {
  console.error(err);
  const code = err && err.code;
  if (code === "permission-denied") errCb("Sin permiso en la base de datos. Revise las reglas de Firestore.");
  else if (code === "not-found") errCb("No existe la base de datos. En Firebase → Firestore Database, pulse \"Crear base de datos\".");
  else if (code === "unauthenticated") errCb("No se pudo iniciar la conexión anónima. Active el acceso Anónimo en Authentication.");
  else if (code === "unavailable") errCb("Sin conexión. Los cambios se enviarán cuando vuelva el internet.");
  else errCb("Error: " + (err && err.message ? err.message : err));
}

function startListeners() {
  stopListeners();

  unsubs.push(onSnapshot(collection(fs, "products"), snap => {
    // Aviso cuando OTRO dispositivo vende y deja un producto con stock bajo
    snap.docChanges().forEach(ch => {
      if (ch.type !== "modified" || ch.doc.metadata.hasPendingWrites) return;
      const d = ch.doc.data();
      const prev = products.find(p => p.id === ch.doc.id);
      if (prev && d.stock < prev.stock && d.stock <= d.minStock) lowCb({ id: ch.doc.id, ...d });
    });
    products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emit();
  }, fail));

  // Solo se cargan las ventas de los últimos 35 días (el reporte máximo es de 30)
  const since = Date.now() - 35 * 86400000;
  unsubs.push(onSnapshot(
    query(collection(fs, "sales"), where("ts", ">=", since), orderBy("ts")),
    snap => {
      sales = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    }, fail));
}

function stopListeners() {
  unsubs.forEach(u => u());
  unsubs = [];
  products = []; sales = [];
}

// ---------- API que usa la aplicación ----------
window.DB = {
  configured,

  // Conexión automática (sin pantalla de ingreso): cb(usuario, error)
  onAuth(cb) {
    if (!configured) { cb(null, { code: "config/missing" }); return; }
    onAuthStateChanged(auth, user => {
      if (user) { startListeners(); cb(user, null); }
      else signInAnonymously(auth).catch(err => { stopListeners(); cb(null, err); });
    });
  },

  // Suscripciones
  onChange(cb) { changeCbs.add(cb); },
  onRemoteLow(cb) { lowCb = cb; },
  onError(cb) { errCb = cb; },

  // Lectura (instantánea, desde la copia local sincronizada)
  products: () => products,
  product: id => products.find(p => p.id === id),
  byCode: code => products.find(p => p.code === String(code).trim()),
  sales: () => sales,

  /* Presentaciones: el stock siempre se cuenta en UNIDADES sueltas.
     pres(p, 'unit' | 'blister' | 'box') -> { key, label, units, price }
     Si el producto no tiene esa presentación, devuelve la unidad. */
  pres(p, key) {
    if (key === "blister" && p.blisterUnits > 0 && p.blisterPrice > 0)
      return { key, label: "Blister", units: p.blisterUnits, price: p.blisterPrice };
    if (key === "box" && p.boxUnits > 0 && p.boxPrice > 0)
      return { key, label: "Caja", units: p.boxUnits, price: p.boxPrice };
    return { key: "unit", label: "Unidad", units: 1, price: p.price };
  },
  presList(p) {
    return ["unit", "blister", "box"]
      .map(k => this.pres(p, k))
      .filter((o, i, arr) => arr.findIndex(x => x.key === o.key) === i);
  },

  // Escritura
  saveProduct(p) {
    const id = p.id || doc(collection(fs, "products")).id;
    const data = {
      code: p.code, name: p.name, line: p.line,
      cost: p.cost, price: p.price,
      stock: p.stock, minStock: p.minStock, expiry: p.expiry,
      blisterUnits: p.blisterUnits || 0, blisterPrice: p.blisterPrice || 0,
      boxUnits: p.boxUnits || 0, boxPrice: p.boxPrice || 0
    };
    setDoc(doc(fs, "products", id), data).catch(fail);
    return { id, ...data };
  },

  // Elimina productos del inventario (todos, o solo los de una sección). Las ventas NO se tocan.
  async clearInventory(line) {
    const targets = products.filter(p => !line || p.line === line);
    for (let i = 0; i < targets.length; i += 400) {
      const batch = writeBatch(fs);
      targets.slice(i, i + 400).forEach(p => batch.delete(doc(fs, "products", p.id)));
      await batch.commit();
    }
    return targets.length;
  },

  // Historial de ventas completo (no solo los últimos 35 días)
  async allSales() {
    const snap = await getDocs(collection(fs, "sales"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.ts - b.ts);
  },

  // Borra ventas del historial. El stock de los productos NO cambia.
  async deleteSales(list) {
    for (let i = 0; i < list.length; i += 400) {
      const batch = writeBatch(fs);
      list.slice(i, i + 400).forEach(s => batch.delete(doc(fs, "sales", s.id)));
      await batch.commit();
    }
    return list.length;
  },

  removeProduct(id) {
    deleteDoc(doc(fs, "products", id)).catch(fail);
  },

  restock(id, qty) {
    // increment() suma sobre el valor real de la nube, aunque dos personas repongan a la vez
    updateDoc(doc(fs, "products", id), { stock: increment(Number(qty)) }).catch(fail);
  },

  /* Registra la venta y DESCUENTA el stock en todos los dispositivos.
     items: [{id, qty}]  method: 'Yape' | 'Plin' | 'Efectivo' */
  addSale(items, method, received, by) {
    // 1) Calcular cuántas UNIDADES se llevan de cada producto
    const need = {};
    const rows = items.map(it => {
      const p = this.product(it.id);
      if (!p) throw new Error("Un producto de la venta ya no existe.");
      const pr = this.pres(p, it.pres);
      need[p.id] = (need[p.id] || 0) + it.qty * pr.units;
      return { p, pr, qty: it.qty };
    });
    for (const id in need) {
      const p = this.product(id);
      if (p.stock < need[id]) throw new Error(`Stock insuficiente de "${p.name}" (quedan ${p.stock} unidades).`);
    }

    // 2) Descontar el stock en la nube (en unidades) y avisar si queda bajo
    const batch = writeBatch(fs);
    const alerts = [];
    for (const id in need) {
      const p = this.product(id);
      batch.update(doc(fs, "products", id), { stock: increment(-need[id]) });
      alerts.push({ name: p.name, left: p.stock - need[id], min: p.minStock });
    }

    // 3) Detalle de la venta (precio y costo de la presentación vendida)
    const lines = rows.map(({ p, pr, qty }) => ({
      id: p.id, code: p.code, name: p.name, line: p.line,
      pres: pr.key, presLabel: pr.label, units: pr.units, qty,
      price: pr.price, cost: Math.round(p.cost * pr.units * 10000) / 10000
    }));

    const total = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
    const profit = round2(lines.reduce((s, l) => s + (l.price - l.cost) * l.qty, 0));
    const rec = method === "Efectivo" && received !== "" && received != null ? Number(received) : null;
    const sale = {
      ts: Date.now(), method, total, profit,
      received: rec, change: rec != null ? round2(rec - total) : null,
      by: by || "", lines
    };

    const saleRef = doc(collection(fs, "sales"));
    batch.set(saleRef, sale);
    batch.commit().catch(fail);

    return { id: saleRef.id, ...sale, alerts };
  },

  exportJSON: () => JSON.stringify({ products, sales }, null, 2)
};
