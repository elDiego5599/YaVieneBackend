// Lo que sale de la cola y lo que se queda dentro.
//
// El barrido marca «sin señal» a un bus callado y encola el aviso; el
// despacho lo manda hasta 250 ms después. Si en ese hueco el bus vuelve a
// publicar, el aviso viejo salía igual y llegaba detrás de la posición
// viva: el pasajero veía en gris un bus que acababa de reportar, y así se
// quedaba hasta la siguiente posición.
//
// El filtro vive aquí y no en `lifecycle_events` porque ese módulo no sabe
// de buses —y no puede saberlo: `positions_store` ya lo importa para
// encolar, así que mirarse el uno al otro sería un ciclo—. Y no vive en
// `index.ts` para que pueda probarse sin levantar el servidor entero.
import { dispatchLifecycleEvents, LifecycleEvent } from './lifecycle_events';
import { isGhostEventStillValid } from './positions_store';

/**
 * Despacha la cola descartando los avisos de «sin señal» que ya no valen.
 * El descartado sale de la cola como entregado: no se emite, pero tampoco
 * se queda dando vueltas sumando intentos hasta morir.
 */
export function dispatchBusEvents(emit: (event: LifecycleEvent) => void): void {
  dispatchLifecycleEvents((event) => {
    if (event.eventType === 'bus:position') {
      const posicion = event.payload as { busId?: string; isGhost?: boolean; capturedAt?: number };
      if (
        posicion.isGhost === true &&
        !isGhostEventStillValid(String(posicion.busId), Number(posicion.capturedAt))
      ) {
        return;
      }
    }
    emit(event);
  });
}
