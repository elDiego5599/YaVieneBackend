# D18 · La queja del pasajero

**Fecha:** 11 de noviembre de 2026  
**Afecta:** backend, app pasajero y panel de empresa.

## Decisión

El buzón de D14 suma un tercer tipo, `queja`, con un motivo obligatorio
(`MOTIVOS_QUEJA` en `src/data/quejas.ts`: no paró, iba lleno, mal trato,
conducción, otra ruta, estado del bus, otro) y, si el pasajero quiere, la
ruta, el bus, el lugar y la hora del hecho. El texto es opcional.

La queja sale por correo al equipo como todo reporte de D14. Si trae ruta,
se guarda además en `quejas` para que la empresa dueña de esa ruta la vea en
Reportes del panel (`GET /api/panel/quejas`, con la sesión de empresa), con
su texto. La empresa sale del backend, nunca de la app: una ruta que no
existe o el bus que no es de esa ruta responde 400.

Quién lee lo decide la sesión, no un parámetro: `authenticateRequest`
(`src/auth/http.ts:20-30`) saca el token del `Bearer` o de la cookie del
panel y `authenticateCompanyAdmin` (`src/auth/http.ts:32-38`) exige que sea
de administrador y que siga vigente en la base. La empresa de ese token es
el único filtro de `quejasDeEmpresa`, así que ninguna ve las de otra. Lo
prueba `tests/quejas.test.ts`, que también comprueba que el correo de D14
no lleva el lugar sin el interruptor.

El lugar es la celda de 150 m de D17, nunca la coordenada exacta, y solo
viaja si el pasajero enciende el interruptor de ubicación (apagado de
fábrica). La hora se guarda en punto, de la última semana y no futura. No se
guardan IP, plataforma ni versión en `quejas`. El panel la marca «Sin
verificar»: es lo que dice un pasajero, no un hecho comprobado.

Las quejas guardadas se borran a los 13 meses, como las búsquedas de D17.

## Pendiente

El dueño confirmó (2026-11-11) que la empresa de la ruta lee la queja con
su texto y que se guardan 13 meses. Falta que confirme los siete motivos.
El aviso legal (Ley 1581) va con el abogado antes de publicar, igual que
D17.
