"use strict";
// Caja de Choferes · Tasty Choice — servidor web (Express + PostgreSQL) para Railway.
process.env.TZ = process.env.TZ || "America/Panama";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const { pool, q, migrate } = require("./src/db");
const A = require("./src/auth");
const api = require("./src/api");
const reporte = require("./src/reporte");

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (PROD) { console.error("Falta SESSION_SECRET (texto aleatorio de al menos 32 caracteres)."); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET no definida: se usa una temporal (las sesiones se pierden al reiniciar).");
}

const app = express();
app.set("trust proxy", 1); // Railway pone un proxy delante; necesario para cookies "secure".
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});

app.get("/health", async (req, res) => {
  try { await q("SELECT 1"); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
});

app.use(express.json({ limit: "25mb" }));
app.use(session({
  store: new PgStore({ pool, tableName: "sesiones", createTableIfMissing: true, pruneSessionInterval: 60 * 60 }),
  name: "caja.sid",
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: PROD, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(A.cargarUsuario);

app.use("/api/reporte", reporte.router);
app.use("/api", api);

// Páginas
const VIEWS = path.join(__dirname, "views");
const page = (file) => (req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(VIEWS, file)); };
const soloCon = (roles, file) => (req, res, next) => {
  if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  if (!roles.includes(req.user.rol)) return res.redirect(A.destino(req.user.rol));
  page(file)(req, res, next);
};
app.get("/", (req, res) => res.redirect(req.user ? A.destino(req.user.rol) : "/login"));
app.get("/login", (req, res, next) => (req.user ? res.redirect(A.destino(req.user.rol)) : page("login.html")(req, res, next)));
app.get("/chofer", soloCon(["chofer"], "chofer.html"));
app.get("/portal", soloCon(["gerente", "asistente", "consulta"], "portal.html"));
app.get("/cuenta", soloCon(A.ROLES, "cuenta.html"));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d", index: false }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") return res.status(413).json({ error: "El archivo es demasiado grande." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Datos no válidos." });
  console.error(err);
  res.status(500).json({ error: "Error del servidor. Intenta de nuevo." });
});

(async () => {
  await migrate();
  await A.crearPrimerGerente();
  app.listen(PORT, () => console.log("Caja de Choferes escuchando en el puerto " + PORT));
  reporte.iniciar();
})().catch((e) => { console.error("No se pudo arrancar:", e); process.exit(1); });
