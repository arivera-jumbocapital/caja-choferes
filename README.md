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

Al abrir un día en el **Panel**, el portal lee SAP (facturas y notas de crédito, sin servicios ni anulados) y llena la **Venta** de cada chofer con el **neto** de su camión: facturado (almacén 09) − merma (10) − devolución (16). La tarjeta **Facturación** muestra el total y de qué día salió.

- **Día de venta:** el día anterior a la entrega; la entrega del **lunes** toma el **sábado**.
- Cada camión de SAP (`U_CodVehiculo`, p. ej. `CAM-90`, `PE-PTL-02`) se relaciona con un chofer por el campo **Camión SAP** de la *Lista de choferes*, la ruta de su recibo del día o su ruta en la lista. Si no queda claro (dos choferes con el mismo camión), la tarjeta avisa "Sin chofer: …".
- Una venta **escrita a mano no se reemplaza**. Si se borra, vuelve la de SAP.
- SAP se lee como máximo cada 15 minutos por día; pasados 2 días la cifra queda fija. El botón **Actualizar SAP** (junto a Descargar reporte Excel) lo vuelve a leer en el momento (mínimo 1 minuto entre lecturas).

## Reglas que respeta el servidor

- Para un chofer, el chofer del recibo sale **siempre de su usuario**; no puede registrar a nombre de otro.
- El chofer puede **corregir su recibo una sola vez** (se le pide confirmar con un segundo toque). Al segundo intento el servidor lo rechaza y el recibo queda cerrado. Guardar exactamente lo mismo no cuenta como corrección. En el Panel aparece la etiqueta "Corregido 1 vez".
- Si hace falta darle otra oportunidad, la oficina puede eliminar el recibo (queda copia en Historial) para que el chofer lo registre de nuevo.
- Un recibo **verificado** ya no lo puede cambiar el chofer.
- **Gerencia y asistentes pueden corregir la cantidad de billetes y monedas** de un recibo (Panel → detalle → *Corregir cantidades*). Los totales se recalculan en el servidor, la versión del chofer queda en Historial, el recibo muestra "Ajustado por oficina" y el chofer ya no puede cambiarlo.
- Corregir, reemplazar, importar encima o eliminar un recibo guarda la versión anterior (*Historial e importar → Versiones guardadas aparte*, con botón Restaurar).
- Los choferes con recibos no se borran de la lista: quedan inactivos.
- Montos en centavos enteros; totales recalculados en el servidor.
- Sesión con cookie `httpOnly`, `secure` y `sameSite=lax`, de 12 horas. Toda escritura debe ser JSON (protección contra envíos desde otros sitios).
- Fechas "de hoy" en hora de Panamá.
