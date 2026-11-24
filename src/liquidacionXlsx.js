"use strict";
// Libro Excel de liquidación con el mismo formato de "10- Liquidación Octubre 2026.xlsx":
// una hoja por día de venta (dd-mm-aaaa), filas de liquidación inicial, crédito, notas, merma, final, cobrado,
// ACH/cheques, dinero recibido, diferencia y el bloque "Totales Finales". Con el logo de Tasty Choice.
const path = require("path");
const ExcelJS = require("exceljs");

const TZ = "America/Panama";
const NAVY = "FF0A3A6B", GRIS = "FFD9D9D9", CLARO = "FFDCE6F1", OSCURO = "FF595959", AMARILLO = "FFFFFF00", ROJO = "FFFF0000";
const NUM = "#,##0.00";
const CONT = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const letra = (n) => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }; // 0 → A
const dmy = (f) => f.split("-").reverse().join("-");
const fechaDate = (f) => { const [y, m, d] = f.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fechaHora = (d) => new Date(d).toLocaleString("es-PA", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
const usd = (c) => Math.round(c) / 100;

function nombreLibro(desde, hasta) {
  const [y1, m1] = desde.split("-"), [y2, m2] = hasta.split("-");
  if (y1 === y2 && m1 === m2) return `${m1}- Liquidación ${MESES[Number(m1) - 1]} ${y1}.xlsx`;
  return `Liquidación ${dmy(desde)} a ${dmy(hasta)}.xlsx`;
}

const borde = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

async function libroLiquidacion(dias, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Caja de Choferes · Tasty Choice";
  wb.created = new Date();
  const logo = wb.addImage({ filename: path.join(__dirname, "..", "public", "logo.png"), extension: "png" });
  for (const d of dias) hoja(wb, d, logo, opts);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function hoja(wb, D, logo, opts) {
  const ws = wb.addWorksheet(dmy(D.fechaVenta), { views: [{ showGridLines: true }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 1 } });
  // Solo las columnas con datos (venta en SAP, cambios o recibos).
  D = { ...D, cols: D.cols.filter((c) => c.inicial || c.final || c.notas || c.facturas || c.credito || c.recibos) };
  const n = Math.max(1, D.cols.length);
  const ult = letra(n);                     // última columna de camiones
  const C = (i) => letra(i + 1);            // columna del camión i (0 → B)
  ws.getColumn(1).width = 24;
  for (let i = 0; i < n; i++) ws.getColumn(i + 2).width = i === 0 ? 19 : 16; // B también lleva "Fecha de Despacho"

  const celda = (ref, valor, st = {}) => {
    const c = ws.getCell(ref);
    if (valor !== undefined) c.value = valor;
    c.font = { name: "Aptos Narrow", size: st.size || 12, bold: !!st.bold, color: { argb: st.color || "FF000000" } };
    c.alignment = { horizontal: st.h || "center", vertical: "middle", wrapText: !!st.wrap };
    if (st.fill) c.fill = fill(st.fill);
    if (st.fmt) c.numFmt = st.fmt;
    if (st.borde !== false) c.border = borde;
    return c;
  };
  const etiqueta = (fila, texto) => celda("A" + fila, texto, { bold: true, size: 10, color: "FFFFFFFF", fill: NAVY, h: "left", wrap: true });

  // Encabezado
  const ultH = letra(Math.max(n, 2)); // el encabezado cubre al menos hasta la columna de las fechas (C)
  ws.mergeCells(`A1:${ultH}1`); celda("A1", "JUMBO CAPITAL, S.A.", { bold: true, color: "FFFFFFFF", fill: NAVY });
  ws.mergeCells(`A2:${ultH}2`); celda("A2", "ENTREGAS DTT", { bold: true, color: "FFFFFFFF", fill: NAVY });
  const fechas = [["Fecha de Pedido", D.fechaVenta], ["Fecha de Despacho", D.entrega], ["Fecha de cobro", D.entrega]];
  // Logo a la izquierda (A3:A5); fechas a su derecha.
  ws.mergeCells("A3:A5"); celda("A3", "", {});
  ws.addImage(logo, { tl: { col: 0.25, row: 2.12 }, ext: { width: 104, height: 61 }, editAs: "oneCell" });
  if (n < 2) ws.getColumn(3).width = 15;
  fechas.forEach(([t, f], k) => {
    const r = 3 + k;
    celda("B" + r, t, { bold: true, fill: GRIS, h: "left", size: 11 });
    celda("C" + r, fechaDate(f), { bold: true, fmt: "dd/mm/yyyy" });
    ws.getRow(r).height = 22;
  });

  ws.mergeCells("A6:A7"); celda("A6", "Descripcion", { color: "FFFFFFFF", fill: NAVY });
  if (n > 1) { ws.mergeCells(`B6:${ult}6`); ws.mergeCells(`B7:${ult}7`); }
  celda("B6", "", { fill: CLARO }); celda("B7", "", { fill: OSCURO });

  // Filas por camión
  const filas = [
    [8, "Rutas"], [9, "Chofer"], [10, "Hora de Salida de Planta"], [11, "Liquidacion inicial Facturación"], [12, "Crédito"],
    [13, "Notas de Credito No Entrega"], [14, "Factura De Merma Sin Entregar"], [15, "Liquidacion Final"], [16, "Cobrado"],
    [17, "Diferencial Liquidacion Inicial /Final"], [18, "ACH O Cheques"], [19, "Dinero recibido en caja"], [20, "Diferencia en caja"],
  ];
  for (const [r, t] of filas) etiqueta(r, t);
  for (const r of [11, 13, 14, 17, 20]) ws.getRow(r).height = 27;
  for (let i = 0; i < n; i++) {
    const L = C(i), col = D.cols[i];
    if (!col) { for (let r = 8; r <= 20; r++) celda(L + r, undefined, r === 8 ? { fill: CLARO } : {}); continue; }
    const fin = col.inicial - col.credito - col.notas + col.facturas;
    celda(L + 8, col.camion, { fill: CLARO });
    celda(L + 9, col.chofer.toUpperCase(), { size: 10, wrap: true });
    celda(L + 10, "");
    celda(L + 11, usd(col.inicial), { bold: true, fmt: NUM });
    celda(L + 12, usd(col.credito), { fmt: NUM, color: "FF0A4D8F" });
    celda(L + 13, usd(col.notas), { fmt: NUM });
    celda(L + 14, usd(col.facturas), { fmt: NUM });
    celda(L + 15, { formula: `+${L}11-${L}12-${L}13+${L}14`, result: usd(fin) }, { fmt: NUM });
    celda(L + 16, { formula: `${L}15`, result: usd(fin) }, { fmt: NUM });
    celda(L + 17, { formula: `+${L}11-${L}12-${L}13+${L}14-${L}15`, result: 0 }, { bold: true, fmt: "0.00" });
    celda(L + 18, col.recibos ? usd(col.otros) : null, { fmt: NUM, color: "FF0A4D8F" });
    celda(L + 19, col.recibos ? usd(col.efectivo) : null, { fmt: NUM, color: "FF0A4D8F" });
    const dif = fin - col.otros - col.efectivo;
    celda(L + 20, { formula: `${L}15-${L}18-${L}19`, result: usd(dif) }, { fmt: NUM, bold: dif !== 0, color: dif > 0 ? "FFC8141B" : dif < 0 ? "FF1E7B34" : "FF000000" });
  }
  ws.getRow(9).height = D.cols.some((c) => c.chofer.length > 16) ? 42 : 27;

  // Totales finales
  const suma = (r) => `SUM(B${r}:${ult}${r})`;
  const tot = (k) => D.cols.reduce((a, c) => a + c[k], 0);
  const tIni = tot("inicial"), tCred = tot("credito"), tNot = tot("notas"), tFac = tot("facturas");
  const tFin = tIni - tCred - tNot + tFac, tDep = tot("otros") + tot("efectivo");
  ws.mergeCells("A21:B21"); celda("A21", "Totales Finales", { bold: true, size: 10, borde: false });
  const totales = [
    [22, " Liquidacion Inicial", suma(11), tIni], [23, "Credito", suma(12), tCred], [24, "Total de Nota de Credito", suma(13), tNot],
    [25, "Total Factura De Merma Sin Entregar", suma(14), tFac], [26, "Liquidacion Final", "+B22-B23-B24+B25", tFin],
    [27, "Menos TLA", null, 0], [28, "Total de liquidacion sin TLA", "B26-B27", tFin], [29, "Asistente de Pago", suma(16), tFin],
    [30, "Deposito de Caja - Chutra", `SUM(B18:${ult}19)`, tDep], [31, "Diferencia de Liquidacion Cobrado", "+B29-B30", tFin - tDep],
    [32, "Aun no Cobrado / TLA", null, 0], [33, "Total Venta", "+B28+B32", tFin], [34, "Faltante de liquidacion - Choferes", "+B29-B30", tFin - tDep],
  ];
  for (const [r, t, f, v] of totales) {
    etiqueta(r, t);
    const st = { bold: true, fmt: CONT };
    if (r === 31) st.color = ROJO;
    if (r === 34) { st.color = ROJO; st.fill = AMARILLO; }
    celda("B" + r, f ? { formula: f, result: usd(v) } : 0, st);
  }
  for (const r of [25, 28, 30, 31, 34]) ws.getRow(r).height = 27;

  // Notas de origen de los datos
  const notas = [
    "Liquidación inicial: " + (D.sinInicial ? "no hay lectura inicial guardada para este día; se usa la facturación actual de SAP." : "SAP leído el " + fechaHora(D.leidoInicial)),
    "Liquidación final: SAP" + (D.leidoFinal ? " leído el " + fechaHora(D.leidoFinal) : "") + " (canal DT). Notas de crédito y facturas = cambios en SAP después de la lectura inicial.",
    "Crédito, ACH o cheques (incluye Yappy) y dinero recibido: recibos de los choferes en el portal Caja de Choferes.",
    "Generado el " + fechaHora(new Date()) + (opts.generadoPor ? " por " + opts.generadoPor : "") + (opts.aviso ? ". " + opts.aviso : "."),
  ];
  notas.forEach((t, k) => { const c = ws.getCell("A" + (36 + k)); c.value = t.replace(/\.\.$/, ".").replace(/\. \./g, "."); c.font = { name: "Aptos Narrow", size: 9, italic: true, color: { argb: "FF5A6572" } }; });
}

module.exports = { libroLiquidacion, nombreLibro };
