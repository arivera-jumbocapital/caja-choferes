"use strict";
const express = require("express");
const { q, tx, audit } = require("./db");
const A = require("./auth");
const R = require("./recibos");
const { fechaValida, hoyPanama, sumarDias, fechaVentaDe, toCents, conteoLimpio, sums, KEYS } = require("./calc");
const { importar, limpiarCierre, slug } = require("./importar");
const SAP = require("./sap");

const api = express.Router();
const OFICINA = ["gerente", "asistente"];
const LECTURA = ["gerente", "asistente", "consulta"];
const GERENTE = ["gerente"];

// Envuelve rutas async para que los errores lleguen al manejador.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
// Código de camión SAP: mayúsculas, sin espacios (CAM-90, PE-PTL-02).
const camionSap = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9-]/g, "").slice(0, 40);

// Protección CSRF: toda escritura debe venir como JSON (un formulario de otro sitio no puede enviarlo).
api.use((req, res, next) => {
  if ((req.method === "POST" || req.method === "PUT") && !req.is("application/json")) return bad(res, "Formato no válido.", 415);
  next();
});

/* ---------- sesión ---------- */
api.post("/login", h(A.login));
api.post("/logout", (req, res) => { req.session.destroy(() => { res.clearCookie("caja.sid"); res.json({ ok: true }); }); });
api.get("/yo", A.requiere(), (req, res) => {
  const u = req.user;
  res.json({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, hoy: hoyPanama(),
    chofer: u.chofer_id ? { id: u.chofer_id, nombre: u.chofer_nombre, ruta: u.chofer_ruta, tipo: u.chofer_tipo } : null });
});
api.post("/mi-clave", A.requiere(), h(A.cambiarMiClave));

/* ---------- choferes ---------- */
api.get("/choferes", A.requiere(), h(async (req, res) => {
  if (req.user.rol === "chofer") {
    const { rows } = await q("SELECT id, nombre, ruta, tipo, activo FROM choferes WHERE id = $1", [req.user.chofer_id]);
    return res.json({ choferes: rows });
  }
  const { rows } = await q("SELECT id, nombre, ruta, tipo, activo, camion_sap AS \"camionSap\" FROM choferes ORDER BY orden, nombre");
  res.json({ choferes: rows });
}));
api.put("/choferes", A.requiere(...GERENTE), h(async (req, res) => {
  const lista = Array.isArray(req.body && req.body.choferes) ? req.body.choferes : null;
  if (!lista) return bad(res, "Lista no válida.");
  const avisos = [];
  await tx(async (c) => {
    const { rows: actuales } = await c.query("SELECT id FROM choferes");
    const used = new Set(), keep = new Set();
    let i = 0;
    for (const ch of lista) {
      const nombre = String((ch && ch.nombre) || "").trim().slice(0, 80);
      if (!nombre) continue;
      let id = ch.id && actuales.some((a) => a.id === ch.id) ? ch.id : null;
      if (!id) { const b = slug(nombre); id = b; let k = 2; while (used.has(id) || actuales.some((a) => a.id === id)) id = b + "-" + k++; }
      used.add(id); keep.add(id);
      const cam = ch.camionSap === undefined ? null : camionSap(ch.camionSap);
      await c.query(`INSERT INTO choferes (id, nombre, ruta, tipo, activo, orden, camion_sap) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,''))
        ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, ruta = EXCLUDED.ruta, tipo = EXCLUDED.tipo, activo = EXCLUDED.activo, orden = EXCLUDED.orden,
          camion_sap = COALESCE($7, choferes.camion_sap)`,
      [id, nombre, String(ch.ruta || "").trim().slice(0, 120), ch.tipo === "Food Services" ? "Food Services" : "Ruta", ch.activo !== false, i++, cam]);
    }
    // Quitados de la lista: se borran solo si no tienen recibos, ventas ni usuario; si no, quedan inactivos.
    for (const a of actuales) {
      if (keep.has(a.id)) continue;
      const { rows } = await c.query(`SELECT (SELECT count(*) FROM recibos WHERE chofer_id = $1) + (SELECT count(*) FROM ventas WHERE chofer_id = $1)
        + (SELECT count(*) FROM usuarios WHERE chofer_id = $1) AS n`, [a.id]);
      if (Number(rows[0].n) === 0) await c.query("DELETE FROM choferes WHERE id = $1", [a.id]);
      else { await c.query("UPDATE choferes SET activo = false, orden = $2 WHERE id = $1", [a.id, i++]); avisos.push(a.id); }
    }
    await audit(c, req.user.id, "choferes", { n: keep.size });
  });
  const { rows } = await q("SELECT id, nombre, ruta, tipo, activo, camion_sap AS \"camionSap\" FROM choferes ORDER BY orden, nombre");
  res.json({ choferes: rows, avisos });
}));

