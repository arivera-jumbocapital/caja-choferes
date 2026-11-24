"use strict";
// Lectura (solo lectura) de facturas y notas de crédito de SAP Business One.
// SAP HANA se consulta a través de un SQL Server con el linked server [HANA-005].
// Las credenciales van SOLO en variables de entorno (MSSQL_HOST, MSSQL_PORT, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD).
const sql = require("mssql");

const ESQUEMA = '"20024_JUMBO_C"';
const configurado = () => !!(process.env.MSSQL_HOST && process.env.MSSQL_USER && process.env.MSSQL_PASSWORD && process.env.MSSQL_DATABASE);

let poolPromise = null;
function pool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: process.env.MSSQL_HOST,
      port: Number(process.env.MSSQL_PORT || 1433),
      database: process.env.MSSQL_DATABASE,
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      options: { encrypt: true, trustServerCertificate: true },
      requestTimeout: 90000,
      connectionTimeout: 20000,
      pool: { max: 2, min: 0, idleTimeoutMillis: 60000 },
    }).connect().catch((e) => { poolPromise = null; throw e; });
  }
  return poolPromise;
}

// Resumen por camión de un rango de fechas de venta (consulta 5.2 de la guía).
// Facturado = facturas al 09 − notas al 09; Merma = notas al 10 − facturas al 10;
// Devolución = notas al 16 − facturas al 16; Neto = Facturado − Merma − Devolución.
// Crédito = neto de los documentos con condición de pago a crédito (OCTG con días, p. ej. "Credito 30 dias"); Contado = Neto − Crédito.
// Solo canal DT (clientes cuyo código empieza con DT): es el canal de las rutas de los choferes.
// Los demás canales (UT supermercados, FS, MQ, EM, CN) usan otros camiones y no entran en la caja de choferes.
function consultaResumen(desde, hasta, porDia) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new Error("Fecha no válida.");
  const parte = (cab, lin, signo) => `
  SELECT ${signo} AS "signo", TO_VARCHAR(T0."DocDate", 'YYYY-MM-DD') AS "dia", IFNULL(NULLIF(T0."U_CodVehiculo", ''), 'Sin camion') AS "camion", T0."DocTotal" AS "total",
         (SELECT MAX(L."WhsCode") FROM ${ESQUEMA}."${lin}" L WHERE L."DocEntry" = T0."DocEntry") AS "almacen",
         (SELECT COUNT(DISTINCT L."WhsCode") FROM ${ESQUEMA}."${lin}" L WHERE L."DocEntry" = T0."DocEntry") AS "almacenes",
         IFNULL((SELECT CASE WHEN C."ExtraMonth" > 0 OR C."ExtraDays" > 0 THEN 1 ELSE 0 END FROM ${ESQUEMA}."OCTG" C WHERE C."GroupNum" = T0."GroupNum"), 0) AS "escredito"
  FROM ${ESQUEMA}."${cab}" T0
  WHERE T0."CANCELED" = 'N' AND T0."DocType" = 'I' AND LEFT(T0."CardCode", 2) = 'DT' AND T0."DocDate" >= '${desde}' AND T0."DocDate" <= '${hasta}'`;
  const dia = porDia ? 'D."dia", ' : "";
  return `SELECT ${dia}D."camion", COUNT(*) AS "documentos",
       SUM(CASE WHEN D."almacen" = '09' THEN  D."signo" * D."total" ELSE 0 END) AS "facturado",
       SUM(CASE WHEN D."almacen" = '10' THEN -D."signo" * D."total" ELSE 0 END) AS "merma",
       SUM(CASE WHEN D."almacen" = '16' THEN -D."signo" * D."total" ELSE 0 END) AS "devolucion",
       SUM(CASE WHEN D."almacen" IN ('09', '10', '16') THEN D."signo" * D."total" ELSE 0 END) AS "neto",
       SUM(CASE WHEN D."almacen" IN ('09', '10', '16') AND D."escredito" = 1 THEN D."signo" * D."total" ELSE 0 END) AS "credito",
       SUM(CASE WHEN D."almacenes" > 1 THEN 1 ELSE 0 END) AS "varios"
FROM (${parte("OINV", "INV1", 1)}
  UNION ALL ${parte("ORIN", "RIN1", -1)}
) D
GROUP BY ${dia}D."camion"
ORDER BY ${dia}D."camion"`;
}

const cents = (v) => Math.round(Number(v || 0) * 100);

async function resumenPorCamion(desde, hasta, porDia) {
  if (!configurado()) { const e = new Error("La conexión con SAP no está configurada (faltan las variables MSSQL_* en Railway)."); e.status = 503; throw e; }
  const hana = consultaResumen(desde, hasta, porDia);
  const p = await pool();
  const { recordset } = await p.request().query(`SELECT * FROM OPENQUERY([HANA-005], '${hana.replace(/'/g, "''")}')`);
  return recordset.map((r) => ({
    ...(porDia ? { dia: String(r.dia) } : {}),
    camion: String(r.camion || "Sin camion").trim(),
    documentos: Number(r.documentos || 0),
    facturado: cents(r.facturado), merma: cents(r.merma), devolucion: cents(r.devolucion), neto: cents(r.neto),
    credito: cents(r.credito), // parte del neto de clientes con condición de pago a crédito; el resto es contado
    varios: Number(r.varios || 0),
  }));
}

module.exports = { configurado, resumenPorCamion };
