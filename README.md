# Caja de Choferes · Tasty Choice (versión web para Railway)

Un solo enlace para todos. Cada persona entra con **usuario y clave** propios (sin Google, Microsoft ni Claude):

| Quién | Entra a | Qué ve |
|---|---|---|
| Chofer | `/chofer` | Solo su recibo, con su nombre fijo. Guarda directo en el sistema, puede **corregirlo una sola vez** y **descargarlo** como página (para guardar, imprimir o PDF). |
| Gerente administrativo | `/portal` | Todo, más **Lista de choferes**, **Usuarios**, importar y respaldo. |
| Asistente | `/portal` | Panel, Choferes, Cierre, Gráficas, Presentación e Historial. Escribe venta y cierre, verifica y exporta Excel. |
| Consulta (gerente general) | `/portal` | Gráficas, movimiento diario y Presentación, solo lectura. |

## Archivos

```
server.js          arranque: sesiones, páginas, /health
src/db.js          conexión a PostgreSQL, tablas (se crean solas) y lista inicial de choferes
src/auth.js        inicio de sesión, bcrypt, bloqueo tras 5 intentos (15 min), primer gerente
src/api.js         toda la API con los permisos de cada rol
src/recibos.js     guardar recibos; cada reemplazo o eliminación deja copia en recibo_versiones
src/importar.js    importa los .json de los choferes y los respaldos del portal offline
src/sap.js         lee de SAP (solo lectura) la facturación del día por camión
src/calc.js        denominaciones y sumas en centavos (los totales siempre se recalculan en el servidor)
views/             login, chofer, portal (gerencia) y cuenta (cambiar clave)
public/logo.png    logo oficial sin modificar
```

## Desplegar en Railway (paso a paso)

1. **Subir el código a GitHub.** Crea un repositorio privado (por ejemplo `caja-choferes`) y sube **el contenido de esta carpeta `railway/`** (que `package.json` quede en la raíz del repositorio).
   ```bash
   git init
   git add .
   git commit -m "Caja de Choferes web"
   git branch -M main
   git remote add origin https://github.com/<tu-cuenta>/caja-choferes.git
   git push -u origin main
   ```
2. **Crear el proyecto en Railway:** New Project → *Deploy from GitHub repo* → elige el repositorio.
3. **Agregar la base de datos:** en el proyecto, *+ New* → *Database* → *PostgreSQL*.
4. **Variables del servicio web** (pestaña *Variables* del servicio, no de la base):
   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia a la base) |
   | `SESSION_SECRET` | texto aleatorio largo (64 caracteres o más) |
   | `ADMIN_USER` | usuario del primer gerente, por ejemplo `aneliz` |
   | `ADMIN_PASSWORD` | clave inicial del gerente (mínimo 6 caracteres) |
   | `TZ` | `America/Panama` |
   | `NODE_ENV` | `production` |
   | `MSSQL_HOST`, `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD` | conexión de solo lectura a SAP para la **Facturación SAP por ruta** (los valores están en la guía de SAP guardada fuera del repositorio; nunca en el código) |
5. **Health check:** en *Settings* → *Deploy* → *Healthcheck Path* = `/health`.
6. **Dominio:** *Settings* → *Networking* → *Generate Domain* (queda `algo.up.railway.app`) o agrega un dominio propio.
7. Abre el enlace, entra con `ADMIN_USER` / `ADMIN_PASSWORD`, ve a **Cambiar mi clave**, y después **borra `ADMIN_PASSWORD`** de las variables (solo se usa cuando no hay ningún usuario).
8. **Respaldos:** en el servicio de PostgreSQL activa *Backups*. Además, el portal tiene **Respaldo → Descargar respaldo completo** (JSON).

Las tablas y la lista inicial de 13 choferes se crean solas al primer arranque. Cada despliegue nuevo vuelve a revisar las tablas sin borrar nada.

## Primer uso

1. **Lista de choferes:** revisa nombres, rutas y quién es Food Services. Guarda.
2. **Usuarios → Nuevo usuario:** elige *Chofer*, el chofer, y el sistema sugiere el usuario (ej. `carlos.perez`). Al crear, aparece la clave **una sola vez** con un botón para copiar el mensaje y enviarlo por WhatsApp. Crea también las asistentes y el usuario *Consulta* del gerente general.
3. Si alguien olvida su clave o queda bloqueado: **Usuarios → Generar clave nueva**.
4. **Pasar los datos de la versión offline:** en el portal offline, *Respaldo → Descargar respaldo completo*; en la web, *Respaldo → Cargar respaldo*. También se pueden subir los `.json` sueltos de los choferes en *Historial e importar*.

## Probar en una computadora (opcional)

Requiere Node.js 20 y PostgreSQL.

```bash
npm install
```
```bash
DATABASE_URL=postgres://usuario:clave@localhost:5432/caja ADMIN_USER=gerente ADMIN_PASSWORD=prueba123 npm start
```
Luego abre http://localhost:3000.

## Facturación SAP (automática)

Al abrir un día en el **Panel**, el portal lee SAP (facturas y notas de crédito **solo del canal DT** —clientes cuyo código empieza con DT—, sin servicios ni anulados; los canales UT, FS, MQ, EM y CN no entran) y llena la **Venta** de cada chofer con el **neto** de su camión: facturado (almacén 09) − merma (10) − devolución (16). La tarjeta **Facturación** muestra el total y de qué día salió.

