# Zorbo

Server Express (`server.js`, ESM) + panel de administración (`admin-views/admin.html`).
Cubre el costeo de carta, finanzas, inventario, comercial y el chatbot.

- Arrancar: `npm start` (o `npm run dev`). Puerto: `PORT`, default 3000.
- Sin dependencias de build ni tests: se prueba levantando el server y pegándole a los endpoints.
- Para pegarle a `/admin/*` sin login: `ADMIN_AUTH_ENABLED=0`.

## Regla de datos — leer antes de cualquier cambio de costeo, carta, insumos o precios

**En producción los datos no viven en el repo.** El server corre en Railway con
`DATA_DIR` seteado y lee/escribe `$DATA_DIR/prompts/*.json` en un volumen
persistente. Los JSON del repo (`prompts/costeo.json` y compañía) son solo la
semilla para cuando el disco está vacío.

Editar esos archivos y pushear **no cambia nada en el sitio en vivo**: el deploy
no toca el volumen. Si el diff de un cambio de datos toca únicamente
`prompts/*.json`, casi seguro está mal.

Entonces, cuando el pedido implique crear, modificar o borrar datos (tragos,
platos, insumos, secciones, categorías, precios):

1. **El entregable va en código, no en el JSON de datos.**
2. Escribí una **migración versionada** en `server.js` con el patrón que ya usa
   el costeo: una constante `ALGO_V`, un flag de versión en el doc
   (`doc.carta.<xx>v`, declarado en `costeoNormalizeCarta`), una función que
   muta el doc y devuelve `true` si cambió algo, y el llamado en el
   `costeoEnsure*` que corresponda. Ver `costeoSeedCortosBarra`,
   `costeoSeedBotellasBarra` o `costeoCervezasKairos` como referencia.
3. Que sea **idempotente de verdad**: dedupe por nombre normalizado
   (`costeoNorm`), no confíes solo en el flag de versión. Tiene que poder correr
   dos veces sin duplicar nada.
4. **No pises lo que carga el usuario** (precios, precios de venta, ediciones a
   mano). Completá solo lo que esté vacío o roto, y decí en la respuesta lo que
   decidiste no tocar.
5. Si el cambio necesita datos nuevos (una lista, precios de un Excel), van en
   un `*-seed*.json` y la migración los lee de ahí. Lógica en `server.js`, data
   en el seed.
6. **Probalo antes de pushear**: levantá el server con `DATA_DIR` apuntando a
   una copia de los datos que simule producción — o sea, sin el cambio ya
   aplicado a mano — corré la migración y verificá contra los endpoints. Corré
   el arranque dos veces para confirmar que no duplica.
7. Cerrá la respuesta diciendo **qué mirar para confirmar que llegó al server en
   vivo**, no solo que el commit está pusheado.

`GET /admin/costeo/_diag` devuelve el commit que está corriendo, si hay volumen
persistente y los conteos por doc. Es la forma de confirmar un deploy de datos.

## No borrar lo que se carga a mano

Casi todo lo del panel se carga a mano: costos, gastos, notas de crédito,
rendimientos, objetivos, hitos, precios, reclasificaciones. Un deploy no puede
hacer desaparecer nada de eso. La trampa clásica:

- Una migración con **flag de versión que no se persiste o no se relee** vuelve a
  correr en cada arranque y pisa lo que el usuario corrigió a mano. Ya pasó:
  `costosLoad` no leía `data.migraciones`, así que la reclasificación se
  reaplicaba en cada boot. Si escribís un flag, **verificá que la función de load
  lo devuelva** — muchas arman el objeto con una lista fija de campos y silenciosamente
  descartan el resto.
- Lo mismo con las siembras: completar solo lo vacío, nunca sobrescribir.
- Si una migración **asigna un valor a un campo que el usuario también edita**
  (cantidades de receta, precios), no alcanza el flag de versión: cada bump lo
  vuelve a pisar. Usá `costeoSetAuto(obj, campo, valor)`, que solo escribe si el
  valor sigue siendo el que dejó la migración. Ya pasó con
  `costeoFixBotellaVolumen`, que iba por su tercera versión reescribiendo la
  cantidad de las 76 botellas en cada bump.
