"use strict";
// Envío por correo del Reporte Inicial de Liquidación (venta inicial DTT de SAP), en PDF adjunto.
// - Automático: todos los días a la hora configurada (3:00 a. m. de Panamá) con la venta del día anterior.
// - Manual: botón "Enviar por correo ahora" en el Panel.
// Cómo se envía (variables de entorno; las claves NUNCA van en el código):
//   Microsoft 365 (Graph):  MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, CORREO_REMITENTE (buzón que envía)
//   SMTP (p. ej. Outlook):  SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD (o SMTP_PASS), SMTP_FROM (opcional). Tiene prioridad.
//   Pruebas locales:        CORREO_ARCHIVO=<carpeta>  (guarda el correo como .eml, no envía nada)
const fs = require("fs");
const path = require("path");
const express = require("express");
const { q, audit } = require("./db");
const A = require("./auth");
const { fechaValida, hoyPanama, sumarDias, fechaVentaDe } = require("./calc");
const L = require("../public/liquidacion.js");

const CLAVE = "reporte_liquidacion";
const POR_DEFECTO = { correos: [], activo: true, hora: "03:00" };
const CORREO_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PORTAL = process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/portal" : "";

/* ---------- ajustes ---------- */
async function leerAjustes() {
  const { rows } = await q("SELECT valor FROM ajustes WHERE clave = $1", [CLAVE]);
  return { ...POR_DEFECTO, ...(rows[0] ? rows[0].valor : {}) };
}
function limpiarCorreos(lista) {
  const out = [];
  for (const c of Array.isArray(lista) ? lista : String(lista || "").split(/[\s,;]+/)) {
    const v = String(c || "").trim().toLowerCase();
    if (!v) continue;
    if (!CORREO_RE.test(v) || v.length > 120) throw new Error("Correo no válido: " + v);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > 30) throw new Error("Máximo 30 correos.");
  return out;
}

/* ---------- cómo se envía ---------- */
// La clave SMTP puede venir como SMTP_PASSWORD o SMTP_PASS; el remitente como SMTP_FROM o CORREO_REMITENTE.
const smtpClave = () => process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
function transporte() {
  const e = process.env;
  if (e.SMTP_HOST && e.SMTP_USER && smtpClave()) return { tipo: "SMTP", remitente: e.SMTP_FROM || e.CORREO_REMITENTE || e.SMTP_USER };
  if (e.MS_TENANT_ID && e.MS_CLIENT_ID && e.MS_CLIENT_SECRET && e.CORREO_REMITENTE) return { tipo: "Microsoft 365", remitente: e.CORREO_REMITENTE };
  if (e.CORREO_ARCHIVO) return { tipo: "archivo de prueba", remitente: e.CORREO_REMITENTE || "reportes@prueba.local" };
  return null;
}
async function enviarCorreo({ para, asunto, html, texto, adjunto }) {
  const t = transporte();
  if (!t) throw new Error("El envío de correo no está configurado en el servidor.");
  const e = process.env;
  if (t.tipo === "Microsoft 365") {
    const tok = await fetch("https://login.microsoftonline.com/" + encodeURIComponent(e.MS_TENANT_ID) + "/oauth2/v2.0/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: e.MS_CLIENT_ID, client_secret: e.MS_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    const tj = await tok.json().catch(() => ({}));
    if (!tok.ok) throw new Error("Microsoft no dio acceso (" + (tj.error || tok.status) + ").");
    const r = await fetch("https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(t.remitente) + "/sendMail", {
      method: "POST", headers: { Authorization: "Bearer " + tj.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ saveToSentItems: true, message: {
        subject: asunto, body: { contentType: "HTML", content: html },
        toRecipients: para.map((a) => ({ emailAddress: { address: a } })),
        attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: adjunto.nombre, contentType: "application/pdf", contentBytes: adjunto.datos.toString("base64") }],
      } }),
    });
    if (!r.ok) { const ej = await r.json().catch(() => ({})); throw new Error("Microsoft rechazó el envío (" + ((ej.error && ej.error.code) || r.status) + ")."); }
    return;
  }
  const nodemailer = require("nodemailer");
  const msg = { from: "Caja de Choferes · Tasty Choice <" + t.remitente + ">", to: para.join(", "), subject: asunto, html, text: texto,
    attachments: [{ filename: adjunto.nombre, content: adjunto.datos, contentType: "application/pdf" }] };
  if (t.tipo === "SMTP") {
    const port = Number(e.SMTP_PORT || 587);
    const tr = nodemailer.createTransport({ host: e.SMTP_HOST, port, secure: port === 465, auth: { user: e.SMTP_USER, pass: smtpClave() }, requireTLS: port === 587, connectionTimeout: 20000 });
    await tr.sendMail(msg);
    return;
  }
  const tr = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await tr.sendMail(msg);
  fs.mkdirSync(e.CORREO_ARCHIVO, { recursive: true });
  fs.writeFileSync(path.join(e.CORREO_ARCHIVO, "reporte-" + Date.now() + ".eml"), info.message);
  fs.writeFileSync(path.join(e.CORREO_ARCHIVO, adjunto.nombre), adjunto.datos);
}