/* ---------- el chofer y su propio recibo ---------- */
api.get("/recibos/mio", A.requiere("chofer"), h(async (req, res) => {
  const fecha = req.query.fecha;
  if (!fechaValida(fecha)) return bad(res, "Fecha no válida.");
  const r = await R.porFechaChofer({ query: q }, fecha, req.user.chofer_id);
  res.json({ recibo: r ? R.out(r) : null });
}));
api.get("/recibos/mios", A.requiere("chofer"), h(async (req, res) => {
  const { rows } = await q(R.SELECT + " WHERE r.chofer_id = $1 AND r.adicional = 0 ORDER BY r.fecha DESC LIMIT 15", [req.user.chofer_id]);
  res.json({ recibos: rows.map(R.out) });
}));
api.put("/recibos/mio", A.requiere("chofer"), h(async (req, res) => {
  const b = req.body || {};
  const hoy = hoyPanama();
  if (!fechaValida(b.fecha)) return bad(res, "Escribe la fecha de entrega.");
  if (b.fecha > sumarDias(hoy, 1)) return bad(res, "La fecha de entrega no puede ser futura.");
  if (b.fecha < sumarDias(hoy, -60)) return bad(res, "Esa fecha es muy antigua. Pide a la oficina que la corrija.");
  const d = R.limpiar(b);
  if (d.total === 0) return bad(res, "El recibo está en cero. Escribe al menos una cantidad.");
  d.fecha = b.fecha; d.fechaVenta = fechaValida(b.fechaVenta) ? b.fechaVenta : fechaVentaDe(b.fecha);
  d.choferId = req.user.chofer_id; // siempre del usuario, nunca del cuerpo de la petición
  const r = await tx(async (c) => {
    const prev = await R.porFechaChofer(c, d.fecha, d.choferId, true);
    if (prev && prev.verificado) return { error: "La oficina ya verificó este recibo. Si hay un error, avísale a la oficina." };
    if (prev && prev.ajustado_el) return { error: "La oficina ya ajustó el conteo de este recibo. Si hay un error, avísale a la oficina." };
    if (prev) {
      // Guardar otra vez lo mismo (por ejemplo, un doble toque) no cuenta como corrección.
      const igual = prev.fecha_venta === d.fechaVenta && prev.ruta === d.ruta && prev.ach_c === d.ach && prev.yappy_c === d.yappy && prev.cheque_c === d.cheque &&
        prev.refs === d.refs && prev.notas === d.notas && Object.keys(d.conteo).every((k) => (prev.conteo[k] || 0) === d.conteo[k]) &&
        JSON.stringify((prev.credito || []).map((x) => [x.cliente, x.factura, x.monto])) === JSON.stringify(d.credito.map((x) => [x.cliente, x.factura, x.monto]));
      if (igual) return R.out(prev);
      // Solo se permite una corrección; la segunda queda bloqueada.
      if ((prev.correcciones || 0) >= 1) return { error: "Ya corregiste este recibo una vez y quedó cerrado. Si hay otro error, avísale a la oficina." };
    }
    const w = await R.escribir(c, d, { usuarioId: req.user.id, origen: "chofer", motivo: "Corregido por el chofer", correcciones: prev ? (prev.correcciones || 0) + 1 : 0 });
    await audit(c, req.user.id, prev ? "recibo_corregido" : "recibo_nuevo", { fecha: d.fecha, chofer: d.choferId, total: d.total });
    return R.out(await R.porId(c, w.id));
  });
  if (r.error) return bad(res, r.error, 409);
  res.json({ recibo: r });
}));