- **Probalo siempre con dos arranques seguidos** contra los mismos datos, con un
  cambio hecho "a mano" en el medio: si el segundo arranque lo revierte, está mal.

`GET /admin/_diag/almacenamiento` dice si el entorno tiene volumen persistente,
lista los archivos de datos con su tamaño y fecha, y muestra los respaldos.
Hay respaldo diario automático en `$DATA_DIR/backups/<AAAA-MM-DD>/` (la primera
copia del día gana, así un arranque posterior no pisa la foto buena), y
`POST /admin/_diag/restaurar` con `{dia, archivo}` recupera un archivo puntual.

Las copias diarias viven **dentro del mismo volumen**: sirven contra un bug o un
borrado, no contra perder el volumen. Para eso está Herramientas › **Respaldo de
datos**, que baja un `.zip` con `datos/*.json` + `uploads/*` y un `LEEME.txt`
(`GET /admin/_diag/respaldo.zip`). Es la única copia que queda afuera. El zip se
arma a mano con `zlib` — el proyecto no tiene paso de build y no vale la pena
estrenar una dependencia por 20 líneas de cabeceras. Si tocás `zipEscribir`,
probá el resultado con `unzip -t`: un offset mal escrito da un archivo que abre
en algunos programas y en otros no.

## Costeo: cómo está armado

Cuatro conjuntos independientes: `garden`, `badass` (comida) y `garden_barra`,
`badass_barra` (barra), todos en un solo archivo `costeo.json`.

- **Nivel 1 · Insumos** — precio de compra. En barra el precio es por litro
  **neto**, con ILA y despacho aparte; el IVA se aplica a nivel de trago.
- **Nivel 2 · Recetas base** — preparaciones que se usan en varios platos.
- **Nivel 3 · Platos/Tragos** — la receta que se vende. Cadena de costo:
  insumos → protección 10% → IVA 19% (salvo `iva: false`).
- **Nivel 4 · Carta (resumen)** — secciones y orden del menú real, con el precio
  de venta que se le cobra al público (`precioReal`) y el % de costo.
- **Reventa** (solo barra) — productos que se compran hechos y se revenden, sin
  receta: `{ nombre, precioVenta, precioCompra }`. Si una sección de carta tiene
  platos costeados, esos ganan y la sección de reventa homónima no se muestra.

## Espacio de trabajo (tareas del equipo)

Gestor de tareas del equipo dentro del `/admin`: proyectos, tablero kanban,
lista, "mis tareas", personas y campanita de avisos. Es aditivo — no toca ningún
módulo existente.

- **Datos**: un solo doc `workspace.json` en el directorio de datos (volumen
  persistente). Tiene ya declaradas las claves de lo que falta (`eventos`,
  `canales`, `mensajes`, `metas`) para no tener que migrar el archivo después.
  Está en `.gitignore`: no es código fuente.
- **Semillas**: los 6 proyectos iniciales se siembran UNA vez, con el flag
  `sembrado` — no con "¿está la lista vacía?". Si el usuario borra uno, no
  vuelve. Los estados por defecto se recrean solo si la lista quedó vacía.
- **Identidad**: una persona se identifica por su `username` (el correo con el
  que entra), no por el id de `team.json`. Es lo único que existe siempre, tanto
  si entró con cuenta propia como con la credencial de `ADMIN_USER`.
- **Roles** (`team.json`, campo `role`): `admin` ve y edita todo el panel;
  `miembro` solo el Espacio de trabajo. El corte está en `miembroRoleAllows()`
  dentro de `requireAdmin`, y es una lista de **permitidos**: un módulo nuevo
  nace cerrado para el miembro. Las cuentas viejas sin `role` valen como
  `admin`, así nadie pierde acceso. Un alta que no declara rol nace `miembro`.