/* ---------- PDF en el servidor ---------- */
let LOGO = null;
function logo() {
  if (LOGO === null) { try { LOGO = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "..", "public", "logo.png")).toString("base64"); } catch (e) { LOGO = ""; } }
  return LOGO;
}
async function generarPdf(I, fechas, generadoPor) {
  const { jsPDF } = require("jspdf");
  const { applyPlugin } = require("jspdf-autotable");
  applyPlugin(jsPDF);
  const { rows } = await q("SELECT id, nombre FROM choferes");
  const nombres = Object.fromEntries(rows.map((r) => [r.id, r.nombre]));
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const r = L.dibujarLiquidacion(doc, { camiones: I.camiones, sinAsignarFilas: I.sinAsignarFilas, consultado: I.consultado, fechas, logo: logo(), generadoPor, nombre: (id) => nombres[id] || id });
  return { datos: Buffer.from(doc.output("arraybuffer")), nombre: L.nombreArchivo(fechas.venta), ...r };
}

/* ---------- armar y enviar ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function cuerpo(I, fechas) {
  const filas = I.camiones || [];
  const tot = (k) => filas.reduce((a, x) => a + (x[k] || 0), 0);
  const linea = (l, v, b) => `<tr><td style="padding:4px 14px 4px 0;color:#5a6572">${l}</td><td style="padding:4px 0;text-align:right;font-family:Consolas,monospace${b ? ";font-weight:bold" : ""}">${v}</td></tr>`;
  const sin = (I.sinAsignarFilas || []).length;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#16202b;font-size:14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td width="34%" height="4" style="background:#c8141b;font-size:0;line-height:0">&nbsp;</td><td width="16%" style="background:#f2b230;font-size:0;line-height:0">&nbsp;</td><td width="50%" style="background:#0a4d8f;font-size:0;line-height:0">&nbsp;</td></tr></table>
<h2 style="margin:16px 0 4px;color:#0a4d8f">Reporte Inicial de Liquidación · Ventas DTT</h2>
<p style="margin:0 0 14px">Venta del <b>${esc(L.fechaLarga(fechas.venta))}</b> (cobro: ${esc(L.fechaLarga(fechas.cobro))}). El PDF va adjunto.</p>
<table style="border-collapse:collapse">${linea("Rutas", filas.length)}${linea("Documentos", tot("documentos"))}${linea("Facturado", L.usd(tot("facturado")))}${linea("Merma", L.usd(tot("merma")))}${linea("Devolución", L.usd(tot("devolucion")))}${linea("Neto (venta inicial)", L.usd(tot("neto")), true)}</table>
${sin ? `<p style="color:#9a6700">${sin} camión(es) de SAP sin chofer asignado; aparecen aparte en el PDF y no suman.</p>` : ""}
<p style="color:#5a6572;font-size:12px;margin-top:18px">Fuente: SAP Business One, canal DT. Las cifras pueden cambiar si luego se registran devoluciones.${PORTAL ? ` Portal: <a href="${PORTAL}">${PORTAL}</a>` : ""}<br>Correo automático de Caja de Choferes · Tasty Choice.</p></div>`;
  const texto = `Reporte Inicial de Liquidación · Ventas DTT\nVenta del ${L.fechaLarga(fechas.venta)}. Neto: ${L.usd(tot("neto"))} en ${filas.length} rutas. El PDF va adjunto.`;
  return { html, texto };
}

// Envía el reporte de una fecha de ENTREGA. Devuelve { estado, detalle, destinatarios, total }.
async function enviarReporte({ fecha, fechas, tipo, usuario, para }) {
  const sincronizarSap = require("./api").sincronizarSap;
  const aj = await leerAjustes();
  const dest = para || aj.correos;
  const fv = fechaVentaDe(fecha);
  fechas = { venta: fv, factura: fv, despacho: fv, cobro: fecha, ...(fechas || {}) };
  const guarda = (estado, detalle, total) => q("INSERT INTO envios_reporte (fecha_venta, tipo, estado, destinatarios, total_c, detalle, enviado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [fechas.venta, tipo, estado, dest, total ?? null, detalle, usuario ? usuario.id : null]);
  if (!dest.length) { await guarda("error", "No hay correos en la lista."); return { estado: "error", detalle: "No hay correos en la lista. Agrégalos en Usuarios → Reporte por correo." }; }
  if (!transporte()) { await guarda("error", "Correo sin configurar."); return { estado: "error", detalle: "El envío de correo no está configurado en el servidor (falta la cuenta que envía)." }; }
  const I = await sincronizarSap(fecha, usuario ? usuario.id : null, true);
  if (I.configurado === false) { await guarda("error", "SAP sin configurar."); return { estado: "error", detalle: "La conexión con SAP no está configurada." }; }
  if (I.error) { await guarda("error", I.error); return { estado: "error", detalle: I.error }; }
  if (!(I.camiones || []).length) { await guarda("sin_datos", "SAP no tiene facturación DT de rutas para esa venta."); return { estado: "sin_datos", detalle: "SAP no tiene facturación DT de rutas para la venta del " + L.fechaLarga(fv) + "; no se envió nada." }; }
  const pdf = await generarPdf(I, fechas, usuario ? usuario.nombre || usuario.usuario : "envío automático");
  const { html, texto } = cuerpo(I, fechas);
  try {
    await enviarCorreo({ para: dest, asunto: "Reporte Inicial de Liquidación DTT · venta del " + L.fechaLarga(fechas.venta), html, texto, adjunto: pdf });
  } catch (e) {
    console.error("Correo:", e.message);
    await guarda("error", e.message, pdf.total);
    return { estado: "error", detalle: "No se pudo enviar el correo: " + e.message };
  }
  await guarda("enviado", "", pdf.total);
  await audit(null, usuario ? usuario.id : null, "reporte_correo", { tipo, fechaVenta: fechas.venta, destinatarios: dest, total: pdf.total });
  return { estado: "enviado", detalle: "Enviado a " + dest.join(", ") + ".", destinatarios: dest, total: pdf.total };
}

/* ---------- envío automático ---------- */
// Cada minuto revisa: si ya pasó la hora configurada (hasta las 12:00 m.) y la venta de ayer no se ha enviado, la envía.
// Si SAP o el correo fallan, reintenta cada 15 minutos. Domingo de venta: no hay entrega que lo cubra, se omite.
let ocupado = false;
async function revisar() {
  if (ocupado) return;
  ocupado = true;
  try {
    const aj = await leerAjustes();
    if (!aj.activo || !aj.correos.length || !transporte()) return;
    const ahora = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Panama", hour: "2-digit", minute: "2-digit", hour12: false });
    if (ahora < aj.hora || ahora >= "12:00") return;
    const fv = sumarDias(hoyPanama(), -1);
    let entrega = sumarDias(fv, 1);
    if (new Date(entrega + "T12:00:00Z").getUTCDay() === 0) entrega = sumarDias(fv, 2); // la venta del sábado se entrega el lunes
    if (fechaVentaDe(entrega) !== fv) return; // venta de domingo
    const { rows } = await q("SELECT estado, creado FROM envios_reporte WHERE fecha_venta = $1 AND tipo = 'automatico' ORDER BY creado DESC LIMIT 1", [fv]);
    if (rows[0] && rows[0].estado !== "error") return;
    if (rows[0] && Date.now() - new Date(rows[0].creado).getTime() < 15 * 60e3) return;
    const r = await enviarReporte({ fecha: entrega, tipo: "automatico" });
    console.log("Reporte de liquidación (venta del " + fv + "): " + r.estado + (r.detalle ? " · " + r.detalle : ""));
  } catch (e) { console.error("Reporte automático:", e.message); }
  finally { ocupado = false; }
}
function iniciar() { setTimeout(revisar, 30e3); setInterval(revisar, 60e3); }