/* ---------- oficina: día, período, ventas, cierre ---------- */
async function dias(desde, hasta) {
  const out = {};
  const dia = (f) => (out[f] = out[f] || { recibos: {}, ventas: {}, cierre: {} });
  const [rs, vs, cs] = await Promise.all([
    q(R.SELECT + " WHERE r.fecha BETWEEN $1 AND $2 ORDER BY r.fecha", [desde, hasta]),
    q("SELECT fecha, chofer_id, monto_c FROM ventas WHERE fecha BETWEEN $1 AND $2", [desde, hasta]),
    q("SELECT fecha, datos FROM cierres WHERE fecha BETWEEN $1 AND $2", [desde, hasta]),
  ]);
  for (const r of rs.rows) dia(r.fecha).recibos[R.clave(r)] = R.out(r);
  for (const v of vs.rows) dia(v.fecha).ventas[v.chofer_id] = v.monto_c;
  for (const c of cs.rows) dia(c.fecha).cierre = c.datos;
  return out;
}
api.get("/dia", A.requiere(...OFICINA), h(async (req, res) => {
  const f = req.query.fecha;
  if (!fechaValida(f)) return bad(res, "Fecha no válida.");
  const d = await dias(f, f);
  res.json(d[f] || { recibos: {}, ventas: {}, cierre: {} });
}));
api.get("/periodo", A.requiere(...LECTURA), h(async (req, res) => {
  const { desde, hasta } = req.query;
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return bad(res, "Período no válido.");
  const d = await dias(desde, hasta);
  if (req.user.rol === "consulta") for (const x of Object.values(d)) x.cierre = {};
  res.json({ dias: d });
}));
// Fechas con recibos (para los botones de fecha, el período y el respaldo).
api.get("/fechas", A.requiere(...LECTURA), h(async (req, res) => {
  const { rows } = await q("SELECT fecha, count(*)::int AS n, sum(total_c)::bigint AS total FROM recibos GROUP BY fecha ORDER BY fecha");
  res.json({ fechas: rows.map((r) => ({ fecha: r.fecha, n: r.n, total: Number(r.total) })) });
}));
api.put("/ventas", A.requiere(...OFICINA), h(async (req, res) => {
  const { fecha, choferId, monto } = req.body || {};
  if (!fechaValida(fecha) || !choferId) return bad(res, "Datos no válidos.");
  if (monto === null || monto === "" || monto === undefined) {
    await q("DELETE FROM ventas WHERE fecha = $1 AND chofer_id = $2", [fecha, choferId]);
  } else {
    const { rows } = await q("SELECT 1 FROM choferes WHERE id = $1", [choferId]);
    if (!rows[0]) return bad(res, "Ese chofer no existe.");
    await q(`INSERT INTO ventas (fecha, chofer_id, monto_c, actualizado_por, origen) VALUES ($1,$2,$3,$4,'manual')
      ON CONFLICT (fecha, chofer_id) DO UPDATE SET monto_c = EXCLUDED.monto_c, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por, origen = 'manual'`,
    [fecha, choferId, toCents(monto), req.user.id]);
  }
  await audit(null, req.user.id, "venta", { fecha, choferId, monto: monto == null || monto === "" ? null : toCents(monto) });
  res.json({ ok: true });
}));
// Combina solo las claves que cambiaron, para que dos asistentes no se pisen.
api.put("/cierre/:fecha", A.requiere(...OFICINA), h(async (req, res) => {
  const f = req.params.fecha;
  if (!fechaValida(f)) return bad(res, "Fecha no válida.");
  const cambios = limpiarCierre((req.body && req.body.cambios) || {});
  const { rows } = await q(`INSERT INTO cierres (fecha, datos, actualizado_por) VALUES ($1,$2,$3)
    ON CONFLICT (fecha) DO UPDATE SET datos = cierres.datos || EXCLUDED.datos, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por
    RETURNING datos`, [f, JSON.stringify(cambios), req.user.id]);
  await audit(null, req.user.id, "cierre", { fecha: f, claves: Object.keys(cambios) });
  res.json({ cierre: rows[0].datos });
}));