- El front espeja el corte (`adminRole === 'miembro'` → sidebar y navegación
  acotados), pero el que manda es el server: el front es comodidad, no
  seguridad.
- La credencial de `ADMIN_USER`/`ADMIN_PASSWORD` **siempre** entra como admin,
  sin importar lo que diga el registro de equipo. Es la puerta de rescate si
  alguien se degrada a sí mismo por error.

### Calendario y reuniones

- Las fechas son **strings `YYYY-MM-DD`**, nunca `Date`. Un `Date` por celda
  mete la zona horaria en el medio y el día se corre. Los cálculos de grilla
  (`wsDow`, `wsSumarDias`) usan `Date.UTC` justamente para que el número que
  sale sea el del string.
- El `.ics` se emite en **UTC** (sufijo `Z`), no con `TZID`: así lo interpreta
  igual cualquier cliente sin depender de que traiga la definición de la zona.
  Chile cambia de huso dos veces al año, así que el offset se resuelve con
  `Intl` para la fecha concreta del evento (`wsOffsetMin`/`wsLocalAUTC`) — nunca
  con una constante. Si tocás esto, probá un evento de enero y uno de julio:
  10:30 tiene que dar 13:30Z y 14:30Z respectivamente.
- Avisos: al invitar se notifica a los **nuevos** participantes; a los que ya
  estaban solo si cambió el día o la hora. Re-notificar en cada edición
  convierte la campanita en ruido y se deja de mirar.

### Chat interno

- Un **canal** y un **mensaje directo** son la misma entidad con distinto
  `tipo` (`canal` / `dm`): un solo almacén de mensajes, un solo contador de no
  leídos, un solo buscador. Un DM se identifica por sus dos `miembros`
  ordenados, así abrirlo dos veces devuelve el mismo y no se duplica.
- **Lo leído** se guarda como una marca de tiempo por persona y canal
  (`lecturas[username][canalId]`), no como un flag por mensaje: es O(1) para
  escribir y no se rompe si alguien borra mensajes. La marca nunca va hacia
  atrás, así dos pestañas abiertas no se pisan.
- **Menciones**: el handle es la parte del correo antes de la arroba y se
  resuelve en `wsAsignarHandles()`, que viaja en el roster. El front escribe el
  mismo `@handle` que el server después parsea — si cambiás el criterio, tocá
  esa función y nada más. `@todos` avisa a todo el canal (en un DM se ignora).
- **Quién recibe aviso**: en un DM, el otro; en un canal, solo los mencionados.
  Notificar cada mensaje de cada canal haría que nadie mire la campanita.
- **El texto se escapa primero y se decora después** (links, menciones). Al
  revés deja pasar HTML del usuario. Hay un caso de prueba con
  `<img src=x onerror=...>` en la suite del chat.
- El sondeo pide solo lo nuevo (`?desde=<ts>`) cada 4 s, y únicamente con la
  pestaña Chat abierta y visible. Al llegar mensajes no se baja el scroll si la
  persona estaba leyendo hacia arriba, ni se pierde lo que venía escribiendo.
- Los mensajes se recortan a `WS_MSJ_MAX` por canal: `wsLoad()` relee el doc
  entero en cada request, así que no puede crecer sin techo.

### Metas personales

Objetivos del mes por persona (`d.metas`, clave `periodo` = `YYYY-MM`). Son
**privadas**: el filtro lo hace el server, no el front. Una meta ajena no se
puede editar ni borrar **ni siendo admin** — el dueño es el único, a propósito.

### Tareas automáticas (alertas del sistema)

`WS_AUTO_DETECTORES` es la lista de detectores. Cada uno devuelve "hallazgos"
con una **clave estable** y el espacio los convierte en tareas del proyecto
"Alertas del sistema", asignadas a la cuenta admin más antigua.

