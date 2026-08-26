// board.js — the Ledger data model, shared by every tool.
// This mirrors exactly what the Ledger web app stores in Firestore at
// ledger/main, so records written here are read by the app with no
// translation, and vice-versa.

import admin from "firebase-admin";

const DOC_PATH = { collection: "ledger", doc: "main" };

export const DEFCATS = [
  { id: "work", name: "Work", color: "#5BA8F5" },
  { id: "personal", name: "Personal", color: "#4DD9B0" },
  { id: "home", name: "Home", color: "#9B8CFF" },
  { id: "finance", name: "Finance", color: "#F0A23C" },
  { id: "health", name: "Health", color: "#F2586A" }
];

// Same id generator the app uses.
export const uid = () => Math.random().toString(36).slice(2, 10);

let _db = null;
export function db() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      let creds;
      try { creds = JSON.parse(raw); }
      catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON: " + e.message); }
      // Render/Railway often escape newlines in the private key — undo that.
      if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    } else {
      // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path if set.
      admin.initializeApp();
    }
  }
  _db = admin.firestore();
  return _db;
}

function ref() { return db().collection(DOC_PATH.collection).doc(DOC_PATH.doc); }

function normalize(data) {
  data = data || {};
  data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  data.bills = Array.isArray(data.bills) ? data.bills : [];
  data.cats = (Array.isArray(data.cats) && data.cats.length) ? data.cats : DEFCATS.slice();
  data.notes = Array.isArray(data.notes) ? data.notes : [];
  data.staples = Array.isArray(data.staples) ? data.staples : [];
  return data;
}

// Read the whole board (no write).
export async function readBoard() {
  const snap = await ref().get();
  return normalize(snap.exists ? snap.data() : {});
}

// Atomically read → mutate → write. `fn(board)` returns the tool's result;
// the mutated board is persisted with a fresh savedAt (a real edit the app
// picks up over its live listener).
export async function mutate(fn) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref());
    const board = normalize(snap.exists ? snap.data() : {});
    const result = await fn(board);
    board.savedAt = Date.now();
    tx.set(ref(), board);
    return result;
  });
}

// ---- matching helpers (fuzzy, like the app's assistant) ----
export function findCatId(board, name) {
  if (!name) return board.cats[0]?.id || "personal";
  const q = String(name).toLowerCase();
  return (board.cats.find(c => c.name.toLowerCase() === q) ||
          board.cats.find(c => c.name.toLowerCase().includes(q)))?.id ||
          board.cats[0]?.id || "personal";
}
export function catName(board, id) {
  return board.cats.find(c => c.id === id)?.name || "Uncategorized";
}
export function findTask(board, q) {
  if (!q) return null;
  const s = String(q);
  return board.tasks.find(t => t.id === s) ||
         board.tasks.find(t => (t.title || "").toLowerCase() === s.toLowerCase()) ||
         board.tasks.find(t => (t.title || "").toLowerCase().includes(s.toLowerCase())) || null;
}
export function findBill(board, q) {
  if (!q) return null;
  const s = String(q);
  return board.bills.find(b => b.id === s) ||
         board.bills.find(b => (b.name || "").toLowerCase() === s.toLowerCase()) ||
         board.bills.find(b => (b.name || "").toLowerCase().includes(s.toLowerCase())) || null;
}

// ---- date helpers for bill recurrence (mirror the app) ----
const DAY = 86400000;
function parseDue(s) { if (!s) return null; const d = new Date(s + "T00:00:00"); return isNaN(d) ? null : d; }
function iso(d) { const z = new Date(d); return z.getFullYear() + "-" + String(z.getMonth() + 1).padStart(2, "0") + "-" + String(z.getDate()).padStart(2, "0"); }
function addMonths(d, n) { const x = new Date(d), day = x.getDate(); x.setMonth(x.getMonth() + n); if (x.getDate() < day) x.setDate(0); return x; }
function addUnit(d, n, unit) {
  const x = new Date(d);
  if (unit === "day") { x.setDate(x.getDate() + n); return x; }
  if (unit === "week") { x.setDate(x.getDate() + n * 7); return x; }
  if (unit === "year") return addMonths(d, n * 12);
  return addMonths(d, n);
}
export function cadNext(b) {
  const d = parseDue(b.due) || new Date();
  if (b.cadence === "custom") return addUnit(d, Math.max(1, b.interval || 1), b.unit || "month");
  const map = {
    monthly: x => addMonths(x, 1),
    weekly: x => new Date(x.getTime() + 7 * DAY),
    biweekly: x => new Date(x.getTime() + 14 * DAY),
    quarterly: x => addMonths(x, 3),
    annual: x => addMonths(x, 12)
  };
  return (map[b.cadence] || map.monthly)(d);
}
export { iso };