/* ---------- facturación de SAP por camión (automática) ---------- */
// La venta de cada chofer se llena sola con el NETO de SAP (facturado − merma − devolución) de su camión,
// del día de venta (el día anterior a la entrega; la entrega del lunes toma el sábado).
// Una venta escrita a mano (origen 'manual') nunca se reemplaza.
const normTxt = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const claveCamion = (cam) => normTxt(cam).replace(/^PE(?=[A-Z])/, ""); // PE-PTL-02 → PTL02, CAM-88 → CAM88
function rutaTiene(ruta, cam) {
  const r = normTxt(ruta), k = claveCamion(cam);
  if (!k) return false;
  for (let i = r.indexOf(k); i >= 0; i = r.indexOf(k, i + 1)) if (!/\d/.test(r[i + k.length] || "")) return true; // CAM8 no es CAM88
  return false;
}
// Chofer de un camión: camión SAP guardado (+4), ruta de su recibo del día (+3), ruta de la lista (+2), entregó ese día (+1).
// Solo se asigna si un chofer queda claramente primero.
function choferDeCamion(cam, choferes, recibos) {
  const c = choferes.map((ch) => {
    const rec = recibos[ch.id];
    let p = 0;
    if (ch.camion_sap && normTxt(ch.camion_sap) === normTxt(cam)) p += 4;
    if (rec && rutaTiene(rec.ruta, cam)) p += 3;
    if (rutaTiene(ch.ruta, cam)) p += 2;
    if (p && rec) p += 1;
    return { id: ch.id, p };
  }).filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
  return c.length && (c.length === 1 || c[0].p > c[1].p) ? c[0].id : null;
}
const sinDatos = new Map(); // fecha de venta → hora de la última consulta que no trajo nada
// forzar (botón "Actualizar SAP"): vuelve a leer aunque el día esté cerrado, con un mínimo de 1 minuto entre lecturas.
async function leerSap(fv, usuarioId, forzar) {
  const { rows } = await q("SELECT * FROM sap_facturacion WHERE fecha_venta = $1", [fv]);
  const ultima = rows[0] ? new Date(rows[0].consultado).getTime() : sinDatos.get(fv) || 0;
  const cerrado = ultima > new Date(fv + "T00:00:00-05:00").getTime() + 2 * 864e5; // leído 2 días después: ya no cambia
  if (forzar ? Date.now() - ultima < 60e3 : (rows.length && cerrado) || Date.now() - ultima < 15 * 60e3) return rows; // caché de 15 minutos
  const filas = await SAP.resumenPorCamion(fv, fv);
  if (!filas.length) sinDatos.set(fv, Date.now());
  await tx(async (c) => {
    await c.query("DELETE FROM sap_facturacion WHERE fecha_venta = $1", [fv]);
    for (const f of filas) {
      await c.query(`INSERT INTO sap_facturacion (fecha_venta, camion, documentos, facturado_c, merma_c, devolucion_c, neto_c, varios, consultado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (fecha_venta, camion) DO UPDATE SET documentos = sap_facturacion.documentos + EXCLUDED.documentos,
        facturado_c = sap_facturacion.facturado_c + EXCLUDED.facturado_c, merma_c = sap_facturacion.merma_c + EXCLUDED.merma_c,
        devolucion_c = sap_facturacion.devolucion_c + EXCLUDED.devolucion_c, neto_c = sap_facturacion.neto_c + EXCLUDED.neto_c, varios = sap_facturacion.varios + EXCLUDED.varios`,
      [fv, f.camion, f.documentos, f.facturado, f.merma, f.devolucion, f.neto, f.varios, usuarioId]);
    }
  });
  return (await q("SELECT * FROM sap_facturacion WHERE fecha_venta = $1", [fv])).rows;
}
// Se llama al abrir un día en el Panel: trae SAP y llena la venta de los choferes.
api.post("/sap/sincronizar", A.requiere(...OFICINA), h(async (req, res) => {
  const fecha = req.body && req.body.fecha;
  if (!fechaValida(fecha)) return bad(res, "Fecha no válida.");
  const fv = fechaVentaDe(fecha);
  if (!SAP.configurado()) return res.json({ configurado: false, fechaVenta: fv });
  if (fv > hoyPanama()) return res.json({ configurado: true, fechaVenta: fv, camiones: [], sinAsignar: [] });
  let filas;
  try { filas = await leerSap(fv, req.user.id, !!(req.body && req.body.forzar)); }
  catch (e) { console.error("SAP:", e.message); return res.json({ configurado: true, fechaVenta: fv, error: "No se pudo leer SAP en este momento." }); }
  const [{ rows: recs }, { rows: choferes }] = await Promise.all([
    q("SELECT chofer_id, ruta FROM recibos WHERE fecha = $1", [fecha]),
    q("SELECT id, ruta, camion_sap FROM choferes WHERE activo"),
  ]);
  const recibos = Object.fromEntries(recs.map((r) => [r.chofer_id, r]));
  const montos = {}, camiones = [], sinAsignar = [];
  for (const f of filas) {
    if (f.camion === "Sin camion") continue;
    const id = choferDeCamion(f.camion, choferes, recibos);
    if (!id) { sinAsignar.push(f.camion); continue; }
    montos[id] = (montos[id] || 0) + Number(f.neto_c);
    camiones.push({ camion: f.camion, choferId: id, neto: Number(f.neto_c), facturado: Number(f.facturado_c) });
  }
  let cambios = 0;
  await tx(async (c) => {
    for (const [cid, monto] of Object.entries(montos)) {
      const { rowCount } = await c.query(`INSERT INTO ventas (fecha, chofer_id, monto_c, origen) VALUES ($1,$2,$3,'sap')
        ON CONFLICT (fecha, chofer_id) DO UPDATE SET monto_c = EXCLUDED.monto_c, origen = 'sap', actualizado = now()
        WHERE ventas.origen = 'sap' AND ventas.monto_c <> EXCLUDED.monto_c`, [fecha, cid, monto]);
      cambios += rowCount;
    }
    if (cambios) await audit(c, req.user.id, "venta_sap", { fecha, fechaVenta: fv, montos });
  });
  res.json({ configurado: true, fechaVenta: fv, consultado: filas[0] ? filas[0].consultado : null, camiones, sinAsignar, cambios });
}));

