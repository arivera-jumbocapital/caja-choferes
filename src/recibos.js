"use strict";
// Lectura y escritura de recibos. Cada reemplazo o eliminación deja una copia en recibo_versiones.
const { conteoLimpio, sums, toCents } = require("./calc");

const SELECT = `
SELECT r.*, c.nombre AS chofer_nombre, c.tipo AS chofer_tipo, uv.nombre AS verificado_por_nombre, ue.nombre AS enviado_por_nombre,
  COALESCE(NULLIF(ua.nombre, ''), ua.usuario) AS ajustado_por_nombre
FROM recibos r
JOIN choferes c ON c.id = r.chofer_id
LEFT JOIN usuarios uv ON uv.id = r.verificado_por
LEFT JOIN usuarios ue ON ue.id = r.enviado_por
LEFT JOIN usuarios ua ON ua.id = r.ajustado_por`;

// Misma forma que el recibo de la versión offline (más dbId y campos de control).
function out(r) {
  return {
    dbId: r.id, fecha: r.fecha, fechaVenta: r.fecha_venta, choferId: r.chofer_id,
    chofer: r.chofer_nombre || r.chofer_id, tipo: r.chofer_tipo || "Ruta", ruta: r.ruta,
    conteo: r.conteo, ach: r.ach_c, yappy: r.yappy_c, cheque: r.cheque_c, efectivo: r.efectivo_c, total: r.total_c,
    refs: r.refs, notas: r.notas, guardado: r.guardado, recibido: r.creado, actualizado: r.actualizado,
    verificado: r.verificado, verificadoPor: r.verificado_por_nombre || null, verificadoEl: r.verificado_el,
    enviadoPor: r.enviado_por_nombre || null, origen: r.origen, alterado: r.alterado, correcciones: r.correcciones || 0,
    ajustado: !!r.ajustado_el, ajustadoPor: r.ajustado_por_nombre || null, ajustadoEl: r.ajustado_el || null,
    credito: Array.isArray(r.credito) ? r.credito : [],
    adicional: r.adicional || 0,
  };
}
// Clave del recibo dentro de un día: el id del chofer, o "id~n" para los recibos adicionales.
const clave = (r) => r.chofer_id + (r.adicional ? "~" + r.adicional : "");

// Clientes a crédito (solo informativo; NO entra en ningún total del recibo).
function creditoLimpio(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 60).map((x) => ({
    cliente: String((x && x.cliente) || "").trim().slice(0, 120),
    factura: String((x && x.factura) || "").trim().slice(0, 40),
    monto: toCents(x && x.monto),
  })).filter((x) => x.cliente || x.factura || x.monto);
}

// Normaliza lo que llega del navegador o de un archivo. Los totales SIEMPRE se recalculan aquí.
function limpiar(x) {
  const conteo = conteoLimpio(x.conteo);
  const ach = toCents(x.ach), yappy = toCents(x.yappy), cheque = toCents(x.cheque);
  const s = sums(conteo, ach, yappy, cheque);
  return {
    conteo, ach, yappy, cheque, efectivo: s.efectivo, total: s.total,
    ruta: String(x.ruta || "").slice(0, 120), refs: String(x.refs || "").slice(0, 500), notas: String(x.notas || "").slice(0, 2000),
    credito: creditoLimpio(x.credito),
  };
}

async function porFechaChofer(c, fecha, choferId, forUpdate, adicional) {
  const { rows } = await c.query(SELECT + " WHERE r.fecha = $1 AND r.chofer_id = $2 AND r.adicional = $3" + (forUpdate ? " FOR UPDATE OF r" : ""), [fecha, choferId, adicional || 0]);
  return rows[0] || null;
}
async function porId(c, id, forUpdate) {
  const { rows } = await c.query(SELECT + " WHERE r.id = $1" + (forUpdate ? " FOR UPDATE OF r" : ""), [id]);
  return rows[0] || null;
}

async function guardarVersion(c, row, motivo, usuarioId) {
  await c.query("INSERT INTO recibo_versiones (recibo_id, datos, motivo, usuario_id) VALUES ($1,$2,$3,$4)",
    [row ? row.id : null, JSON.stringify(row && row.id ? out(row) : row), motivo, usuarioId || null]);
}

// Inserta o reemplaza el recibo de (fecha, chofer). Si existía, guarda la versión anterior.
async function escribir(c, d, opts) {
  const prev = await porFechaChofer(c, d.fecha, d.choferId, true, d.adicional);
  if (prev) await guardarVersion(c, prev, opts.motivo || "Reemplazado", opts.usuarioId);
  const params = [d.fecha, d.fechaVenta, d.choferId, d.ruta, JSON.stringify(d.conteo), d.ach, d.yappy, d.cheque, d.efectivo, d.total,
    d.refs, d.notas, opts.usuarioId || null, opts.origen || "chofer", !!opts.alterado, opts.guardado || new Date().toISOString(), !!opts.verificado,
    opts.correcciones || 0, JSON.stringify(d.credito || []), d.adicional || 0];
  const { rows } = await c.query(`
    INSERT INTO recibos (fecha, fecha_venta, chofer_id, ruta, conteo, ach_c, yappy_c, cheque_c, efectivo_c, total_c, refs, notas, enviado_por, origen, alterado, guardado, verificado, correcciones, credito, adicional)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (fecha, chofer_id, adicional) DO UPDATE SET
      fecha_venta = EXCLUDED.fecha_venta, ruta = EXCLUDED.ruta, conteo = EXCLUDED.conteo, ach_c = EXCLUDED.ach_c, yappy_c = EXCLUDED.yappy_c,
      cheque_c = EXCLUDED.cheque_c, efectivo_c = EXCLUDED.efectivo_c, total_c = EXCLUDED.total_c, refs = EXCLUDED.refs, notas = EXCLUDED.notas, credito = EXCLUDED.credito,
      enviado_por = EXCLUDED.enviado_por, origen = EXCLUDED.origen, alterado = EXCLUDED.alterado, guardado = EXCLUDED.guardado,
      verificado = EXCLUDED.verificado, verificado_por = NULL, verificado_el = NULL, correcciones = EXCLUDED.correcciones,
      ajustado_por = NULL, ajustado_el = NULL, actualizado = now()
    RETURNING id`, params);
  return { id: rows[0].id, prev };
}

module.exports = { SELECT, out, clave, limpiar, porFechaChofer, porId, guardarVersion, escribir };
