"use strict";
// Importa datos de la versión offline: archivos .json de recibos (tasty-recibo-caja) y respaldos del portal (tasty-caja-respaldo).
// Nada se borra: lo que no se aplica queda en recibo_versiones.
const { tx, audit } = require("./db");
const { checksum, fechaValida, sumarDias, fechaVentaDe, toCents, toInt, KEYS } = require("./calc");
const R = require("./recibos");

const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chofer";
const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const largo = (f) => new Date(f + "T12:00:00Z").toLocaleDateString("es-PA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function asegurarChofer(c, id, nombre, tipo, ruta) {
  const { rows } = await c.query("SELECT id, nombre, tipo FROM choferes WHERE id = $1", [id]);
  if (rows[0]) return { known: true, chofer: rows[0] };
  const { rows: o } = await c.query("SELECT coalesce(max(orden), 0) + 1 AS n FROM choferes");
  await c.query("INSERT INTO choferes (id, nombre, ruta, tipo, activo, orden) VALUES ($1,$2,$3,$4,false,$5)",
    [id, String(nombre || id).slice(0, 80), String(ruta || "").slice(0, 120), tipo === "Food Services" ? "Food Services" : "Ruta", o[0].n]);
  return { known: false, chofer: { id, nombre: nombre || id, tipo } };
}

// Un recibo de la versión offline. `extra` permite marcarlo verificado (viene de un respaldo).
async function unRecibo(c, obj, nombreArchivo, uid, extra = {}) {
  if (!obj || obj.formato !== "tasty-recibo-caja") return { ok: false, msg: nombreArchivo + ": no es un recibo de chofer." };
  if (!fechaValida(obj.fecha) || !obj.choferId) return { ok: false, msg: nombreArchivo + ": le falta la fecha o el chofer." };
  const choferId = slug(obj.choferId) === String(obj.choferId) ? String(obj.choferId) : slug(obj.choferId);
  const d = R.limpiar(obj);
  d.fecha = obj.fecha; d.fechaVenta = fechaValida(obj.fechaVenta) ? obj.fechaVenta : fechaVentaDe(obj.fecha); d.choferId = choferId;
  d.adicional = Math.max(0, Math.floor(Number(obj.adicional) || 0));
  const control = obj.control ? checksum({ fecha: obj.fecha, choferId: String(obj.choferId), total: d.total, efectivo: d.efectivo, ach: d.ach, yappy: d.yappy, cheque: d.cheque, conteo: d.conteo }) : null;
  const alterado = !!obj.alterado || (obj.control != null && (control !== obj.control || d.total !== obj.total));
  const guardado = obj.guardado && !isNaN(new Date(obj.guardado)) ? new Date(obj.guardado).toISOString() : new Date().toISOString();
  const { known, chofer } = await asegurarChofer(c, choferId, obj.chofer, obj.tipo, obj.ruta);
  const nombre = chofer.nombre;
  const prev = await R.porFechaChofer(c, d.fecha, choferId, true, d.adicional);
  const comoVersion = (motivo) => R.guardarVersion(c, { ...obj, chofer: nombre, choferId, ...d, guardado, alterado }, motivo, uid);
  if (prev) {
    const same = prev.total_c === d.total && new Date(prev.guardado).toISOString() === guardado && KEYS.every((k) => (prev.conteo[k] || 0) === d.conteo[k]);
    if (same) {
      if (extra.verificado && !prev.verificado) await c.query("UPDATE recibos SET verificado = true, verificado_el = now() WHERE id = $1", [prev.id]);
      return { ok: true, fecha: d.fecha, nuevo: false, msg: "Ya estaba guardado: " + nombre + " · " + largo(d.fecha) + " · " + money(d.total) };
    }
    if (prev.verificado) {
      await comoVersion("No se aplicó: el recibo guardado ya estaba verificado");
      return { ok: false, fecha: d.fecha, msg: nombreArchivo + ": " + nombre + " (" + largo(d.fecha) + ") ya está verificado; el archivo quedó en \"Versiones guardadas aparte\"." };
    }
    if (new Date(prev.guardado) > new Date(guardado)) {
      await comoVersion("Archivo más antiguo que el guardado");
      return { ok: false, fecha: d.fecha, msg: nombreArchivo + ": ya había una versión más nueva del recibo de " + nombre + "; este archivo quedó en \"Versiones guardadas aparte\"." };
    }
  }
  await R.escribir(c, d, { usuarioId: uid, origen: "importado: " + String(nombreArchivo).slice(0, 120), alterado, guardado, verificado: !!extra.verificado, motivo: "Reemplazado por " + nombreArchivo });
  return {
    ok: true, fecha: d.fecha, nuevo: true,
    msg: (prev ? "Actualizado (la versión anterior quedó guardada aparte): " : "Nuevo: ") + nombre + " · " + largo(d.fecha) + " · " + money(d.total) +
      (alterado ? "  ⚠ el archivo fue modificado a mano después de guardarse" : "") + (known ? "" : "  ⚠ chofer no está en la lista (se agregó como inactivo)"),
  };
}

