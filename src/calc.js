"use strict";
// Cálculos del recibo. Todo en centavos enteros.

const DENOMS = [
  { k: "b100", cents: 10000, tipo: "Billetes" }, { k: "b50", cents: 5000, tipo: "Billetes" },
  { k: "b20", cents: 2000, tipo: "Billetes" }, { k: "b10", cents: 1000, tipo: "Billetes" },
  { k: "b5", cents: 500, tipo: "Billetes" }, { k: "b1", cents: 100, tipo: "Billetes" },
  { k: "m100", cents: 100, tipo: "Monedas" }, { k: "m50", cents: 50, tipo: "Monedas" },
  { k: "m25", cents: 25, tipo: "Monedas" }, { k: "m10", cents: 10, tipo: "Monedas" },
  { k: "m5", cents: 5, tipo: "Monedas" }, { k: "m1", cents: 1, tipo: "Monedas" },
];
const KEYS = DENOMS.map((d) => d.k);
const MAX_PIEZAS = 1000000;
const MAX_CENTAVOS = 1000000000; // $10,000,000

const toInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_PIEZAS) : 0; };
const toCents = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_CENTAVOS) : 0; };

function conteoLimpio(c) {
  const out = {};
  for (const k of KEYS) out[k] = toInt(c && c[k]);
  return out;
}
function sums(conteo, ach, yappy, cheque) {
  let bill = 0, mon = 0;
  for (const d of DENOMS) { const v = (conteo[d.k] || 0) * d.cents; if (d.tipo === "Billetes") bill += v; else mon += v; }
  const efectivo = bill + mon;
  return { bill, mon, efectivo, total: efectivo + (ach || 0) + (yappy || 0) + (cheque || 0) };
}
// Suma de control de la versión offline (FNV-1a 32 bits en base 36). Solo detecta ediciones accidentales.
function checksum(r) {
  const s = [r.fecha, r.choferId, r.total, r.efectivo, r.ach, r.yappy, r.cheque].concat(KEYS.map((k) => r.conteo[k])).join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
function fechaValida(f) {
  if (typeof f !== "string" || !FECHA_RE.test(f)) return false;
  const d = new Date(f + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === f;
}
const hoyPanama = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Panama" });
function sumarDias(f, n) { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

module.exports = { DENOMS, KEYS, toInt, toCents, conteoLimpio, sums, checksum, fechaValida, hoyPanama, sumarDias, MAX_CENTAVOS };
