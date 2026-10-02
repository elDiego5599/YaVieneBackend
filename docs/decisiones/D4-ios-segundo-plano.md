# D4 · En iPhone el aviso solo suena con la app abierta, y se dice

- **Decidida**: 2026-09-12. **Toca**: `app_pasajero`, web.
- **Estado**: vigente.

## La pregunta

En iOS la app solo declara permiso de ubicación «mientras se usa» y no
declara modos de segundo plano: el aviso de «tu bus está cerca» **solo suena
con la app abierta**. ¿Se arregla, se dice, o se deja iOS fuera del piloto?

## Lo decidido

**Decirlo claro y seguir en Android e iPhone.** Texto honesto en la app —solo
en iOS— y en la web. El piloto incluye iPhone con esa limitación escrita.

## Por qué no las otras

- **Notificaciones push desde el servidor** lo arreglaría, pero obliga a
  mandar al backend el punto donde el usuario quiere que le avisen. Eso
  **contradice `privacidad.html`**, que promete dos cosas: «Tu ubicación no
  sale del teléfono» y «El aviso lo calcula tu propio teléfono». Habría que
  reescribir la promesa, y esa promesa es parte de lo que se está ofreciendo.
- **Dejar iOS fuera del piloto** evita explicar nada, a cambio de perder la
  mitad de los teléfonos. Una limitación dicha cuesta menos que media ciudad
  sin app.

## Lo que se hizo

T5.4 rama a): el texto en la app y en la web. La matriz de pruebas de T5.8
cubre el caso. Sin push.

## Lo que cambió (2026-10-02)

En Android el push del servidor sí se hizo: [D13](D13-avisos-push.md). La
promesa de privacidad se reescribió para decir que, con un aviso armado, el
punto de espera va al servidor. En iPhone esto sigue igual hasta que haya
cuenta de desarrollador de Apple: sin ella no hay clave de APNs.
