# D26. El historial de posiciones se mide, se exporta y se consolida antes de borrarse

**Fecha:** 23 de noviembre de 2026  
**Afecta:** backend; el panel de empresa lo consume (exportar CSV).

## Decisión

Los datos se usan, no solo se ven. El backend guarda el recorrido de los
buses, lo mide por ruta y lo resume antes de que la retención lo borre.

**Historial de posiciones** (`src/data/historial.ts`). `positions` guarda
solo la última posición de cada bus; `posiciones_historial` guarda el
recorrido, con una muestra cada 30 s por bus (la flota de ejemplo publica
cada 0,4 a 1,5 s: sin muestrear serían decenas de millones de filas al día).
Lo crudo dura **7 días**.

**Indicadores por ruta** (`src/data/indicadores.ts`,
`GET /api/panel/indicadores/:routeId`, con la sesión de empresa, solo de
sus rutas). Por hora: buses promedio, velocidad promedio en marcha (los
buses bajo 3 km/h están parados y no cuentan) e intervalo entre buses
(mediana y p90) medido en la mitad de la ruta, por sentido. Una pausa de más
de dos horas es fin de turno, no un intervalo. La flota de ejemplo va
marcada `simulado` y no se mezcla (D8).

**Exportar CSV** (`?formato=csv`, y «Exportar CSV» en Reportes del panel).
Una fila por hora, cabeceras en ASCII, saltos `\r\n`. El separador es la
**coma** y el decimal el **punto** (RFC 4180), tal como lo arma
`indicadoresCsv`. Se eligió el estándar para que lo lea sin adivinar
cualquier herramienta de análisis (Python, R, Google Sheets). **Límite
conocido:** un Excel configurado en español de Colombia espera `;` como
separador de lista y la coma como decimal, así que al abrir el archivo con
doble clic puede dejar todo en una sola columna. Se abre bien con «Datos,
Desde texto/CSV». Si el dueño prefiere abrirlo directo en Excel, la salida
es `;` con decimal coma (o una BOM y `sep=;`); no está decidido.

**Consolidación** (`src/data/consolidacion.ts`). Antes de que la retención
borre lo crudo, cada día cerrado de Barranquilla (medianoche a medianoche,
UTC-5 todo el año) se resume:

- `servicio_horario`: por empresa, ruta, día, hora y `simulado`, los buses
  distintos, las muestras y la velocidad media en marcha. Dura más que lo
  crudo y es de lo que se podrán sacar tendencias de semanas y meses.
- `calidad_historial`: una fila por día con cuántas muestras hubo, cuántas
  pasaron los controles y cuántas no, por causa.

**Controles de calidad.** Una muestra es válida si está dentro de la zona de
servicio (`ZONA`), a una velocidad entre 0 y `MAX_SPEED_KMH`, con
`captured_at` no más de `MAX_CAPTURE_CLOCK_SKEW_MS` por delante de su
llegada, y llegada no más de `MAX_PAST_CAPTURE_MS` tarde. Son los mismos
límites del ingreso (se importan, no se copian). Solo las válidas entran al
resumen. Las que no, se cuentan en una sola causa, en este orden:
`fuera_de_rango`, `reloj_adelantado`, `llegada_tardia`. Aparte,
`sin_posicion_en_ruta` cuenta válidas sin `fraccion_ruta`: siguen en el
resumen (cuentan como buses y velocidad) pero no sirven para intervalos.

**Cuándo corre.** `consolidarPendientes()` al arrancar y cada 24 h,
**antes** de `limpiarHistorial()` y en la misma vuelta: si consolidar falla,
la limpieza no corre y se reintenta con lo crudo entero. Un día se
consolida cuando pasó su medianoche más `MAX_PAST_CAPTURE_MS` (para esperar
las muestras con reloj atrasado) y solo si su crudo sigue entero. Repetir un
día da lo mismo.

## Por qué

Una empresa de buses decide con lo que pasó, no con lo que pasa. Guardar
todo crudo para siempre cuesta disco y no sirve; resumir sin controles
mezclaría un equipo con el reloj mal o un bus en Bogotá con lo que la
empresa va a leer como verdad. Contar lo que se descartó, por causa, deja ver
cuándo un equipo empieza a fallar. Los límites vienen del ingreso para que
no haya dos definiciones de «posible».

## Lo que no cubre

- **Más de 7 días.** Los indicadores (intervalos, horas pico) se calculan de
  lo crudo; pasada la semana solo queda `servicio_horario`, que no guarda
  intervalos. Los indicadores de periodos largos están por hacer.
- **Un día que la retención ya empezó a borrar** (el backend estuvo apagado
  más de una semana) no se consolida: un resumen parcial pasaría por entero.
- **Datos personales.** Las muestras son de buses, no de personas; ni el
  historial ni el resumen guardan pasajeros.
- **Excel directo.** Ver el límite del separador, arriba.