- **Día de venta:** el día anterior a la entrega; la entrega del **lunes** toma el **sábado**.
- Cada camión de SAP (`U_CodVehiculo`, p. ej. `CAM-90`, `PE-PTL-02`) se relaciona con un chofer por el campo **Camión SAP** de la *Lista de choferes*, la ruta de su recibo del día o su ruta en la lista. Si no queda claro (dos choferes con el mismo camión), la tarjeta avisa "Sin chofer: …".
- Una venta **escrita a mano no se reemplaza**. Si se borra, vuelve la de SAP.
- SAP se lee como máximo cada 15 minutos por día; pasados 2 días la cifra queda fija. El botón **Actualizar SAP** (junto a Descargar reporte Excel) lo vuelve a leer en el momento (mínimo 1 minuto entre lecturas).
- **Tabla "Facturación SAP" en el Panel:** muestra cada camión con su chofer, documentos, facturado, merma, devolución y neto del día de venta, aunque el chofer no haya entregado recibo. Los camiones sin chofer (o con **empate**, cuando el mismo camión SAP está en dos choferes activos) salen aparte y **no suman** en la Facturación.
- **Reporte inicial de liquidación (PDF):** debajo de la tabla Facturación SAP del Panel. Arma un PDF con el logo, "Jumbo Capital, S.A. · Reporte Inicial de Liquidación", el mes y "Ventas DTT", las fechas de venta, factura, despacho y cobro (se proponen solas y se pueden cambiar) y la venta inicial por camión de SAP (facturado, merma, devolución y neto). Usa jsPDF 2.5.1 y jspdf-autotable 3.8.2 de cdnjs, que se cargan solo al pulsar el botón. El dibujo del PDF está en `public/liquidacion.js` y lo usan tanto el portal como el servidor, así que el PDF del correo sale igual.
- **Reporte por correo:** el gerente escribe los correos en Usuarios → Reporte por correo (hora por defecto 3:00 a. m.). Todos los días, a esa hora de Panamá (y con reintentos cada 15 minutos hasta las 12:00 m. si falla), el servidor lee SAP, arma el PDF con la venta del día anterior y lo envía. Si SAP no tiene venta DT ese día, no envía nada. En el Panel, "Enviar por correo ahora" lo manda en cualquier momento. Cada envío queda en "Últimos envíos". La cuenta que envía se configura con variables de Railway (nunca en el código), con una de estas opciones:
  - Microsoft 365 (recomendado; lo registra quien administra Microsoft 365 con el permiso `Mail.Send` de aplicación): `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` y `CORREO_REMITENTE` (buzón que envía).
  - SMTP: `SMTP_HOST` (p. ej. `smtp.office365.com`), `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` y `CORREO_REMITENTE` (opcional). Railway puede bloquear SMTP según el plan.
  - Solo para pruebas locales: `CORREO_ARCHIVO=<carpeta>` guarda el correo (.eml) y el PDF en esa carpeta sin enviar nada.
- **Camión compartido:** si dos o más choferes activos tienen el mismo "Camión SAP", cada uno entrega su recibo. La venta del camión se guarda una sola vez (en el primero de la lista) y en el Panel la diferencia se calcula contra la suma de los recibos de todos los que comparten el camión. Los demás aparecen con la etiqueta "Camión compartido".

## Reglas que respeta el servidor

- Para un chofer, el chofer del recibo sale **siempre de su usuario**; no puede registrar a nombre de otro.
- El chofer puede **corregir su recibo una sola vez** (se le pide confirmar con un segundo toque). Al segundo intento el servidor lo rechaza y el recibo queda cerrado. Guardar exactamente lo mismo no cuenta como corrección. En el Panel aparece la etiqueta "Corregido 1 vez".
- Si hace falta darle otra oportunidad, la oficina puede eliminar el recibo (queda copia en Historial) para que el chofer lo registre de nuevo.
- Un recibo **verificado** ya no lo puede cambiar el chofer.
- El chofer puede anotar **clientes a crédito** (cliente, factura y monto). Son informativos: no suman al total entregado ni a los depósitos. En el Panel (*Recibos del día*) la columna **Crédito** sí entra en el Total para calcular la diferencia contra lo facturado.
- **Gerencia y asistentes pueden corregir la cantidad de billetes y monedas y los montos de ACH, Yappy y cheque** de un recibo (Panel → detalle → *Corregir recibo*). Los totales se recalculan en el servidor, la versión del chofer queda en Historial, el recibo muestra "Ajustado por oficina" y el chofer ya no puede cambiarlo.
- **La oficina puede emitir un recibo de chofer** (Panel → *Emitir recibo*): escoge la fecha de entrega (caja), la fecha de venta, el chofer y la ruta, y escribe las piezas, ACH, Yappy y cheque. Queda como recibo **adicional** (no reemplaza el del chofer; un chofer puede tener varios recibos en la misma fecha). Sirve cuando el chofer termina al día siguiente una ruta que no entregó completa: ese dinero entra en la caja de ese día. La venta del chofer va en su primer recibo y la diferencia suma todos sus recibos del día. El chofer no ve los recibos adicionales.
- Corregir, reemplazar, importar encima o eliminar un recibo guarda la versión anterior (*Historial e importar → Versiones guardadas aparte*, con botón Restaurar).
- Los choferes con recibos no se borran de la lista: quedan inactivos.
- Montos en centavos enteros; totales recalculados en el servidor.
- Sesión con cookie `httpOnly`, `secure` y `sameSite=lax`, de 12 horas. Toda escritura debe ser JSON (protección contra envíos desde otros sitios).
- Fechas "de hoy" en hora de Panamá.
