import { incrementMetric } from './metrics';

// Una excepción dentro de un setInterval sube sin dueño y tumba el proceso
// entero (Node termina ante un error no capturado). Un fallo puntual de
// cualquiera de los relojes que escriben en SQLite (barrido, despacho,
// limpiezas, siembra de la demo, volcado de métricas), por disco lleno o base
// bloqueada, se registra y la siguiente vuelta lo reintenta, en vez de apagar
// el tiempo real.
export function vueltaProtegida(nombre: string, metrica: string, trabajo: () => void): () => void {
  return () => {
    try {
      trabajo();
    } catch (error) {
      incrementMetric(metrica);
      console.error(`[${nombre}] Falló una vuelta; se reintenta en la siguiente:`, error);
    }
  };
}
