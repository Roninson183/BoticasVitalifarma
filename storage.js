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
  writeBatch, query, where, orderBy
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

  // Escritura
  saveProduct(p) {
    const id = p.id || doc(collection(fs, "products")).id;
    const data = {
      code: p.code, name: p.name, line: p.line,
      cost: p.cost, price: p.price,
      stock: p.stock, minStock: p.minStock, expiry: p.expiry
    };
    setDoc(doc(fs, "products", id), data).catch(fail);
    return { id, ...data };
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
    for (const it of items) {
      const p = this.product(it.id);
      if (!p) throw new Error("Un producto de la venta ya no existe.");
      if (p.stock < it.qty) throw new Error(`Stock insuficiente de "${p.name}" (quedan ${p.stock}).`);
    }

    const batch = writeBatch(fs);
    const alerts = [];
    const lines = items.map(it => {
      const p = this.product(it.id);
      batch.update(doc(fs, "products", p.id), { stock: increment(-it.qty) });
      alerts.push({ name: p.name, left: p.stock - it.qty, min: p.minStock });
      return { id: p.id, code: p.code, name: p.name, line: p.line, qty: it.qty, price: p.price, cost: p.cost };
    });

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
