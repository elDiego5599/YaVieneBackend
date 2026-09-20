# D6 · El código de ruta es único en todo el sistema

- **Decidida**: 2026-09-12. **Toca**: backend, apps.
- **Estado**: vigente.

## La pregunta

Cuando haya dos empresas, ¿pueden las dos tener una ruta que se llame
`R-101`? Es decir: ¿la ruta se identifica sola, o hace falta decir de qué
empresa es?

## Lo decidido

**`route_id` único en todo el sistema**, con índice único y autonumeración
global. Dos empresas no pueden repetir código.

## Por qué no la llave compuesta

La alternativa —identificar una ruta por empresa **más** código— es correcta
y es lo que haría un sistema grande. También toca todo: cada endpoint REST,
cada evento del socket, el nombre de cada sala (`route:<routeId>`) y las dos
apps. Y el pasajero, que es quien más rutas mira, **no sabe ni quiere saber
de qué empresa es su bus**: para él la ruta es la ruta.

El costo de la unicidad es que la empresa no escoge el código de su ruta, se
lo dan. A cambio, una ruta se nombra con una sola cadena en todo el sistema.

## Lo que se hizo

T1.5 tal como está escrita: índice único y autonumeración numérica global.
