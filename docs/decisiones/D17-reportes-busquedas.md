# D17 · Reportes agregados de búsquedas

**Fecha:** 25 de octubre de 2026  
**Afecta:** backend, app pasajero y panel de empresa.

## Decisión

Una búsqueda cuenta cuando el pasajero elige empresa y ruta en el selector y
abre esa ruta en el mapa. No se cuentan las reconexiones o suscripciones del
socket. Se guarda un contador agregado por ruta, hora local de Barranquilla y
celda opcional. Las horas se truncan en `America/Bogota`; UTC se convierte al
crear el agregado y al presentar los tramos horarios.

La app manda el centro de una celda de rejilla fija, con paso de 0,00135° de
latitud y 0,00137° de longitud (aproximadamente 150 m en Barranquilla). Los
centros son múltiplos de esos pasos desde cero. El servidor valida forma,
área de servicio y alineación; rechaza celdas inválidas con 400. Sin pin se
cuenta el total de ruta y hora, sin ubicación.

No se conserva IP, identificador de dispositivo, token ni coordenada exacta.
La IP solo forma parte temporal de la clave del limitador en memoria. El mapa
de calor solo muestra celdas con al menos cinco búsquedas (k=5). Cada sesión
de empresa consulta únicamente sus rutas. Los contadores se eliminan al pasar
13 meses.

El aviso legal para informar este tratamiento bajo Ley 1581 queda pendiente
de revisión con el abogado antes de publicar la función.
