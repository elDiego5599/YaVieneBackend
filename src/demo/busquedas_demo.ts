import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siembraBusquedasDemoHabilitada } from '../config';
import { getDb } from '../data/database';
import { K_BUSQUEDAS, PASO_LAT, PASO_LNG } from '../data/busquedas';

type Punto = { lat: number; lon: number };
type Ruta = { routeId: string; waypoints: Punto[] };
type Celda = { lat: number; lon: number; key: string };
const METROS_LAT = 111_320;
const METROS_LNG = 111_320 * Math.cos(11 * Math.PI / 180);
const SIGMA_FOCO_METROS = 400;
const MS_DIA = 24 * 60 * 60_000;
const HORAS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
const PESO_HORA = [0.015, 0.008, 0.004, 0.004, 0.01, 0.14, 0.8, 1, 0.95, 0.65, 0.48, 0.37,
  0.3, 0.34, 0.4, 0.48, 0.68, 0.95, 1, 0.92, 0.7, 0.45, 0.2, 0.06];

function hash(texto: string): number {
  let valor = 2166136261;
  for (const caracter of texto) valor = Math.imul(valor ^ caracter.charCodeAt(0), 16777619);
  return valor >>> 0;
}

function distancia(a: Punto, b: Punto): number {
  return Math.hypot((a.lon - b.lon) * METROS_LNG, (a.lat - b.lat) * METROS_LAT);
}

function celdasDeRuta(puntos: Punto[]): Celda[] {
  const celdas = new Map<string, Celda>();
  for (let i = 1; i < puntos.length; i += 1) {
    const a = puntos[i - 1]; const b = puntos[i];
    const largo = distancia(a, b);
    const pasos = Math.max(1, Math.ceil(largo / 35));
    for (let j = i === 1 ? 0 : 1; j <= pasos; j += 1) {
      const f = j / pasos;
      const lat = Math.round((a.lat + (b.lat - a.lat) * f) / PASO_LAT) * PASO_LAT;
      const lon = Math.round((a.lon + (b.lon - a.lon) * f) / PASO_LNG) * PASO_LNG;
      const key = `${lat.toFixed(8)},${lon.toFixed(8)}`;
      celdas.set(key, { lat, lon, key });
    }
  }
  return [...celdas.values()];
}

function repartir(total: number, pesos: number[], semilla: number): number[] {
  const suma = pesos.reduce((a, b) => a + b, 0);
  const exactos = pesos.map((peso) => total * peso / suma);
  const resultado = exactos.map(Math.floor);
  let faltan = total - resultado.reduce((a, b) => a + b, 0);
  const orden = exactos.map((valor, i) => ({ i, resto: valor - resultado[i], tie: hash(`${semilla}:${i}`) }))
    .sort((a, b) => b.resto - a.resto || a.tie - b.tie);
  for (let i = 0; i < faltan; i += 1) resultado[orden[i].i] += 1;
  return resultado;
}

function mezclar<T>(elementos: T[], semilla: number): T[] {
  const salida = [...elementos];
  let estado = semilla || 1;
  for (let i = salida.length - 1; i > 0; i -= 1) {
    estado ^= estado << 13;
    estado ^= estado >>> 17;
    estado ^= estado << 5;
    const j = (estado >>> 0) % (i + 1);
    [salida[i], salida[j]] = [salida[j], salida[i]];
  }
  return salida;
}

function horasPorBusqueda(total: number): number[] {
  const sumaPesos = PESO_HORA.reduce((a, b) => a + b, 0);
  const acumulados = PESO_HORA.map((_, indice) =>
    PESO_HORA.slice(0, indice + 1).reduce((a, b) => a + b, 0) / sumaPesos);
  return Array.from({ length: total }, (_, n) => {
    const muestra = (n + 0.5) / total;
    return acumulados.findIndex((acumulado) => muestra <= acumulado);
  });
}