/* ---------- oficina: verificar, eliminar, versiones ---------- */
api.post("/recibos/:id/verificar", A.requiere(...OFICINA), h(async (req, res) => {
  const v = !!(req.body && req.body.verificado);
  const { rowCount } = await q("UPDATE recibos SET verificado = $2, verificado_por = $3, verificado_el = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1",
    [Number(req.params.id) || 0, v, v ? req.user.id : null]);
  if (!rowCount) return bad(res, "Ese recibo ya no existe.", 404);
  await audit(null, req.user.id, v ? "verificar" : "quitar_verificado", { id: Number(req.params.id) });
  res.json({ ok: true });
}));
// La oficina emite un recibo a nombre de un chofer, con la fecha de entrega, la venta y la ruta que escoja.
// Siempre queda como recibo ADICIONAL (no reemplaza el del chofer): sirve, por ejemplo, cuando el chofer termina
// al día siguiente una ruta que no entregó completa y ese dinero entra en la caja de ese día.
api.post("/recibos", A.requiere(...OFICINA), h(async (req, res) => {
  const b = req.body || {};
  const hoy = hoyPanama();
  if (!fechaValida(b.fecha)) return bad(res, "Escribe la fecha de entrega.");
  if (b.fecha > sumarDias(hoy, 1)) return bad(res, "La fecha de entrega no puede ser futura.");
  if (!fechaValida(b.fechaVenta)) return bad(res, "Escribe la fecha de venta.");
  if (b.fechaVenta > b.fecha) return bad(res, "La fecha de venta no puede ser posterior a la entrega.");
  const { rows: ch } = await q("SELECT id, nombre FROM choferes WHERE id = $1", [String(b.choferId || "")]);
  if (!ch[0]) return bad(res, "Escoge un chofer de la lista.");
  const d = R.limpiar(b);
  if (d.total === 0) return bad(res, "El recibo está en cero. Escribe al menos una cantidad.");
  d.fecha = b.fecha; d.fechaVenta = b.fechaVenta; d.choferId = ch[0].id;
  const r = await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [d.fecha + "|" + d.choferId]);
    const { rows } = await c.query("SELECT coalesce(max(adicional), 0) + 1 AS n FROM recibos WHERE fecha = $1 AND chofer_id = $2", [d.fecha, d.choferId]);
    d.adicional = rows[0].n;
    const w = await R.escribir(c, d, { usuarioId: req.user.id, origen: "oficina" });
    await audit(c, req.user.id, "recibo_oficina", { fecha: d.fecha, fechaVenta: d.fechaVenta, chofer: d.choferId, adicional: d.adicional, total: d.total });
    return R.out(await R.porId(c, w.id));
  });
  res.json({ recibo: r });
}));
// La oficina corrige la cantidad de billetes y monedas, y los montos de ACH, Yappy y cheque (el chofer a veces escribe mal o no los coloca).
// Guarda la versión anterior, recalcula los totales en el servidor y deja el recibo cerrado para el chofer.
api.put("/recibos/:id/conteo", A.requiere(...OFICINA), h(async (req, res) => {
  const b = req.body || {};
  if (!b.conteo || typeof b.conteo !== "object") return bad(res, "Conteo no válido.");
  const r = await tx(async (c) => {
    const prev = await R.porId(c, Number(req.params.id) || 0, true);
    if (!prev) return { error: "Ese recibo ya no existe.", status: 404 };
    const conteo = conteoLimpio(b.conteo);
    // ACH, Yappy y cheque en centavos; si no vienen, se dejan como estaban.
    const ach = b.ach === undefined ? prev.ach_c : toCents(b.ach), yappy = b.yappy === undefined ? prev.yappy_c : toCents(b.yappy), cheque = b.cheque === undefined ? prev.cheque_c : toCents(b.cheque);
    const s = sums(conteo, ach, yappy, cheque);
    if (s.total === 0) return { error: "El recibo quedaría en cero. Si no corresponde, elimínalo." };
    if (KEYS.every((k) => (prev.conteo[k] || 0) === conteo[k]) && ach === prev.ach_c && yappy === prev.yappy_c && cheque === prev.cheque_c) return { recibo: R.out(prev) };
    await R.guardarVersion(c, prev, "Conteo ajustado por la oficina (" + (req.user.nombre || req.user.usuario) + ")", req.user.id);
    await c.query(`UPDATE recibos SET conteo = $2, efectivo_c = $3, total_c = $4, ach_c = $6, yappy_c = $7, cheque_c = $8, ajustado_por = $5, ajustado_el = now(), actualizado = now() WHERE id = $1`,
      [prev.id, JSON.stringify(conteo), s.efectivo, s.total, req.user.id, ach, yappy, cheque]);
    await audit(c, req.user.id, "conteo_ajustado", { id: prev.id, fecha: prev.fecha, chofer: prev.chofer_id, antes: prev.total_c, despues: s.total });
    return { recibo: R.out(await R.porId(c, prev.id)) };
  });
  if (r.error) return bad(res, r.error, r.status || 400);
  res.json(r);
}));
api.delete("/recibos/:id", A.requiere(...OFICINA), h(async (req, res) => {
  const ok = await tx(async (c) => {
    const r = await R.porId(c, Number(req.params.id) || 0, true);
    if (!r) return false;
    await R.guardarVersion(c, r, "Eliminado en el Panel por " + (req.user.nombre || req.user.usuario), req.user.id);
    await c.query("DELETE FROM recibos WHERE id = $1", [r.id]);
    await audit(c, req.user.id, "eliminar", { id: r.id, fecha: r.fecha, chofer: r.chofer_id, total: r.total_c });
    return true;
  });
  if (!ok) return bad(res, "Ese recibo ya no existe.", 404);
  res.json({ ok: true });
}));
api.get("/recibos/recientes", A.requiere(...OFICINA), h(async (req, res) => {
  const { rows } = await q(R.SELECT + " ORDER BY r.fecha DESC, c.nombre LIMIT 400");
  const { rows: n } = await q("SELECT count(*)::int AS n, count(DISTINCT fecha)::int AS f FROM recibos");
  res.json({ recibos: rows.map(R.out), total: n[0].n, fechas: n[0].f });
}));
api.get("/versiones", A.requiere(...OFICINA), h(async (req, res) => {
  const { rows } = await q(`SELECT v.id, v.datos, v.motivo, v.creado, v.restaurado, u.nombre AS usuario FROM recibo_versiones v
    LEFT JOIN usuarios u ON u.id = v.usuario_id ORDER BY v.creado DESC, v.id DESC LIMIT 300`);
  res.json({ versiones: rows.map((v) => ({ ...v.datos, versionId: v.id, motivo: v.motivo, reemplazadoEl: v.creado, restaurado: v.restaurado, por: v.usuario })) });
}));
api.post("/versiones/:id/restaurar", A.requiere(...OFICINA), h(async (req, res) => {
  const r = await tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM recibo_versiones WHERE id = $1 FOR UPDATE", [Number(req.params.id) || 0]);
    const v = rows[0];
    if (!v) return { error: "Esa versión no existe." };
    const x = v.datos;
    if (!fechaValida(x.fecha) || !x.choferId) return { error: "Esa versión está incompleta." };
    const { rows: ch } = await c.query("SELECT 1 FROM choferes WHERE id = $1", [x.choferId]);
    if (!ch[0]) return { error: "El chofer de esa versión ya no existe en la lista." };
    const d = R.limpiar(x);
    d.fecha = x.fecha; d.fechaVenta = fechaValida(x.fechaVenta) ? x.fechaVenta : fechaVentaDe(x.fecha); d.choferId = x.choferId; d.adicional = Math.max(0, Math.floor(Number(x.adicional) || 0));
    await R.escribir(c, d, { usuarioId: req.user.id, origen: "restaurado", alterado: !!x.alterado, guardado: x.guardado, motivo: "Reemplazado al restaurar otra versión" });
    await c.query("UPDATE recibo_versiones SET restaurado = true WHERE id = $1", [v.id]);
    await audit(c, req.user.id, "carga", { ok: true, msg: "Restaurado: " + (x.chofer || x.choferId) + " · " + x.fecha + " · $" + (d.total / 100).toFixed(2) });
    return { ok: true, fecha: x.fecha };
  });
  if (r.error) return bad(res, r.error);
  res.json(r);
}));
api.get("/cargas", A.requiere(...OFICINA), h(async (req, res) => {
  const { rows } = await q("SELECT cuando, detalle FROM auditoria WHERE accion = 'carga' ORDER BY cuando DESC, id DESC LIMIT 200");
  res.json({ cargas: rows.map((r) => ({ cuando: r.cuando, ok: !!r.detalle.ok, msg: String(r.detalle.msg || "") })) });
}));