async function respaldo(c, bk, nombreArchivo, uid) {
  const res = [];
  let n = 0;
  // Choferes: se agregan o actualizan; nunca se borran.
  if (Array.isArray(bk.choferes)) {
    let i = 0;
    for (const ch of bk.choferes) {
      if (!ch || !ch.id || !ch.nombre) continue;
      const id = slug(ch.id) === String(ch.id) ? String(ch.id) : slug(ch.id);
      await c.query(`INSERT INTO choferes (id, nombre, ruta, tipo, activo, orden) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, ruta = EXCLUDED.ruta, tipo = EXCLUDED.tipo, activo = EXCLUDED.activo`,
      [id, String(ch.nombre).slice(0, 80), String(ch.ruta || "").slice(0, 120), ch.tipo === "Food Services" ? "Food Services" : "Ruta", ch.activo !== false, i++]);
    }
  }
  for (const [fecha, d] of Object.entries(bk.dias || {})) {
    if (!fechaValida(fecha) || !d) continue;
    for (const r of Object.values(d.recibos || {})) {
      const x = await unRecibo(c, { ...r, formato: "tasty-recibo-caja", control: undefined }, nombreArchivo, uid, { verificado: !!r.verificado });
      if (x.ok && x.nuevo) n++;
      if (!x.ok) res.push(x.msg);
    }
    for (const [cid, monto] of Object.entries(d.ventas || {})) {
      const { rows } = await c.query("SELECT 1 FROM choferes WHERE id = $1", [cid]);
      if (!rows[0]) continue;
      await c.query(`INSERT INTO ventas (fecha, chofer_id, monto_c, actualizado_por) VALUES ($1,$2,$3,$4)
        ON CONFLICT (fecha, chofer_id) DO UPDATE SET monto_c = EXCLUDED.monto_c, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`,
      [fecha, cid, Math.max(0, Math.round(+monto || 0)), uid]);
    }
    if (d.cierre && typeof d.cierre === "object" && Object.keys(d.cierre).length) {
      await c.query(`INSERT INTO cierres (fecha, datos, actualizado_por) VALUES ($1,$2,$3)
        ON CONFLICT (fecha) DO UPDATE SET datos = cierres.datos || EXCLUDED.datos, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`,
      [fecha, JSON.stringify(limpiarCierre(d.cierre)), uid]);
    }
  }
  for (const a of (Array.isArray(bk.anteriores) ? bk.anteriores : []).slice(0, 2000)) {
    if (a && a.fecha && a.choferId) await R.guardarVersion(c, a, "Del respaldo: " + (a.motivo || "versión anterior"), uid);
  }
  if (bk.presentacion && typeof bk.presentacion === "object") {
    await c.query("UPDATE presentacion SET titulo = CASE WHEN notas = '{}'::jsonb THEN $1 ELSE titulo END, notas = $2::jsonb || notas WHERE id = 1",
      [String(bk.presentacion.titulo || "Informe de Caja de Choferes").slice(0, 200), JSON.stringify(bk.presentacion.notas || {})]);
  }
  return { ok: true, n, avisos: res, msg: "Respaldo " + nombreArchivo + ": " + n + " recibo(s) nuevos o actualizados" + (res.length ? "; " + res.length + " quedaron aparte." : ".") };
}

// Solo deja las claves conocidas del cierre, con números limpios.
function limpiarCierre(x) {
  const out = {};
  for (const k of ["fisico", "brinks", "bancoBilletes", "bancoMonedas", "bancoMonedas2"]) {
    if (x[k] && typeof x[k] === "object") { out[k] = {}; for (const d of KEYS) if (x[k][d] != null) out[k][d] = toInt(x[k][d]); }
  }
  if (Array.isArray(x.merma)) out.merma = x.merma.slice(0, 200).map((m) => ({ nombre: String((m && m.nombre) || "").slice(0, 120), monto: toCents(m && m.monto) }));
  if (x.tla != null) out.tla = toCents(x.tla);
  return out;
}

async function importar(archivos, uid) {
  const resultados = [];
  for (const a of archivos.slice(0, 300)) {
    const nombre = String((a && a.nombre) || "archivo.json").slice(0, 160);
    let r;
    try {
      r = await tx(async (c) => {
        const d = a && a.datos;
        if (!d || typeof d !== "object") return { ok: false, msg: nombre + ": no se pudo leer (no es un archivo .json válido)." };
        if (d.formato === "tasty-caja-respaldo") return respaldo(c, d, nombre, uid);
        return unRecibo(c, d, nombre, uid);
      });
    } catch (e) {
      console.error("importar", nombre, e);
      r = { ok: false, msg: nombre + ": error al guardar (" + e.message + ")." };
    }
    resultados.push(r);
    await audit(null, uid, "carga", { ok: r.ok, msg: r.msg });
  }
  return resultados;
}

module.exports = { importar, limpiarCierre, slug };
