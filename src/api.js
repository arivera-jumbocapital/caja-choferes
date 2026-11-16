"use strict";
const express = require("express");
const { q, tx, audit } = require("./db");
const A = require("./auth");
const R = require("./recibos");
const { fechaValida, hoyPanama, sumarDias, toCents } = require("./calc");
const { importar, limpiarCierre, slug } = require("./importar");

const api = express.Router();
const OFICINA = ["gerente", "asistente"];
const LECTURA = ["gerente", "asistente", "consulta"];
const GERENTE = ["gerente"];

// Envuelve rutas async para que los errores lleguen al manejador.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

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
  const { rows } = await q("SELECT id, nombre, ruta, tipo, activo FROM choferes ORDER BY orden, nombre");
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
      await c.query(`INSERT INTO choferes (id, nombre, ruta, tipo, activo, orden) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, ruta = EXCLUDED.ruta, tipo = EXCLUDED.tipo, activo = EXCLUDED.activo, orden = EXCLUDED.orden`,
      [id, nombre, String(ch.ruta || "").trim().slice(0, 120), ch.tipo === "Food Services" ? "Food Services" : "Ruta", ch.activo !== false, i++]);
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
  const { rows } = await q("SELECT id, nombre, ruta, tipo, activo FROM choferes ORDER BY orden, nombre");
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
  const { rows } = await q(R.SELECT + " WHERE r.chofer_id = $1 ORDER BY r.fecha DESC LIMIT 15", [req.user.chofer_id]);
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
  d.fecha = b.fecha; d.fechaVenta = fechaValida(b.fechaVenta) ? b.fechaVenta : sumarDias(b.fecha, -1);
  d.choferId = req.user.chofer_id; // siempre del usuario, nunca del cuerpo de la petición
  const r = await tx(async (c) => {
    const prev = await R.porFechaChofer(c, d.fecha, d.choferId, true);
    if (prev && prev.verificado) return { error: "La oficina ya verificó este recibo. Si hay un error, avísale a la oficina." };
    const w = await R.escribir(c, d, { usuarioId: req.user.id, origen: "chofer", motivo: "Corregido por el chofer" });
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
  for (const r of rs.rows) dia(r.fecha).recibos[r.chofer_id] = R.out(r);
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
    await q(`INSERT INTO ventas (fecha, chofer_id, monto_c, actualizado_por) VALUES ($1,$2,$3,$4)
      ON CONFLICT (fecha, chofer_id) DO UPDATE SET monto_c = EXCLUDED.monto_c, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`,
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

/* ---------- oficina: verificar, eliminar, versiones ---------- */
api.post("/recibos/:id/verificar", A.requiere(...OFICINA), h(async (req, res) => {
  const v = !!(req.body && req.body.verificado);
  const { rowCount } = await q("UPDATE recibos SET verificado = $2, verificado_por = $3, verificado_el = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1",
    [Number(req.params.id) || 0, v, v ? req.user.id : null]);
  if (!rowCount) return bad(res, "Ese recibo ya no existe.", 404);
  await audit(null, req.user.id, v ? "verificar" : "quitar_verificado", { id: Number(req.params.id) });
  res.json({ ok: true });
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
    d.fecha = x.fecha; d.fechaVenta = fechaValida(x.fechaVenta) ? x.fechaVenta : sumarDias(x.fecha, -1); d.choferId = x.choferId;
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
    q("SELECT id, nombre, ruta, tipo, activo FROM choferes ORDER BY orden, nombre"),
    q(R.SELECT + " ORDER BY r.fecha"),
    q("SELECT fecha, chofer_id, monto_c FROM ventas"),
    q("SELECT fecha, datos FROM cierres"),
    q("SELECT titulo, notas FROM presentacion WHERE id = 1"),
    q("SELECT datos, motivo, creado FROM recibo_versiones ORDER BY creado DESC"),
    q("SELECT usuario, nombre, rol, chofer_id, activo FROM usuarios ORDER BY id"),
  ]);
  const dias = {};
  const dia = (f) => (dias[f] = dias[f] || { recibos: {}, ventas: {}, cierre: {} });
  for (const r of rs.rows) { const o = R.out(r); o.formato = "tasty-recibo-caja"; dia(r.fecha).recibos[r.chofer_id] = o; }
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