Tres reglas que hacen que esto no se vuelva insoportable — si tocás esto, no las
saques:

1. **Dedupe por clave, para siempre.** Si ya se creó la tarea de un hallazgo no
   se vuelve a crear, ni aunque la hayan completado. Una tarea que reaparece
   después de resolverla es la forma más rápida de que dejen de mirar el módulo.
2. **Techo de tareas ABIERTAS por detector** (`WS_AUTO_MAX_ABIERTAS`). El primer
   escaneo sobre datos viejos encuentra decenas de cosas; sin techo entierra el
   tablero. Lo que no entró se informa en `omitidos`/`topeAlcanzado` — un tope
   silencioso se lee como "no hay nada más".
3. **Un detector que falla no tumba el escaneo.** Se salta y los demás siguen,
   y el error viaja en la respuesta.

Los detectores leen **datos reales, nunca inventados**: si la fuente no está
disponible (Shopify caído), devuelven vacío en vez de fabricar alertas. El
criterio de cada detector va en una función pura aparte (ver
`wsAutoHallazgosCodigos`) para poder probarlo sin la API remota.

El umbral de costeo se compara contra el `margenPct` que el usuario le puso a
cada plato, más `WS_AUTO_COSTEO_HOLGURA` puntos de tolerancia. No hay un número
"de costo alto" inventado en el código: el objetivo lo define el usuario.

## Quién ve qué en el catálogo mayorista de Zorbo

La visibilidad **no se decide en este repo**: sale de Shopify.

- **Tag del cliente** (`mayoLevelFromTags`): `MAYORISTA` → ve todo el catálogo
  mayorista; `MAYORISTA1` → ve **solo** la colección `MAYORISTAS EX`
  (`MAYO_EX_COLLECTION`); sin tag → catálogo público, donde los barriles y
  bidones no aparecen. Si tiene los dos tags gana el restringido.
- **Producto** (`isMayoristaProduct`): cuenta como mayorista si tiene el tag
  `MAYORISTA`, o si el título **empieza** con "Barril "/"Bidon ", o si matchea
  `N pack … mayorista`. Un barril que se llame distinto y no tenga el tag no
  entra al catálogo mayorista y no lo ve nadie.
- Y siempre: el producto tiene que estar **ACTIVE**.

**No agregues excepciones por cliente en el código.** Sería una lista paralela
a la colección de Shopify y las dos se desincronizarían al primer cambio: para
que a un cliente le aparezca un producto, se toca Shopify (el tag del cliente o
la colección), no `server.js`.

Dos caches de 10 minutos tapan el resultado de ese cambio y hacen pensar que no
funcionó: `custLevelCache` (tags por email) y `mayoExCache` (la colección). Por
eso la ficha del cliente tiene **"Releer Shopify"**
(`POST /admin/customers/cache/refrescar`), que los limpia.

Para no adivinar por qué a alguien no le aparece algo, la ficha del cliente
mayorista (Comercial › Análisis de Datos › Analítica comercial) tiene
**"Qué ve este cliente en Zorbo"**: lista producto por producto con el motivo
concreto. El criterio está en `clienteVeProducto`, aparte y puro.

## Bot "Seba" — DMs de Instagram de Firulais

Módulo aislado al final de `server.js` (bloque `Bot "Seba"`) + la sección
"Bot Seba — Firulais" en Marketing. **No comparte nada con Zorbot** (`/chat`)
ni con el bot mayorista: lo único que reusa son las dos conexiones que ya
existían, el cliente de Anthropic y `loadProductsCache()` de Shopify.

Flujo: DM → `POST /webhooks/instagram` → se valida la firma → se guarda el
mensaje → una cola con pacing arma el prompt (cerebro + historial + catálogo) →
Claude → `graph.instagram.com/<v>/me/messages`.