/* ---------- API ---------- */
const router = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use((req, res, next) => {
  if ((req.method === "POST" || req.method === "PUT") && !req.is("application/json")) return res.status(415).json({ error: "Formato no válido." });
  next();
});
router.get("/", A.requiere("gerente", "asistente"), h(async (req, res) => {
  const aj = await leerAjustes();
  const t = transporte();
  const { rows } = await q(`SELECT e.fecha_venta AS "fechaVenta", e.tipo, e.estado, e.destinatarios, e.total_c AS total, e.detalle, e.creado, u.nombre AS por
    FROM envios_reporte e LEFT JOIN usuarios u ON u.id = e.enviado_por ORDER BY e.creado DESC LIMIT 15`);
  res.json({ ...aj, transporte: t ? t.tipo : null, remitente: t ? t.remitente : null, envios: rows.map((r) => ({ ...r, total: r.total == null ? null : Number(r.total) })) });
}));
router.put("/", A.requiere("gerente"), h(async (req, res) => {
  const b = req.body || {};
  let correos;
  try { correos = limpiarCorreos(b.correos); } catch (e) { return res.status(400).json({ error: e.message }); }
  const hora = HORA_RE.test(b.hora || "") ? b.hora : POR_DEFECTO.hora;
  const valor = { correos, activo: b.activo !== false, hora };
  await q(`INSERT INTO ajustes (clave, valor, actualizado_por) VALUES ($1,$2,$3)
    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`, [CLAVE, JSON.stringify(valor), req.user.id]);
  await audit(null, req.user.id, "reporte_correo_ajustes", valor);
  res.json(valor);
}));
router.post("/enviar", A.requiere("gerente", "asistente"), h(async (req, res) => {
  const b = req.body || {};
  if (!fechaValida(b.fecha)) return res.status(400).json({ error: "Fecha no válida." });
  const f = b.fechas || {};
  for (const k of ["venta", "factura", "despacho", "cobro"]) if (f[k] !== undefined && !fechaValida(f[k])) return res.status(400).json({ error: "Revisa las fechas del reporte." });
  const r = await enviarReporte({ fecha: b.fecha, fechas: f, tipo: "manual", usuario: req.user });
  if (r.estado === "error") return res.status(502).json({ ...r, error: r.detalle });
  res.json(r);
}));

module.exports = { router, iniciar, enviarReporte };
