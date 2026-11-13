# D23. La recarga se entrega al operador o al banco

**Fecha:** 12 de noviembre de 2026 (cerrada el 13)  
**Afecta:** app pasajero (el backend no recibe nada).

## Decisión

Ya Viene nunca procesa un pago ni toca dinero. «Recargar» abre, con el
navegador del teléfono (`url_launcher`, aplicación externa), la página del
operador o del banco con una referencia opaca: 16 a 64 caracteres
`[A-Za-z0-9_-]`, al azar, sin el número de la tarjeta, ni cifras de ella,
en la URL. No hay WebView con un formulario de pago dentro de la app.

La persona vuelve por `yaviene://recarga?referencia=...&estado=...`. Ese
enlace es entrada hostil: solo se lee la referencia y el `estado` que traiga
se descarta. El estado se le pregunta al proveedor con esa referencia; hasta
que conteste, la pantalla dice «Pendiente». La app nunca ve un número de
tarjeta bancaria ni de cuenta, ni más monto que el que diga el proveedor.

Hoy el único proveedor es `RecargaSimulada`, detrás de la interfaz
`ProveedorRecarga` (que nunca lanza), contra `tool/pasarela_simulada.py`.
Mientras sea simulado, la pantalla lleva la etiqueta «Simulación» (D8), como
el saldo (D22).

## Por qué

Un pago dentro de la app pide PCI, cuentas y soporte que Ya Viene no tiene ni
quiere (D3). Entregar el pago a quien ya lo cobra deja a la app solo leyendo
el resultado, y no confiar en el enlace de vuelta impide que otra app o una
página acredite una recarga que no pasó.

## Amenazas y lo que las cubre

- **Enlace de vuelta basura** (host, esquema, referencia mal formada o
  enorme): `ReferenciaRecarga.leer` lo descarta y no hay consulta. iOS solo
  entrega al Dart los `yaviene://recarga` de hasta 512 caracteres.
- **Referencia ajena:** solo vale la de la recarga en curso; otra no cambia
  nada ni consulta.
- **Enlace repetido:** la referencia vale una vez; al llegar a un estado
  final (aprobada, rechazada, desconocida) se borra y el segundo enlace no
  consulta. Caduca a los 30 minutos.
- **El enlace dice «aprobada» y el proveedor «rechazada»:** gana el
  proveedor; el `estado` del enlace no se lee.
- **Sin red al volver:** «Sin conexión» con «Comprobar»; la referencia se
  conserva. Si el proveedor no contesta o contesta raro, sigue «Pendiente».
- **Páginas de pago:** solo se abre lo que cumple la lista de permitidos
  (`PaginasDePago`: esquema, host y puerto exactos, sin usuario en la URL);
  la pasarela simulada solo permite su propio origen.
- **Divulgación:** `ReferenciaRecarga.toString` y los logs dicen solo los
  primeros 4 caracteres; la URL no lleva el número de la tarjeta; la
  pasarela simulada tampoco lo recibe.
- **Pisar otro aviso:** iOS guarda el regreso de la recarga en su casilla,
  aparte de la del aviso tocado.

## Lo que falta

Un proveedor real y su página de regreso (con universal link, que no se
puede suplantar como el esquema propio) piden convenio. Hasta entonces, un
iPhone real no alcanza la pasarela de `localhost`. El saldo simulado no
cambia tras una recarga aprobada: la pantalla avisa que puede tardar.
