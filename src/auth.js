"use strict";
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { q, audit } = require("./db");

const ROUNDS = 11;
const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 15;
const ROLES = ["gerente", "asistente", "chofer", "consulta"];
const DUMMY_HASH = bcrypt.hashSync("no-existe-" + crypto.randomBytes(8).toString("hex"), ROUNDS);

const hash = (clave) => bcrypt.hash(clave, ROUNDS);
const limpiarUsuario = (u) => String(u || "").trim().toLowerCase();
const USUARIO_RE = /^[a-z0-9._-]{3,40}$/;

// Clave fácil de dictar por teléfono: 4 letras + 4 números (sin letras confusas).
function generarClave() {
  const L = "abcdefghjkmnpqrstuvwxyz", N = "23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += L[crypto.randomInt(L.length)];
  s += "-";
  for (let i = 0; i < 4; i++) s += N[crypto.randomInt(N.length)];
  return s;
}
function claveValida(c) {
  return typeof c === "string" && c.length >= 6 && c.length <= 100;
}

async function login(req, res) {
  const usuario = limpiarUsuario(req.body && req.body.usuario);
  const clave = String((req.body && req.body.clave) || "");
  const fallo = (msg, status = 401) => res.status(status).json({ error: msg });
  if (!usuario || !clave) return fallo("Escribe tu usuario y tu clave.", 400);
  const { rows } = await q("SELECT * FROM usuarios WHERE usuario = $1", [usuario]);
  const u = rows[0];
  if (u && u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
    const min = Math.ceil((new Date(u.bloqueado_hasta) - new Date()) / 60000);
    return fallo("Demasiados intentos fallidos. Espera " + min + " minuto(s) o pide al gerente que restablezca tu clave.", 429);
  }
  const ok = await bcrypt.compare(clave, u ? u.hash : DUMMY_HASH);
  if (!u || !ok || !u.activo) {
    if (u) {
      const intentos = u.intentos + 1;
      const bloquear = intentos >= MAX_INTENTOS;
      await q("UPDATE usuarios SET intentos = $2, bloqueado_hasta = $3 WHERE id = $1",
        [u.id, bloquear ? 0 : intentos, bloquear ? new Date(Date.now() + BLOQUEO_MIN * 60000) : null]);
      await audit(null, u.id, "login_fallido", { bloqueado: bloquear });
    }
    return fallo(u && ok && !u.activo ? "Tu usuario está desactivado. Habla con el gerente." : "Usuario o clave incorrectos.");
  }
  await q("UPDATE usuarios SET intentos = 0, bloqueado_hasta = NULL, ultimo_ingreso = now() WHERE id = $1", [u.id]);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "No se pudo iniciar la sesión." });
    req.session.uid = u.id;
    req.session.save(() => res.json({ ok: true, rol: u.rol, destino: destino(u.rol) }));
  });
}
const destino = (rol) => (rol === "chofer" ? "/chofer" : "/portal");

// Carga el usuario de la sesión en cada petición (así un usuario desactivado sale de inmediato).
async function cargarUsuario(req, res, next) {
  if (!req.session || !req.session.uid) return next();
  try {
    const { rows } = await q(
      "SELECT u.id, u.usuario, u.nombre, u.rol, u.chofer_id, u.activo, c.nombre AS chofer_nombre, c.ruta AS chofer_ruta, c.tipo AS chofer_tipo, c.activo AS chofer_activo " +
      "FROM usuarios u LEFT JOIN choferes c ON c.id = u.chofer_id WHERE u.id = $1", [req.session.uid]);
    const u = rows[0];
    if (u && u.activo && (u.rol !== "chofer" || u.chofer_id)) req.user = u;
    else req.session.uid = null;
    next();
  } catch (e) { next(e); }
}

// Permisos: siempre en el servidor.
const requiere = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." });
  if (roles.length && !roles.includes(req.user.rol)) return res.status(403).json({ error: "No tienes permiso para esto." });
  next();
};

async function cambiarMiClave(req, res) {
  const { actual, nueva } = req.body || {};
  if (!claveValida(nueva)) return res.status(400).json({ error: "La clave nueva debe tener al menos 6 caracteres." });
  const { rows } = await q("SELECT hash FROM usuarios WHERE id = $1", [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(String(actual || ""), rows[0].hash))) return res.status(400).json({ error: "La clave actual no es correcta." });
  await q("UPDATE usuarios SET hash = $2 WHERE id = $1", [req.user.id, await hash(nueva)]);
  // Cierra las demás sesiones abiertas de este usuario.
  await q("DELETE FROM sesiones WHERE (sess->>'uid')::int = $1 AND sid <> $2", [req.user.id, req.sessionID]).catch(() => {});
  await audit(null, req.user.id, "cambio_clave", {});
  res.json({ ok: true });
}

// Primer gerente: solo si la tabla de usuarios está vacía.
async function crearPrimerGerente() {
  const { rows } = await q("SELECT count(*)::int AS n FROM usuarios");
  if (rows[0].n > 0) return;
  const usuario = limpiarUsuario(process.env.ADMIN_USER);
  const clave = process.env.ADMIN_PASSWORD;
  if (!usuario || !claveValida(clave)) {
    console.warn("No hay usuarios. Define ADMIN_USER y ADMIN_PASSWORD (mínimo 6 caracteres) y reinicia para crear el primer gerente.");
    return;
  }
  await q("INSERT INTO usuarios (usuario, nombre, rol, hash) VALUES ($1, $2, 'gerente', $3)", [usuario, process.env.ADMIN_NAME || "Gerente administrativo", await hash(clave)]);
  console.log("Primer gerente creado: " + usuario + ". Ya puedes borrar ADMIN_PASSWORD de las variables.");
}

module.exports = { login, cargarUsuario, requiere, cambiarMiClave, crearPrimerGerente, generarClave, claveValida, hash, limpiarUsuario, USUARIO_RE, ROLES, destino };