/* ---------- presentación ---------- */
api.get("/presentacion", A.requiere(...LECTURA), h(async (req, res) => {
  const { rows } = await q("SELECT titulo, notas FROM presentacion WHERE id = 1");
  res.json(rows[0] || { titulo: "Informe de Caja de Choferes", notas: {} });
}));
api.put("/presentacion", A.requiere(...OFICINA), h(async (req, res) => {
  const b = req.body || {};
  if (typeof b.titulo === "string") await q("UPDATE presentacion SET titulo = $1 WHERE id = 1", [b.titulo.slice(0, 200)]);
  if (b.notas && typeof b.notas === "object") {
    for (const [k, v] of Object.entries(b.notas)) {
      if (!/^[a-z]{1,30}$/.test(k)) continue;
      if (v == null) await q("UPDATE presentacion SET notas = notas - $1 WHERE id = 1", [k]);
      else await q("UPDATE presentacion SET notas = jsonb_set(notas, ARRAY[$1], to_jsonb($2::text)) WHERE id = 1", [k, String(v).slice(0, 4000)]);
    }
  }
  res.json({ ok: true });
}));

/* ---------- usuarios (gerente) ---------- */
const usuarioOut = (u) => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, choferId: u.chofer_id, activo: u.activo,
  ultimoIngreso: u.ultimo_ingreso, bloqueado: !!(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) });
