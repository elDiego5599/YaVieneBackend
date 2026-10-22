# D16 · El backend oculta al pasajero los buses quietos en terminal

**Fecha:** 21 de octubre de 2026  
**Afecta:** backend, app pasajero y panel de empresa.

## Decisión

Un bus en espera sigue conectado al MQTT y reporta su GPS en el terminal. El
backend decide su visibilidad con la posición y el movimiento; no se deja esa
regla a los simuladores ni a la app. El pasajero no recibe buses ocultos por
REST, socket o FCM. La empresa conserva el bus y sus posiciones en el panel.
`enTerminal` distingue el ocultamiento automático del apagado manual.

La política entra al ocultar con un radio de 100 m, confirma la llegada con
dos muestras quietas separadas por al menos 1 s y permite la salida al superar
el radio de salida de 120 m con progreso creciente. La ubicación actual se contrasta con
los extremos de la geometría y no con cualquier punto cercano del recorrido.
La visibilidad se conserva en `buses.visible`; al reiniciar, la primera
posición reconstruye el estado desde la posición y el movimiento. La demo
mantiene los cuatro buses en espera conectados y reportando en el terminal.

Si falta ruta, terminal o geometría utilizable, el modo automático falla
abierto y conserva el bus visible: no hay evidencia para ocultarlo con
seguridad. Un cambio de ruta descarta las muestras de la ruta anterior. La
caducidad de posiciones sigue siendo la autoridad para GPS perdido. Al volver
a mostrar un bus desde el panel, el backend descarta el estado automático
anterior para no dejarlo atascado en el relevo de salida.

## Por qué

La espera es parte del servicio y no una desconexión. Ocultar en el servidor
mantiene coherentes el mapa, el endpoint individual y los avisos push; el
panel sigue siendo una herramienta de operación de la empresa.

## Contrato

Se agrega `enTerminal` a los objetos de flota REST y socket, y al evento
`bus:hidden` recibido por el panel. El evento del pasajero conserva su forma.
La app debe tratar `bus:hidden` como bus que ya no está y dejar de disparar su
aviso. Sincronizar los fixtures con `npm run contrato:actualizar` y después
`tool/sincronizar-contrato.sh` en la app.

## Aclaración del algoritmo · 21 de octubre de 2026

La fracción se calcula proyectando cada posición sobre los segmentos
ordenados de la geometría, con continuidad respecto a la fracción anterior.
Una llegada solo se confirma en el último 5 % del recorrido, dentro del radio
de 100 m y quieto durante dos muestras separadas por 1 s. La espera inicial
se reconoce en el primer 10 % con las mismas condiciones. La salida exige
progreso desde el punto donde se ocultó y superar 120 m. Así, una parada
cercana al terminal en mitad de ruta no se oculta, incluso si inicio y fin
comparten coordenadas: el módulo usa el progreso continuo para elegir entre
ambas proyecciones. La fracción queda guardada en la última posición para reconstruirse tras
reiniciar el servidor; las migraciones 31 y 32 la incorporan, y la 33 guarda
el indicador de terminal que consume el panel.

## Ajuste de salida · 21 de octubre de 2026

Se fija el radio de salida en 120 m y se requieren dos publicaciones
consecutivas con progreso creciente. Este ajuste sustituye los 180 m de la
aclaración anterior: un punto GPS aislado fuera del terminal no reactiva el
bus y el relevo no espera una distancia larga.

La fracción y el sentido efectivo de la ruta persisten en `positions` para
resolver el mismo punto de una ruta circular tras reinicio; los guarda el
esquema local en las migraciones 31 y 32.

Sin ruta asignada no existe una sala donde publicar: la ingesta no crea una
posición para pasajeros y el panel conserva el bus. Para una ruta asignada
sin geometría utilizable, sí aplica el fallo abierto y queda visible hasta
corregir el catálogo.

Esta precisión reemplaza la primera redacción basada solo en distancia a los
extremos: la distancia se mide al extremo que corresponde a la fracción y el
sentido actuales, y nunca basta sin map matching sobre la ruta.

Cuando el equipo omite `sentido`, el backend lo infiere de la fracción entre
posiciones aceptadas y conserva ese rumbo efectivo. Sin evidencia suficiente
mantiene el bus visible.
