# D15 · La lista de «Avísame cuando salga» la guarda el backend

- **Decidida**: 2026-10-14. **Toca**: `YaVieneBackend`, `YaVieneWeb`.
- **Estado**: decidida; falta poner el origen de la web en `WEB_ORIGINS`
  cuando la web se publique.

## La pregunta

El hero de la web pide un celular para avisar cuando la app salga. Hasta
hoy abría WhatsApp con el número escrito: si la persona no le daba a
enviar no llegaba nada, y lo que llegaba quedaba suelto entre chats, sin
lista ni fecha del permiso. ¿Dónde se guarda?

## Lo decidido

**En el backend, en su propia tabla** (`lanzamiento`), por
`POST /api/lanzamiento`. Se guarda el celular normalizado (cifras con su
indicativo; un celular colombiano de 10 cifras gana el 57), cuándo se
aceptó y la versión del texto aceptado (`VERSION_AUTORIZACION`). El equipo
la lee con `GET /api/admin/lanzamiento`, borra un número a pedido de su
dueño con `DELETE /api/admin/lanzamiento/:telefono` y la vacía entera con
`DELETE /api/admin/lanzamiento` tras avisar del lanzamiento. Las tres van
con `ADMIN_API_KEY`.

## Por qué

- Igual que en el buzón ([D14](D14-buzon.md)), el backend ya existe y ya
  tiene limitador por IP: lo nuevo es una tabla y cuatro rutas.
- Con la Ley 1581 el permiso tiene que poder probarse: la fila guarda
  cuándo se dio y sobre qué texto.
- Un servicio de listas de terceros sumaba un encargado del tratamiento
  más que declarar y otra cuenta que cuidar.

## Cómo se protege

- **Solo el número**: ni nombre, ni IP, ni de qué página vino. Lo que el
  cuerpo traiga de más se ignora.
- **El permiso es obligatorio**: sin `acepto: true` es 400 y no se guarda.
- **Sin delatar**: un número repetido responde igual que uno nuevo, así
  que la ruta no sirve para saber quién está en la lista.
- **Topes**: 5 cada 10 minutos por IP (`lanzamientoRateLimiter`) y
  20.000 filas (`MAX_LANZAMIENTO`); llena, 503.
- **Sin logs**: los números no se escriben en ningún log ni métrica; solo
  se cuentan (`lanzamiento.recibidos`, `lanzamiento.lleno`).
- **CORS aparte**: la landing no entra en `CORS_ORIGINS`, que es la lista
  del panel y da su sesión. Va en `WEB_ORIGINS`, que solo abre
  `/api/lanzamiento` y sin credenciales. La cabecera
  `ngrok-skip-browser-warning` queda permitida: sin ella, ngrok le
  contesta al fetch de un navegador con su página de aviso en HTML.

## Lo que no se hizo, a propósito

- **Ningún borrado sin el equipo**: la persona pide el borrado por correo o
  por WhatsApp (privacidad, «Tus derechos»). Una ruta pública de borrado
  dejaría a cualquiera sacar el número de otro.
- **Ninguna confirmación por SMS o WhatsApp**: costaría un proveedor de
  mensajes por un aviso que se manda una sola vez.

## Lo que se hizo

`src/data/lanzamiento.ts`, la migración 30, las rutas en `api/routes.ts`,
`WEB_ORIGINS` en `config.ts` (revisado como `CORS_ORIGINS`) e `index.ts`,
y `tests/lanzamiento.test.ts` con `tests/cors.test.ts`. En la web,
`src/aviso-lanzamiento.ts` manda el número aquí. Leer, borrar y encender:
[runbook](../runbook.md), «La lista de Avísame cuando salga».