/** Agrega calor sintético solo a rutas demo sin búsquedas reales. */
export function sembrarBusquedasDemo(ahora = Date.now()): void {
  if (!siembraBusquedasDemoHabilitada()) return;
  const archivo = join(__dirname, '..', '..', 'scripts', 'data', 'rutas.json');
  const rutas = (JSON.parse(readFileSync(archivo, 'utf8')) as { rutas: Ruta[] }).rutas;
  const db = getDb();
  const insertar = db.prepare(`INSERT INTO busquedas(route_id, hora, celda_key, celda_lat, celda_lng, count)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(route_id, hora, celda_key) DO NOTHING`);
  const existe = db.prepare('SELECT 1 FROM busquedas WHERE route_id = ? LIMIT 1');
  const demo = db.prepare("SELECT route_id FROM company_routes WHERE company_id IN ('EMP-01','EMP-03') ORDER BY route_id").all() as { route_id: string }[];
  const escribir = db.transaction(() => {
    for (const { route_id: routeId } of demo) {
      if (existe.get(routeId)) continue;
      const geometria = rutas.find((ruta) => ruta.routeId === routeId);
      if (!geometria || geometria.waypoints.length < 2) continue;
      const celdas = celdasDeRuta(geometria.waypoints);
      const semilla = hash(routeId);
      const focos = [0.17, 0.42, 0.68, 0.88]
        .map((f) => geometria.waypoints[Math.floor(f * (geometria.waypoints.length - 1))]);
      const banda = celdas.map((celda) => K_BUSQUEDAS + hash(`${routeId}:${celda.key}`) % 3);
      const pico = 57 + hash(`${routeId}:foco`) % 4;
      const totales = celdas.map((celda, i) => {
        const campana = Math.max(...focos.map((foco) => {
          const d = distancia(celda, foco);
          return Math.exp(-(d * d) / (2 * SIGMA_FOCO_METROS * SIGMA_FOCO_METROS));
        }));
        return Math.min(60, Math.round(banda[i] + (pico - banda[i]) * campana));
      });
      let exceso = Math.max(0, totales.reduce((a, b) => a + b, 0) - 6_000);
      if (exceso > 0) {
        const centros = new Set(focos.map((foco) => celdas.reduce((cercana, celda, i) =>
          distancia(celda, foco) < distancia(celdas[cercana], foco) ? i : cercana, 0)));
        const bordes = celdas.map((celda, i) => ({
          i,
          distancia: Math.min(...focos.map((foco) => distancia(celda, foco))),
        })).filter(({ i }) => !centros.has(i)).sort((a, b) => b.distancia - a.distancia || a.i - b.i);
        const extraEnBordes = bordes.reduce((suma, { i }) => suma + totales[i] - banda[i], 0);
        let recortarDeFocos = Math.min(exceso, extraEnBordes);
        for (const { i } of bordes) {
          if (recortarDeFocos === 0) break;
          const recorte = Math.min(recortarDeFocos, totales[i] - banda[i]);
          totales[i] -= recorte;
          recortarDeFocos -= recorte;
        }
        exceso -= Math.min(exceso, extraEnBordes);
        for (const { i } of bordes) {
          if (exceso === 0) break;
          const recorte = Math.min(exceso, totales[i] - K_BUSQUEDAS);
          totales[i] -= recorte;
          exceso -= recorte;
        }
      }
      const totalRuta = totales.reduce((a, b) => a + b, 0);
      const horas = horasPorBusqueda(totalRuta);
      const porCeldaHora = celdas.map(() => Array<number>(HORAS.length).fill(0));
      let busqueda = 0;
      for (const indice of mezclar(celdas.map((_, i) => i), semilla)) {
        for (let i = 0; i < totales[indice]; i += 1) {
          porCeldaHora[indice][horas[busqueda]] += 1;
          busqueda += 1;
        }
      }
      const inicioDia = Math.floor(ahora / MS_DIA) * MS_DIA - 13 * MS_DIA;
      for (let i = 0; i < celdas.length; i += 1) {
        for (let h = 0; h < HORAS.length; h += 1) {
          const totalHora = porCeldaHora[i][h];
          if (totalHora === 0) continue;
          const variacionDia = Array.from({ length: 14 }, (_, dia) => 0.8 + (hash(`${routeId}:${i}:${h}:${dia}`) % 41) / 100);
          const porDia = repartir(totalHora, variacionDia, semilla + i + h);
          for (let dia = 0; dia < porDia.length; dia += 1) {
            if (porDia[dia] === 0) continue;
            const horaBogota = inicioDia + dia * MS_DIA + (HORAS[h] + 5) * 60 * 60_000;
            insertar.run(routeId, horaBogota, celdas[i].key, celdas[i].lat, celdas[i].lon, porDia[dia]);
          }
        }
      }
    }
  });
  escribir();
}
