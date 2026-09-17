# Handoff — Gastos-App: cuotas y ciclos de tarjeta

Contexto para quien siga este trabajo. Escrito al final de una sesión larga.
Fecha de referencia de todo lo que sigue: **17/09/2026**.

---

## 1. Estado del repo

- Rama de trabajo: `claude/savings-fund-balance-8aaclp`
- `main` está en `bf6c483` (merge del PR #53).
- **PR #54 está ABIERTO y sin mergear**, con 3 commits:

| Commit | Qué hace |
|---|---|
| `cfe3d0c` | Cuotas: no inventar un cierre en ciclos irregulares |
| `f29f7d7` | Cuotas: contar contra el historial de cierres reales |
| `ffc56f7` | Vencimiento: guardar la fecha real y no deducir el mes |

**Ojo con esto:** el usuario corre la app en Vercel desde `main`, pero un
diagnóstico en su consola devolvió `VERSION: con historial`, que solo existe en
`f29f7d7`. O sea que está mirando un build de la rama (probablemente un preview
de Vercel), no `main`. Confirmarlo antes de diagnosticar cualquier cosa: ya
perdimos un par de vueltas por diferencias entre lo desplegado y lo commiteado.

### Tests

15 tests, todos pasan. El navegador del entorno no coincide con la versión de
`@playwright/test`, así que hay que pasarle la ruta:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test
```

`tests/ciclos.spec.js` compara la lógica de `app.html` contra la copia del bot
(`supabase/functions/whatsapp-webhook/ciclos.js`) sobre ~120 casos. **Son dos
copias literales de las mismas funciones**: si tocás una y no la otra, ese test
salta. Es la red contra el problema recurrente de este código (ver §4).

---

## 2. Bugs encontrados y arreglados en el PR #54

### 2.1 Cierre fantasma en ciclos irregulares (`cfe3d0c`)

El ciclo vigente tiene dos fechas conocidas: el cierre anterior (día previo a
`cicloInicio`) y el cierre actual (`cicloCierre`). Entre ellas puede haber un
salto que no es de un mes — ej. 27/8 → 1/10. La cuenta de cuotas armaba la
secuencia sumando meses desde el 27 e **inventaba un cierre el 27/9** que nunca
existió.

Efecto: la misma compra daba cuota 6 mirada desde hoy y cuota 7 mirada desde el
cierre, así que el dashboard la contaba y Proyección la descartaba. Eran
exactamente **$38.333** de diferencia entre el total del dashboard ($1.066.615)
y el "pago real" de Proyección ($1.027.818).

Fix: `siguienteCierre(cfg, c)` — si `c` es un cierre real conocido, el siguiente
es el próximo cierre real, no "un mes después".

### 2.2 Historial de cierres (`f29f7d7`)

El cierre de la tarjeta **es variable** (el banco lo corre por fines de semana y
feriados) y el usuario lo confirma a mano cada ciclo. Pero la app guardaba solo
el ciclo vigente, así que para las compras anteriores retrocedía mes a mes
suponiendo un día fijo.

Fix: cada cierre confirmado se archiva en `cierres[tarjetaId].historial` (array
de ISO). `cierresConocidos(cfg)` devuelve historial + `cicloInicio - 1` +
`cicloCierre`, ordenados. Se agregó en el modal de cierres un bloque **"Cierres
anteriores"** para cargar a mano los que la app nunca vio.

Es un campo nuevo dentro del JSONB `config.cierres`, retrocompatible: **no hace
falta migración**.

Limitación conocida: para compras anteriores al historial sigue siendo una
estimación. No hay forma de saber cuánto se corrió el cierre en meses que nunca
se registraron. Mejora sola a medida que se acumula historial.

### 2.3 Deriva de febrero (`f29f7d7`)

Lo encontró el test, no yo. Un cierre del 29 cae en el 28 en febrero, y al
seguir contando desde ese 28 la secuencia quedaba corrida (`28/3, 28/4, 28/5…`),
nunca volvía a coincidir con los cierres del historial y el salto al cierre real
no se disparaba. El día hay que tomarlo siempre del ancla, nunca de
`c.getDate()`.

### 2.4 `cuotasEnCiclo` calculaba su propia ventana (`f29f7d7`)

La lista "Cuotas en curso" de Proyección armaba su fecha de referencia por su
cuenta (`día N de ese mes`) en vez de usar `cicloQuePagasEn`, que es la que usa
el monto. En una tarjeta que cierra el 27 y vence el 8 del mes siguiente,
listaba las cuotas de un ciclo y cobraba las de otro. Ahora usan la misma
ventana.

### 2.5 El mes del vencimiento se deducía (`ffc56f7`)

`vencimiento` se guardaba como día del mes y el mes se deducía agarrando el
primer día N en o después del cierre. Con un cierre a principio de mes eso es
ambiguo: una tarjeta que cierra el 1/10 y "vence el 4" puede vencer el 4/10
(tres días) o el 4/11 (treinta y cuatro).

Ahora se guarda `cicloVencimiento` (fecha completa) y de ahí sale la distancia
en meses, que se aplica a los demás ciclos. Sin ese dato se mantiene el
comportamiento viejo, así que las configs ya cargadas siguen andando.

---

## 3. Dónde quedó trabado

**El código está verificado; lo que falta son datos que solo tiene el usuario, y
las expectativas que dio son mutuamente inconsistentes.**

### 3.1 Los datos de la tarjeta "Credito Visa Galicia"

Config actual en producción:

```json
{"dia":1,"limite":1100000,"cambiadoEl":"2026-09-04","cicloCierre":"2026-10-01",
 "cicloInicio":"2026-08-28","diaAnterior":29,"vencimiento":4}
```

Sin `historial`. `cicloInicio: 2026-08-28` con `cicloCierre: 2026-10-01` es un
ciclo de **cinco semanas**, que es lo que descoloca todo lo de abajo.

Gastos en cuotas de esa tarjeta (sacados de la consola del usuario):

| Gasto | Compra | Cuotas |
|---|---|---|
| estereo | 2026-09-08 | 6 |
| Distribución | 2026-08-29 | 3 |
| Cafetera | 2026-05-11 | 6 |
| Taladro | 2026-04-13 | 6 |
| Celu | 2026-01-21 | 12 |
| Auriculares | 2026-05-07 | 3 (terminado) |
| Mesa | 2026-05-03 | 3 (terminado) |
| Perfumes | 2025-07-17 | 12 (terminado) |

### 3.2 Lo que muestra hoy vs. lo que espera el usuario

Proyección de octubre (ciclo 28/8 → 1/10, vence 4/10):

| Gasto | Muestra | Espera | ¿Coincide? |
|---|---|---|---|
| Taladro | 6/6, termina | termina | sí |
| Cafetera | 5/6 | — | — |
| Celu | 9/12 | — | — |
| **Distribución** | **1/3** | **2/3** | **no** |
| **estereo** | **1/6** | **2/6** | **imposible** |

### 3.3 Las tres incógnitas que bloquean

**(a) ¿Cuándo cerró realmente la tarjeta en septiembre?**

La app cree que el ciclo anterior cerró el **27/8** (lo deduce de
`cicloInicio: 28/8`). Para que Distribución (29/8) sea cuota 2 en octubre, tiene
que haber existido un cierre entre el 29/8 y el 1/10.

Verifiqué que corrigiendo `cicloInicio` a `2026-09-02` (o sea, cierre anterior
el 1/9) Distribución pasa a 2/3 y **nada más se mueve**:

```
AHORA (inicio 28/8) — cierres conocidos: 2026-08-27, 2026-10-01
   estereo 1/6 · Distribución 1/3 · Cafetera 5/6 · Taladro 6/6 · Celu 9/12
CON EL CIERRE DE SEPT (inicio 2/9) — cierres conocidos: 2026-09-01, 2026-10-01
   estereo 1/6 · Distribución 2/3 · Cafetera 5/6 · Taladro 6/6 · Celu 9/12
```

El 1/9 lo **inferí** de que el 4/9 el usuario cambió el día de cierre a 1
(`cambiadoEl: 2026-09-04`). Nunca lo confirmó. La fecha está en su resumen.

**(b) ¿El resumen que cierra el 1/10 vence el 4/10 o el 4/11?**

De esto depende en qué mes Proyección lo cobra. Nunca lo confirmó.

**(c) El estéreo no puede ser cuota 2 en octubre.**

Comprado el 8/9, cae dentro del ciclo que cierra el 1/10 con **cualquier**
configuración: su primera cuota es la de octubre. Para que fuera la 2ª tendría
que haber habido un cierre entre el 8/9 y hoy (17/9). Se lo planteé dos veces y
no hubo respuesta. Puede ser que haya querido decir noviembre, o que el estéreo
sea de agosto.

**Esta inconsistencia es la que traba todo:** (a) pide correr los ciclos para
atrás (que exista un cierre en septiembre) y (c) pide correrlos para adelante
(que exista otro después del 8/9). Las dos juntas no cierran con ninguna
secuencia de cierres coherente. Hasta no resolverla, cualquier cambio arregla un
número y rompe otro.

### 3.4 Decisión de diseño pendiente

El usuario dijo textual: *"no debería tomar el vencimiento, sino el cierre"*.

Es una llamada suya y hay que respetarla, pero hay que decirle la consecuencia
antes de aplicarla, porque **en la Visa Galicia no cambia nada**: cierra el 1/10
y la app la da por vencida el 4/10, mismo mes, así que "el ciclo que cierra en
octubre" y "el ciclo que vence en octubre" son el mismo. Donde sí cambia es en
la ICBC Master (cierra 27, vence 8 del mes siguiente):

| Regla | Proyección de octubre muestra |
|---|---|
| Por vencimiento (actual) | el resumen que cerró el 27/9, que paga el 8/10 |
| Por cierre | el que cierra el 27/10, que paga el 8/11 |

El fondo: si Proyección es "la plata que sale este mes" corresponde el
vencimiento; si es "lo que consumí este mes", el cierre. Hoy está con el primer
criterio porque Proyección simula cuánta plata queda. **No aplicado, esperando
confirmación.**

### 3.5 Limitaciones del entorno (por qué no pude verificar solo)

- **Supabase MCP apunta a otro proyecto.** El único proyecto accesible
  (`ejuryuiklgauxongecrh`, "enviondo") tiene tablas de aeronaves e instructores.
  No hay `gastos` ni `tarjetas`. No pude leer los datos reales.
- **Sin salida de red a Vercel.** `curl` a `gastos-app-gray.vercel.app` da
  `connect_rejected` por política del proxy. No pude ver qué build está sirviendo.

Por eso todo el diagnóstico se hizo con snippets que el usuario pegaba en la
consola del navegador. Funciona bien y conviene seguir así.

---

## 4. Contexto que conviene saber

**El problema recurrente de este código es la misma cuenta implementada en
varios lugares divergiendo en silencio.** Mordió cuatro veces: el total de
tarjeta, los gastos de pago único, los débitos de suscripciones y la ventana de
`cuotasEnCiclo`. Mitigaciones: `cicloActual` como fuente única, el módulo
compartido `ciclos.js` y `tests/ciclos.spec.js`. Antes de agregar una cuenta
nueva, buscar si ya existe.

**Metodología que funcionó:** dejar de teorizar, pedir datos reales por consola,
reproducir en un test y recién ahí arreglar. Los dos fixes nuevos los validé
revirtiendo el código a propósito para confirmar que el test los agarra. Vale la
pena seguir haciéndolo.

**Restricciones:**
- El usuario pegó su login en el chat. **No usar esa contraseña.** Ya se le
  recomendó cambiarla.
- Los secretos (token de WhatsApp, API key de Gemini) van por
  `supabase secrets set`, nunca al repo.
- Escribir en español rioplatense.

---

## 5. Pendientes

Del hilo de cuotas:

1. Confirmar con el usuario las tres incógnitas de §3.3.
2. Aplicar (o no) el cambio de §3.4.
3. Mergear el PR #54.

De antes, ofrecidos y no empezados:

- Bot: corregir o borrar el último gasto ("no, eran 700" / "borrá el último").
  Era la recomendación principal.
- Bot: agregar el teléfono de la madre.
- Bot: soporte de fotos de tickets.
- Borrar dos gastos sueltos del bot (coto, Carrefour) que quedaron en la cuenta
  de la madre.
- App: notificación push del vencimiento; cargar gastos en la cuenta de la madre
  sin desloguearse; vista de cuotas viejas ajustadas por inflación.
- Integridad de datos, **no aceptado todavía pero real**: 22 de 36 escrituras a
  la base no chequean el error que devuelve Supabase, así que un fallo se pierde
  en silencio. Y `today()` en `app.html` usa UTC, así que un gasto cargado de
  noche queda con la fecha del día siguiente.
- Cosmético: `<meta name="apple-mobile-web-app-capable">` está deprecado, y falta
  `favicon.ico` (404 en cada carga).