api.get("/usuarios", A.requiere(...GERENTE), h(async (req, res) => {
  const { rows } = await q("SELECT * FROM usuarios ORDER BY CASE rol WHEN 'gerente' THEN 0 WHEN 'asistente' THEN 1 WHEN 'consulta' THEN 2 ELSE 3 END, nombre");
  res.json({ usuarios: rows.map(usuarioOut) });
}));
async function validarUsuario(b, id) {
  if (!A.ROLES.includes(b.rol)) return "Elige un rol.";
  if (b.rol === "chofer") {
    if (!b.choferId) return "Elige a qué chofer corresponde este usuario.";
    const { rows } = await q("SELECT 1 FROM choferes WHERE id = $1", [b.choferId]);
    if (!rows[0]) return "Ese chofer no existe.";
    const { rows: otro } = await q("SELECT usuario FROM usuarios WHERE chofer_id = $1 AND activo AND id <> $2", [b.choferId, id || 0]);
    if (otro[0]) return "Ese chofer ya tiene el usuario " + otro[0].usuario + ".";
  }
  return null;
}
api.post("/usuarios", A.requiere(...GERENTE), h(async (req, res) => {
  const b = req.body || {};
  const usuario = A.limpiarUsuario(b.usuario);
  if (!A.USUARIO_RE.test(usuario)) return bad(res, "El usuario debe tener de 3 a 40 letras o números, sin espacios ni acentos (puede llevar punto, guion o guion bajo).");
  const err = await validarUsuario(b);
  if (err) return bad(res, err);
  const clave = A.generarClave();
  try {
    const { rows } = await q("INSERT INTO usuarios (usuario, nombre, rol, chofer_id, hash) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [usuario, String(b.nombre || "").trim().slice(0, 80), b.rol, b.rol === "chofer" ? b.choferId : null, await A.hash(clave)]);
    await audit(null, req.user.id, "usuario_nuevo", { usuario, rol: b.rol });
    res.json({ usuario: usuarioOut(rows[0]), clave });
  } catch (e) {
    if (e.code === "23505") return bad(res, "Ya existe el usuario " + usuario + ".");
    throw e;
  }
}));
api.put("/usuarios/:id", A.requiere(...GERENTE), h(async (req, res) => {
  const id = Number(req.params.id) || 0, b = req.body || {};
  const { rows } = await q("SELECT * FROM usuarios WHERE id = $1", [id]);
  const u = rows[0];
  if (!u) return bad(res, "Ese usuario no existe.", 404);
  const nuevo = { nombre: b.nombre != null ? String(b.nombre).trim().slice(0, 80) : u.nombre, rol: b.rol || u.rol,
    choferId: b.choferId !== undefined ? b.choferId : u.chofer_id, activo: b.activo != null ? !!b.activo : u.activo };
  if (id === req.user.id && (nuevo.rol !== "gerente" || !nuevo.activo)) return bad(res, "No puedes quitarte tu propio acceso de gerente.");
  if (nuevo.activo) { const err = await validarUsuario(nuevo, id); if (err) return bad(res, err); }
  if (u.rol === "gerente" && (nuevo.rol !== "gerente" || !nuevo.activo)) {
    const { rows: g } = await q("SELECT count(*)::int AS n FROM usuarios WHERE rol = 'gerente' AND activo AND id <> $1", [id]);
    if (g[0].n === 0) return bad(res, "Debe quedar al menos un gerente activo.");
  }
  const { rows: r2 } = await q("UPDATE usuarios SET nombre = $2, rol = $3, chofer_id = $4, activo = $5 WHERE id = $1 RETURNING *",
    [id, nuevo.nombre, nuevo.rol, nuevo.rol === "chofer" ? nuevo.choferId : null, nuevo.activo]);
  if (!nuevo.activo) await q("DELETE FROM sesiones WHERE (sess->>'uid')::int = $1", [id]).catch(() => {});
  await audit(null, req.user.id, "usuario_editado", { id, ...nuevo });
  res.json({ usuario: usuarioOut(r2[0]) });
}));
api.post("/usuarios/:id/clave", A.requiere(...GERENTE), h(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const clave = A.generarClave();
  const { rowCount } = await q("UPDATE usuarios SET hash = $2, intentos = 0, bloqueado_hasta = NULL WHERE id = $1", [id, await A.hash(clave)]);
  if (!rowCount) return bad(res, "Ese usuario no existe.", 404);
  if (id !== req.user.id) await q("DELETE FROM sesiones WHERE (sess->>'uid')::int = $1", [id]).catch(() => {});
  await audit(null, req.user.id, "clave_restablecida", { id });
  res.json({ clave });
}));

