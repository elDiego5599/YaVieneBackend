# D23. La recarga se entrega al operador o al banco

**Fecha:** 12 de noviembre de 2026  
**Afecta:** app pasajero.  
**Estado:** propuesta; se cierra con la recarga (fase 6).

## Decisión propuesta

Ya Viene nunca procesa un pago. Recargar abre el canal del operador o del
banco con una referencia opaca, sin el número de la tarjeta en la URL; la
vuelta a la app se valida y el estado de la recarga se le pregunta al
proveedor, nunca se cree lo que diga la URL de vuelta. Nada de WebView de
pago dentro de la app. Mientras no haya convenio, un proveedor simulado con
la etiqueta «Simulación» (D8), como el saldo (D22).

## Por qué

Un pago dentro de la app pide PCI, cuentas y soporte que Ya Viene no tiene
ni quiere (D3). Entregar el pago a quien ya lo cobra deja a la app solo
leyendo el resultado.
