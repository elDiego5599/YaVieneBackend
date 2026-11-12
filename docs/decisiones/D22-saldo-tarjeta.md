# D22. El número de la tarjeta SIBUS vive solo en el teléfono

**Fecha:** 12 de noviembre de 2026  
**Afecta:** app pasajero (el backend no recibe nada).

## Decisión

El pasajero guarda el número de su tarjeta SIBUS en Más, Tu tarjeta, y ve su
saldo. El número vive solo en el Llavero de iOS o el Keystore de Android
(`flutter_secure_storage`, `first_unlock_this_device`, sin sincronizar con
iCloud), nunca en SharedPreferences, el backend, los logs ni los errores. Se
enseña enmascarado a las cuatro últimas cifras, también para VoiceOver. El
pasajero lo quita cuando quiera, con una confirmación en `Dialogo`.

El saldo llega detrás de un `ProveedorSaldo` que nunca lanza: responde un
`ConsultaSaldo` sellado (consultado, sin red, tarjeta no encontrada, no
disponible). Hoy el único proveedor es `SaldoSimulado`, y mientras lo sea la
pantalla lleva la etiqueta «Simulación» en todos sus estados (D8).

## Por qué

El número de la tarjeta enlaza los viajes de una persona. Ya Viene no tiene
cuentas (D3) y no lo necesita en el servidor: si no lo guarda, no lo puede
perder. No hay API pública del recaudo de Barranquilla, así que el saldo de
verdad pide un convenio; el proveedor deja enchufarlo sin tocar la pantalla.

## Amenazas y lo que las cubre

- **Entrada:** solo cifras, de 8 a 20 (`NumeroTarjeta.minimo` y `maximo`,
  provisionales hasta conocer el formato real); un texto enorme se corta
  antes de limpiarlo.
- **Divulgación:** `toString` dice `oculto`; el número no viaja al backend
  ni sale en errores; la pantalla y el árbol de accesibilidad solo tienen
  `•••• 1234`.
- **Restos de otra instalación:** iOS conserva el Llavero al desinstalar. Una
  marca en SharedPreferences (que sí se borra) dice si la app es nueva en el
  teléfono; si falta, lo que quede en el Llavero se borra antes de leer.
- **Dato dañado:** lo guardado que no es un número válido se borra; un
  Llavero que no se deja leer (antes del primer desbloqueo) no borra nada.

## Lo que falta

Un proveedor real, el formato del número y si se enseña en el pitch los
decide el dueño (FALTANTES). La recarga es D23.
