# D14 · El buzón del pasajero llega al correo del equipo, por el backend

- **Decidida**: 2026-10-02. **Toca**: `YaVieneBackend`, `app_pasajero`.
- **Estado**: decidida, falta la contraseña de aplicación del dueño.

## La pregunta

El pasajero no tenía por dónde decir que algo falla o proponer algo. ¿El
reporte abre el correo del teléfono, o lo recibe el backend y lo manda él?

## Lo decidido

**Formulario en la app y endpoint propio** (`POST /api/reportes`). El
backend guarda el reporte en una cola (`reportes`) y cada 30 s manda los
pendientes al Gmail del equipo por SMTP, con una contraseña de aplicación.
Cuando el correo sale, la fila se borra.

## Por qué

- Abrir el correo del teléfono deja la dirección del equipo dentro de la
  APK, a la vista de cualquiera, y falla en el teléfono que no tiene una
  cuenta de correo configurada, que entre pasajeros de bus es lo común.
- D7 eligió WhatsApp para el contacto de empresas porque un endpoint es «un
  sistema entero para un puñado de mensajes». Aquí el backend ya existe, ya
  tiene limitador por IP y ya habla con un servicio de fuera (FCM, D13): lo
  nuevo es una tabla, una ruta y un reloj.
- Guardar antes de mandar hace que un Gmail caído o una contraseña mal
  puesta no pierdan reportes: esperan con una espera creciente (1 min, 2,
  4… hasta 6 h) y salen cuando se arregla.

## Lo que no se hizo, a propósito

- **Ningún campo de contacto** (ni nombre, ni correo, ni teléfono). Con la
  Ley 1581, pedir un dato personal obliga a una autorización y a responder
  por él. La app le pide al pasajero no escribir datos personales en el
  texto; si los escribe, salen en el correo y no se guardan en la base
  después de enviados.
- **Ningún SDK de correo**: SMTP a mano sobre `node:tls`, como el push va
  sin el SDK de Firebase. Una dependencia menos para `npm audit`.
- **Nada del pasajero en las cabeceras**: el asunto es fijo y el texto va en
  base64 en el cuerpo, así que no hay inyección de cabeceras posible.

## Lo que se hizo

`src/buzon/correo.ts` (el SMTP), `src/data/reportes.ts` (validación, cola y
envío), la migración 26, `reportesRateLimiter` (5 cada 10 min por IP),
`validateConfig` y `tests/buzon.test.ts` contra un SMTP falso. Encenderlo:
[runbook](../runbook.md), «Buzón de problemas y sugerencias».
