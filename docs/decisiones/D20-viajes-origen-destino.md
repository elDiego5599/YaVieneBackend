# D20 · Los viajes buscados, de una zona a otra

**Fecha:** 14 de noviembre de 2026  
**Afecta:** backend, panel de empresa y app pasajero (la conecta Fable).

## Decisión

Cuando el pasajero toca «Ir» en el planificador, la app manda un viaje
buscado: la zona de origen, la zona de destino y las rutas del plan
(`POST /api/viajes`). El panel lo llama «Viajes buscados»: es intención, no
viajes hechos. La empresa ve los pares de zonas cuyo plan usa alguna de sus
rutas (`GET /api/panel/viajes`, con la sesión de empresa), como líneas de
deseo entre centros de zona y una matriz de las diez zonas que más salen.

Lo que se guarda (`viajes_od`, `src/data/viajes_od.ts`) es solo un contador
por franja, par de zonas y empresa. Nada de cuenta (D3), IP, dispositivo ni
hora exacta.

- **Zona:** un bloque de 4 × 4 celdas de D17 (unos 600 m), con el centro en
  múltiplos de `4 * PASO` desde 0 (`centroZona`). La app manda el centro; el
  servidor comprueba que sea finito, de la zona de servicio y de la rejilla
  (tolerancia 1e-7) y rechaza con 400 lo que no lo sea. Origen y destino en
  la misma zona tampoco cuentan.
- **Hora:** la pone el servidor, en franjas de 3 horas de Bogotá (0 a 7). La
  app no manda hora y mandarla es un error.
- **Empresa:** sale del backend, nunca de la app. Cada ruta del plan (una o
  dos, distintas, de hasta 64 caracteres) debe existir y ser de una sola
  empresa; cada empresa del plan suma una vez, aunque aporte dos rutas.
- **Cuerpo:** solo `origen`, `destino` y `rutas`, de hasta 1 KB; una clave
  de más es 400.

## Privacidad: k ≥ 5

El umbral va por cubeta (día de Bogotá, par de zonas y empresa), después de
filtrar franja y días, y el panel suma los días que lo pasan (AUD29-01, como
D17): dos rangos solapados no se restan para ver un día con menos de 5. Un
par con 2 viajes un día y 3 otro no sale; es el precio. Se devuelven a lo
más los 200 pares más fuertes. La empresa solo ve lo suyo.

Límite conocido, igual que en D17: dos consultas del mismo día, una de todas
las franjas y otra de una sola, pueden dejar ver la diferencia entre
franjas de un par que pasó el umbral ese día.

## Abuso (AUD29-07)

Un POST anónimo puede inflar los datos. Defensas: un limitador por IP de 30
viajes cada 10 minutos (`viajesRateLimiter`, solo en memoria; la IP no se
guarda) y un tope de 20.000 filas nuevas por día de Bogotá, pasado el cual
las nuevas responden 503 `LIMITE_DIARIO` y solo se suma a filas que ya
existen. Inflar un par sigue siendo posible para quien cambie de IP: por eso
el panel dice «buscados» y no «hechos».

## Retención

13 meses, como D17 y D18 (`limpiarViajes`, una vez al día).

## Pendiente

El aviso legal (Ley 1581) va con el abogado antes de publicar, igual que
D17. Falta que la app mande el viaje al tocar «Ir» (Fable): el contrato está
en `tests/fixtures/contrato/rest-viaje-registrado.json` y
`rest-panel-viajes.json`.