/* ---------- importar y respaldo (gerente) ---------- */
api.post("/importar", A.requiere(...GERENTE), h(async (req, res) => {
  const archivos = Array.isArray(req.body && req.body.archivos) ? req.body.archivos : [];
  if (!archivos.length) return bad(res, "No llegó ningún archivo.");
  res.json({ resultados: await importar(archivos, req.user.id) });
}));
api.get("/respaldo", A.requiere(...GERENTE), h(async (req, res) => {
  const [ch, rs, vs, cs, pr, an, us] = await Promise.all([
    q("SELECT id, nombre, ruta, tipo, activo, camion_sap AS \"camionSap\" FROM choferes ORDER BY orden, nombre"),
    q(R.SELECT + " ORDER BY r.fecha"),
    q("SELECT fecha, chofer_id, monto_c FROM ventas"),
    q("SELECT fecha, datos FROM cierres"),
    q("SELECT titulo, notas FROM presentacion WHERE id = 1"),
    q("SELECT datos, motivo, creado FROM recibo_versiones ORDER BY creado DESC"),
    q("SELECT usuario, nombre, rol, chofer_id, activo FROM usuarios ORDER BY id"),
  ]);
  const dias = {};
  const dia = (f) => (dias[f] = dias[f] || { recibos: {}, ventas: {}, cierre: {} });
  for (const r of rs.rows) { const o = R.out(r); o.formato = "tasty-recibo-caja"; dia(r.fecha).recibos[R.clave(r)] = o; }
  for (const v of vs.rows) dia(v.fecha).ventas[v.chofer_id] = v.monto_c;
  for (const c of cs.rows) dia(c.fecha).cierre = c.datos;
  await audit(null, req.user.id, "respaldo", {});
  res.setHeader("Content-Disposition", 'attachment; filename="respaldo_caja_choferes_' + hoyPanama() + '.json"');
  res.json({ formato: "tasty-caja-respaldo", version: 1, creado: new Date().toISOString(), choferes: ch.rows, dias, cargas: [],
    anteriores: an.rows.map((a) => ({ ...a.datos, motivo: a.motivo, reemplazadoEl: a.creado })), presentacion: pr.rows[0],
    usuarios: us.rows /* sin claves */ });
}));

api.use((req, res) => bad(res, "No encontrado.", 404));

module.exports = api;