- **No hay base de datos.** El pedido original hablaba de tablas; acá se sigue
  la convención del repo: `seba.json` (cerebro + versiones, lo escribe el panel)
  y `seba-chats.json` (conversaciones, envíos y `mid` vistos, lo escribe el bot).
  Están separados a propósito: guardar el cerebro no debe reescribir el
  historial, ni al revés. Los dos en `.gitignore`.
- **El token de Instagram vive fuera de `prompts/`** (`$DATA_DIR/seba-token.json`).
  Si estuviera adentro viajaría dentro del `.zip` de respaldo que se baja a
  Drive. Se renueva solo (una vez por día, si le quedan menos de 15) y el valor
  del env **gana** si cambia: así pegar un token nuevo en Railway siempre
  funciona.
- **La firma se valida sobre el cuerpo crudo.** Por eso hay un
  `express.raw()` acotado a `/webhooks/instagram` montado **antes** de
  `express.json()`, arriba de todo el archivo. Si alguien mueve ese `app.use`,
  el HMAC deja de dar y Meta queda desconectado sin ruido.
- **El modelo nunca escribe una URL.** Escribe `[[CARRITO:8]]`, `[[CARRITO:8:2]]`
  o `[[WEB]]` y el server los reemplaza (`sebaExpandirLinks`). Además
  `sebaSanearLinks` cambia por la web cualquier URL que no sea del checkout o de
  perrisima.cl — un link inventado en un DM se abre, no funciona, y se pierde
  la venta.
- **El dominio del carrito es configurable** (`cerebro.dominioCarrito`, campo en
  el panel). Se resuelve por prioridad: panel → `SEBA_CART_DOMAIN` →
  **dominio principal que declara Shopify** → `SHOPIFY_STORE_DOMAIN`. Vacío
  significa automático, y el automático es el principal de Shopify: el handle
  `.myshopify.com` se lee off-brand en un DM y Shopify redirige igual, así que
  usar el principal derecho ahorra el salto.
  El dominio va **por parámetro** a `sebaCartUrl`/`sebaExpandirLinks`/`sebaSanearLinks`,
  no por constante: si el saneo mirara un valor fijo, cambiar el dominio en el
  panel borraría el link que se acaba de armar.
  **Cuidado con qué dominio se elige.** `zorbo.cl` y `k-bros.cl` son ESTA app de
  Express, no Shopify: `GET /cart/<variante>:1` ahí da 404 (hay un test que lo
  comprueba, `t-dominio-real.mjs`). Solo sirve un dominio que apunte a Shopify.
  Por eso el panel tiene "Probar link", que pide un permalink real y mira dónde
  termina; el criterio está en `sebaVeredictoCarrito`, aparte y puro.
- **Nace apagado** (`cerebro.activo === false`). Recibe y guarda DMs, pero no
  contesta hasta que se prende desde el panel. Un bot que empieza a hablar solo
  el día del deploy es peor que uno que no existe.
- **Idempotencia**: Meta reintenta el webhook. Se dedupean los `mid` ya vistos y
  se ignoran los ecos (`message.is_echo`) — sin eso el bot se contesta a sí mismo.
- **Solo responde a lo que entra** y solo dentro de la ventana de 24h. Fuera de
  ella marca `conv.fueraDeVentana` y no manda nada: `human_agent` es Fase 2.
- **Cola con pacing**: techo de `SEBA_MAX_HORA` (200) por hora rodante, contado
  en el doc y no en memoria, así un redeploy no regala cupo de golpe; más
  `SEBA_GAP_MS` de respiro entre envíos.
- Las funciones puras (`sebaPackDe`, `sebaExpandirLinks`, `sebaSanearLinks`,
  `sebaCortar`, `sebaFirmaValida`, `sebaSystem`, `sebaEsperaMs`) están separadas
  justamente para poder probarlas sin Meta ni Shopify ni Anthropic.
- Los precios y variantes salen **siempre** de Shopify. Si Shopify no está, el
  prompt lo dice y le prohíbe a Seba inventar precios.
- Política de privacidad para el App Review: `public/firulais-privacidad.html`.
