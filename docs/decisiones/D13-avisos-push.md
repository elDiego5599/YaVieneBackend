# D13 · En Android el aviso llega con la app cerrada, por push del servidor

- **Decidida por el dueño**: 2026-10-02. **Toca**: backend, `app_pasajero`, web.
- **Estado**: vigente en Android. iPhone espera la cuenta de Apple (99 USD
  al año), sin fecha.

## La pregunta

El aviso de «tu bus está cerca» lo calcula el teléfono mirando la posición
del bus cada 5 s. Con la app cerrada, o dormida por el sistema, eso no corre
y el aviso no llega. ¿Lo vigila el servidor cuando la app no puede?

## Lo decidido

**Sí, en Android, con Firebase Cloud Messaging.** El dueño ya activó Cloud
Messaging en el proyecto de Firebase. En iPhone hace falta una clave de APNs,
y esa clave solo la da una cuenta de desarrollador de Apple, que hoy no hay:
iPhone sigue como dice [D4](D4-ios-segundo-plano.md).

## Cómo funciona

- Cada teléfono puede tener un solo bus armado a la vez. La app sigue ese
  bus en la pantalla bloqueada y la Dynamic Island, y el servidor aplica el
  mismo límite por token.
- Al armar el aviso, la app manda al servidor el bus, la ruta, el punto
  donde espera, la distancia a la que quiere el aviso (`radioM`, de 500 m a
  3 km; la elige el pasajero, dueño 2026-10-06; sin ella, 1 km) y el token
  de notificaciones del teléfono (`POST /api/avisos`). No manda nada que diga quién es la persona: el
  pasajero sigue sin cuenta ([D3](D3-sin-cuenta.md)).
- El servidor vigila desde ese momento, esté la app viva o no: cada 5 s
  mira si el bus, con señal, visible y en esa ruta, entró en esa distancia del
  punto, y manda un mensaje solo de datos con prioridad alta y diez minutos
  de vida. La app arma con él la misma notificación que arma sola, con el
  mismo identificador.
- Mientras la app está viva también avisa ella, y late cada 20 s
  (`PUT /api/avisos/:id`) para mover el punto y el token. Si el servidor
  avisó primero, el siguiente latido recibe `410` y la app no vuelve a
  avisar. Si avisó la app, borra el aviso del servidor.
- El aviso se borra al desarmarlo, al cumplirse o a las 3 horas, lo que
  pase antes. Un token que FCM da por muerto se borra con todos sus avisos.

## Por qué así

- **Un mensaje solo de datos** y no una notificación ya armada: así el texto,
  el canal y el identificador son los mismos que los de la app, y nunca
  salen dos avisos del mismo bus.
- **Sin arriendo.** La primera versión dejaba vigilar al servidor solo
  cuando los latidos llevaban 60 s sin llegar, para que la app abierta
  avisara sola. Con la app recién cerrada eso es un minuto de espera, y el
  aviso salía con el bus ya a 700 m y no a los ~950 del radio (dueño,
  2026-10-02). La app no puede decirle al servidor cuándo la cierran (Android
  no deja hacerlo de forma fiable), así que el servidor vigila siempre y lo
  doble se resuelve en el teléfono: la app descarta el push de un aviso que
  ya sonó, y si los dos llegan a la vez la notificación es la misma y
  Android no la hace sonar otra vez (`onlyAlertOnce`). La migración 25 quitó
  la columna del arriendo.
- **Sin el SDK de Admin de Firebase**: lo único que hace falta es firmar un
  JWT, cambiarlo por un token de acceso y un POST. `jsonwebtoken` ya estaba;
  el SDK eran decenas de paquetes más para `npm audit`.

## Lo que cambia en la promesa de privacidad

[D4](D4-ios-segundo-plano.md) descartó el push porque la privacidad
prometía que la ubicación no sale del teléfono. Con esto, en Android y solo
mientras hay un aviso armado, el punto de espera sí sale: el servidor lo
guarda junto al token del teléfono hasta que el aviso se cumple, se desarma
o pasan 3 horas. La política de privacidad de la app y la de la web se
reescribieron para decirlo (versión 4 de los textos legales), y el texto
nuevo entra en la revisión del abogado (T3.15) antes de datos reales.

## Lo que queda para el dueño

La clave de la cuenta de servicio (consola de Firebase → Configuración del
proyecto → Cuentas de servicio → Generar nueva clave privada), guardada
fuera del repo, y su ruta en `YA_VIENE_FCM_CREDENCIALES`. Sin ella el
servidor arranca con el push apagado y la app sigue avisando como antes,
solo con la app abierta. Los pasos están en el [runbook](../runbook.md).
