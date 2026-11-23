/* Reporte Inicial de Liquidación (venta inicial DTT de SAP) en PDF.
   Lo usan el portal (botón "Descargar PDF") y el servidor (envío automático por correo), para que ambos salgan iguales.
   dibujarLiquidacion(doc, datos) dibuja sobre un documento jsPDF (con jspdf-autotable) ya creado:
     datos = { camiones, sinAsignarFilas, consultado, fechas: {venta, factura, despacho, cobro}, nombre(id), logo (data URL), generadoPor } */
(function (raiz) {
  "use strict";
  const TZ = "America/Panama";
  const fechaLarga = (f) => new Date(f + "T12:00:00Z").toLocaleDateString("es-PA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const fechaHora = (d) => new Date(d).toLocaleString("es-PA", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  const usd = (c) => (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nombreArchivo = (fechaVenta) => "Reporte inicial de liquidacion DTT " + fechaVenta.split("-").reverse().join("-") + ".pdf";
  const mesDe = (f) => { const m = new Date(f + "T12:00:00Z").toLocaleDateString("es-PA", { month: "long", year: "numeric", timeZone: "UTC" }).replace(/ de /, " "); return m.charAt(0).toUpperCase() + m.slice(1); };

  function dibujarLiquidacion(doc, D) {
    const F = D.fechas, nombre = D.nombre || ((id) => id);
    const W = doc.internal.pageSize.getWidth(), M = 15, AZUL = [10, 77, 143], ROJO = [200, 20, 27], DORADO = [242, 178, 48];
    // Franja de marca (rojo 34 %, dorado 16 %, azul 50 %).
    doc.setFillColor(...ROJO); doc.rect(0, 0, W * 0.34, 3, "F");
    doc.setFillColor(...DORADO); doc.rect(W * 0.34, 0, W * 0.16, 3, "F");
    doc.setFillColor(...AZUL); doc.rect(W * 0.5, 0, W * 0.5, 3, "F");
    if (D.logo) doc.addImage(D.logo, "PNG", M, 9, 34, 34 * 227 / 385);
    doc.setTextColor(22, 32, 43); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text("Jumbo Capital, S.A.", W - M, 15, { align: "right" });
    doc.setFontSize(12); doc.text("Reporte Inicial de Liquidación", W - M, 22, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...AZUL);
    doc.text(mesDe(F.venta) + " · Ventas DTT", W - M, 28.5, { align: "right" });
    // Fechas
    const fechas = [["Fecha de venta", F.venta], ["Fecha de factura", F.factura], ["Fecha de despacho", F.despacho], ["Fecha de cobro", F.cobro]];
    const y0 = 38, cw = (W - 2 * M) / 4;
    fechas.forEach(([l, f], i) => {
      const x = M + i * cw;
      doc.setDrawColor(220, 225, 232); doc.setFillColor(242, 244, 247); doc.roundedRect(x + 1, y0, cw - 2, 15, 2, 2, "FD");
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(90, 101, 114); doc.text(l.toUpperCase(), x + 3.5, y0 + 5.5);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(22, 32, 43); doc.text(fechaLarga(f), x + 3.5, y0 + 11.5);
    });
    // Tabla por ruta
    const filas = [...(D.camiones || [])].sort((a, b) => a.camion.localeCompare(b.camion));
    const tot = (k) => filas.reduce((a, x) => a + (x[k] || 0), 0);
    const cols = { 0: { cellWidth: 28 }, 2: { halign: "right", cellWidth: 25 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } };
    doc.autoTable({
      startY: y0 + 22, margin: { left: M, right: M },
      head: [["Camión", "Chofer", "Documentos", "Facturado", "Merma", "Devolución", "Neto"]],
      body: filas.map((x) => [x.camion, (x.comparten || [x.choferId]).map(nombre).join(" / "), String(x.documentos ?? ""), usd(x.facturado || 0), usd(x.merma || 0), usd(x.devolucion || 0), usd(x.neto || 0)]),
      foot: [["Total rutas", "", String(tot("documentos")), usd(tot("facturado")), usd(tot("merma")), usd(tot("devolucion")), usd(tot("neto"))]],
      theme: "grid", styles: { font: "helvetica", fontSize: 9, cellPadding: 2.2, lineColor: [220, 225, 232], textColor: [22, 32, 43] },
      headStyles: { fillColor: AZUL, textColor: 255, fontStyle: "bold", halign: "center" },
      footStyles: { fillColor: [230, 237, 245], textColor: [22, 32, 43], fontStyle: "bold" },
      columnStyles: { ...cols, 6: { halign: "right", fontStyle: "bold" } },
      didParseCell: (d) => { if (d.section === "foot" && d.column.index >= 2) d.cell.styles.halign = "right"; },
    });
    let y = doc.lastAutoTable.finalY + 6;
    const sinCh = D.sinAsignarFilas || [];
    if (sinCh.length) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(22, 32, 43); doc.text("Camiones sin chofer asignado (no incluidos en el total)", M, y);
      doc.autoTable({ startY: y + 2, margin: { left: M, right: M }, body: sinCh.map((x) => [x.camion, (x.empate || []).length ? "Empate: " + x.empate.join(" / ") : "Sin chofer", String(x.documentos ?? ""), usd(x.facturado || 0), usd(x.merma || 0), usd(x.devolucion || 0), usd(x.neto || 0)]),
        theme: "grid", styles: { fontSize: 8.5, cellPadding: 2, textColor: [90, 101, 114], lineColor: [220, 225, 232] }, columnStyles: cols });
      y = doc.lastAutoTable.finalY + 6;
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(90, 101, 114);
    doc.text(doc.splitTextToSize("Fuente: SAP Business One, canal DT (clientes con código DT). Neto = facturado - merma - devolución. Venta inicial según la facturación emitida" + ((D.consultado ? "; datos leídos el " + fechaHora(D.consultado) : "") + ".").replace(/\.\.$/, "."), W - 2 * M), M, y);
    const gen = "Generado el " + fechaHora(new Date()) + (D.generadoPor ? " por " + D.generadoPor : "");
    const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
    for (let p = 1; p <= n; p++) { doc.setPage(p); doc.setFontSize(8); doc.setTextColor(90, 101, 114); doc.text(gen, M, H - 8); doc.text("Página " + p + " de " + n, W - M, H - 8, { align: "right" }); }
    return { total: tot("neto"), camiones: filas.length };
  }

  const L = { dibujarLiquidacion, nombreArchivo, fechaLarga, usd, mesDe };
  if (typeof module === "object" && module.exports) module.exports = L;
  else raiz.Liquidacion = L;
})(typeof window !== "undefined" ? window : globalThis);
