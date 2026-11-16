"use strict";
const { Pool, types } = require("pg");

// Las fechas (tipo date) se devuelven como texto AAAA-MM-DD, sin zona horaria.
types.setTypeParser(1082, (v) => v);

const url = process.env.DATABASE_URL;
if (!url) { console.error("Falta la variable DATABASE_URL (Railway la crea al agregar PostgreSQL)."); process.exit(1); }
const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /\.railway\.internal[:/]/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: process.env.PGSSL === "off" || local ? false : { rejectUnauthorized: false },
  max: 10,
});

const q = (text, params) => pool.query(text, params);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

const CHOFERES_INICIALES = [
  ["ezequiel", "Ezequiel", "PTL 02", "Ruta"],
  ["carlos-perez", "Carlos Pérez", "Pma Oeste 02 · CAM 90", "Ruta"],
  ["david-rodriguez", "David Rodríguez", "Pma Centro · CAM 89", "Ruta"],
  ["nelson-zambrano", "Nelson Zambrano", "Colón 01 · CAM 88", "Ruta"],
  ["angel-moreno", "Angel Moreno", "UTTGR81", "Ruta"],
  ["sixto-de-leon", "Sixto De León", "Colón 02 · CAM 86", "Ruta"],
  ["sebastian", "Sebastián", "PTL 04", "Ruta"],
  ["felix-b", "Felix B", "Pinzón 04", "Ruta"],
  ["basilio-castro", "Basilio Castro", "Panamá Este 03 · CAM 87", "Ruta"],
  ["miguel-rodriguez", "Miguel Rodríguez", "CAM 88", "Ruta"],
  ["irving", "Irving", "Pinzón 04", "Food Services"],
  ["david-fs", "David (FS)", "UTT 75", "Food Services"],
  ["roderyck-sosa", "Roderyck Sosa", "FS CH-67", "Food Services"],
];

// Migraciones idempotentes: se pueden correr en cada arranque.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS choferes (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  ruta text NOT NULL DEFAULT '',
  tipo text NOT NULL DEFAULT 'Ruta' CHECK (tipo IN ('Ruta','Food Services')),
  activo boolean NOT NULL DEFAULT true,
  orden int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usuarios (
  id serial PRIMARY KEY,
  usuario text NOT NULL UNIQUE,
  nombre text NOT NULL DEFAULT '',
  rol text NOT NULL CHECK (rol IN ('gerente','asistente','chofer','consulta')),
  chofer_id text NULL REFERENCES choferes(id) ON UPDATE CASCADE,
  hash text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  intentos int NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz NULL,
  ultimo_ingreso timestamptz NULL,
  creado timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recibos (
  id serial PRIMARY KEY,
  fecha date NOT NULL,
  fecha_venta date NOT NULL,
  chofer_id text NOT NULL REFERENCES choferes(id) ON UPDATE CASCADE,
  ruta text NOT NULL DEFAULT '',
  conteo jsonb NOT NULL,
  ach_c int NOT NULL DEFAULT 0,
  yappy_c int NOT NULL DEFAULT 0,
  cheque_c int NOT NULL DEFAULT 0,
  efectivo_c int NOT NULL DEFAULT 0,
  total_c int NOT NULL DEFAULT 0,
  refs text NOT NULL DEFAULT '',
  notas text NOT NULL DEFAULT '',
  verificado boolean NOT NULL DEFAULT false,
  verificado_por int NULL REFERENCES usuarios(id),
  verificado_el timestamptz NULL,
  enviado_por int NULL REFERENCES usuarios(id),
  origen text NOT NULL DEFAULT 'chofer',
  alterado boolean NOT NULL DEFAULT false,
  guardado timestamptz NOT NULL DEFAULT now(),
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fecha, chofer_id)
);
CREATE TABLE IF NOT EXISTS recibo_versiones (
  id serial PRIMARY KEY,
  recibo_id int NULL,
  datos jsonb NOT NULL,
  motivo text NOT NULL DEFAULT '',
  usuario_id int NULL,
  restaurado boolean NOT NULL DEFAULT false,
  creado timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ventas (
  fecha date NOT NULL,
  chofer_id text NOT NULL REFERENCES choferes(id) ON UPDATE CASCADE,
  monto_c int NOT NULL,
  actualizado timestamptz NOT NULL DEFAULT now(),
  actualizado_por int NULL,
  PRIMARY KEY (fecha, chofer_id)
);
CREATE TABLE IF NOT EXISTS cierres (
  fecha date PRIMARY KEY,
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  actualizado timestamptz NOT NULL DEFAULT now(),
  actualizado_por int NULL
);
CREATE TABLE IF NOT EXISTS presentacion (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  titulo text NOT NULL DEFAULT 'Informe de Caja de Choferes',
  notas jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS auditoria (
  id serial PRIMARY KEY,
  usuario_id int NULL,
  accion text NOT NULL,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  cuando timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recibos_fecha_idx ON recibos (fecha);
CREATE INDEX IF NOT EXISTS versiones_creado_idx ON recibo_versiones (creado DESC);
CREATE INDEX IF NOT EXISTS auditoria_accion_idx ON auditoria (accion, cuando DESC);
INSERT INTO presentacion (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

async function migrate() {
  await q(SCHEMA);
  const { rows } = await q("SELECT count(*)::int AS n FROM choferes");
  if (rows[0].n === 0) {
    await tx(async (c) => {
      for (let i = 0; i < CHOFERES_INICIALES.length; i++) {
        const [id, nombre, ruta, tipo] = CHOFERES_INICIALES[i];
        await c.query("INSERT INTO choferes (id, nombre, ruta, tipo, activo, orden) VALUES ($1,$2,$3,$4,true,$5)", [id, nombre, ruta, tipo, i]);
      }
    });
    console.log("Lista inicial de choferes creada (" + CHOFERES_INICIALES.length + ").");
  }
}

const audit = (c, usuarioId, accion, detalle) =>
  (c || pool).query("INSERT INTO auditoria (usuario_id, accion, detalle) VALUES ($1,$2,$3)", [usuarioId || null, accion, JSON.stringify(detalle || {})]);

module.exports = { pool, q, tx, migrate, audit };
