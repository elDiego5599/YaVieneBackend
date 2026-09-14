// Zona de servicio: la caja que contiene todo el recorrido de las rutas de la
// demo más MARGEN_ZONA_KM por cada lado. Toda posición tiene que caer dentro.
//
// Sin esto, la primera posición de cada sesión entraba sin mirar dónde —la
// física solo compara contra la anterior— y un equipo mal configurado podía
// poner un bus en Bogotá, en el mapa de todos los pasajeros de la ruta.
//
// Los números salen de scripts/data/rutas.json (el mismo archivo que dibuja
// la app del pasajero: app_pasajero/assets/data/rutas.json es copia byte a
// byte), con el mismo radio de la Tierra que haversineDistanceKm y redondeados
// hacia fuera a la cuarta decimal (~11 m). Si cambian las rutas, se regeneran
// con esto y tests/zona.test.ts avisa si la caja quedó vieja:
//
//   node -e '
//   const d=JSON.parse(require("fs").readFileSync("scripts/data/rutas.json","utf8"));
//   const p=d.rutas.flatMap(r=>r.waypoints), M=2, km=Math.PI*6371/180;
//   const lat=p.map(w=>w.lat), lon=p.map(w=>w.lon), c=Math.cos(Math.max(...lat.map(Math.abs))*Math.PI/180);
//   const b=(x,s)=>(s<0?Math.floor:Math.ceil)(x*1e4)/1e4;
//   console.log(JSON.stringify({latMin:b(Math.min(...lat)-M/km,-1),latMax:b(Math.max(...lat)+M/km,1),lonMin:b(Math.min(...lon)-M/(km*c),-1),lonMax:b(Math.max(...lon)+M/(km*c),1)}))'
//
// El grado de longitud se mide en la latitud más al norte, donde es más
// corto: así el margen este-oeste es de 2 km como mínimo en toda la caja.
//
// Es la zona de las seis rutas de Sobusa. Una empresa con rutas fuera —en
// Malambo, por ejemplo, más al sur— necesita ampliar la caja antes de que
// sus buses publiquen.

export const MARGEN_ZONA_KM = 2;

export const ZONA = {
  latMin: 10.8694,
  latMax: 11.0573,
  lonMin: -74.8917,
  lonMax: -74.7548,
} as const;

export function dentroDeZona(lat: number, lon: number): boolean {
  return lat >= ZONA.latMin && lat <= ZONA.latMax && lon >= ZONA.lonMin && lon <= ZONA.lonMax;
}
