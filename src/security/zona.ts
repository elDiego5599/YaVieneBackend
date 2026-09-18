// Zona de servicio: el área metropolitana de Barranquilla. Toda posición
// tiene que caer dentro.
//
// Sin esto, la primera posición de cada sesión entraba sin mirar dónde —la
// física solo compara contra la anterior— y un equipo mal configurado podía
// poner un bus en Bogotá, en el mapa de todos los pasajeros de la ruta.
//
// La caja es **la misma que el mapa de la app del pasajero**
// (`app_pasajero/lib/features/map/presentation/utils/map_constants.dart`:
// `areaSurLat`, `areaNorteLat`, `areaOesteLon`, `areaEsteLon`), un cuadrado
// de 41 × 41 km —cuadrado en kilómetros, no en grados— que va de Malambo y
// Soledad al sur hasta Bocas de Ceniza y la ciénaga de Mallorquín al norte,
// con Galapa al occidente y Puerto Colombia al noroccidente. Que sean la
// misma caja no es casualidad ni ahorro: un bus que publique fuera de ahí no
// se podría ver en la app aunque se aceptara, porque el mapa no llega. Si
// algún día el mapa crece, esta caja crece con él y `tests/zona.test.ts`
// avisa comparando los cuatro números contra el archivo Dart.
//
// Antes esto era la caja de las seis rutas de Sobusa más 2 km, que dejaba a
// Malambo por fuera por unos 1,2 km: un bus de allá habría sido rechazado
// desde su primera posición. El dueño decidió el 18 de septiembre de 2026
// que el área metropolitana entera entra.
//
// Sigue siendo un filtro de verdad: rechaza cualquier cosa a más de ~20 km
// del centro del área, que es lo que interesa —un equipo mal configurado, un
// equipo robado, una prueba apuntando al servidor de verdad—, no un bus de
// un municipio vecino.

export const ZONA = {
  latMin: 10.79,
  latMax: 11.164,
  lonMin: -75.0035,
  lonMax: -74.6251,
} as const;

export function dentroDeZona(lat: number, lon: number): boolean {
  return lat >= ZONA.latMin && lat <= ZONA.latMax && lon >= ZONA.lonMin && lon <= ZONA.lonMax;
}
