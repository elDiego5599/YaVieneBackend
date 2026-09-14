// Catálogo de rutas por empresa (company_routes) + los nombres de ruta
// heredados de la demo original (routeNameMap), que siguen siendo el
// fallback cuando una ruta deriva de posiciones pero no está en catálogo.
import { getDb } from './database';

export const routeNameMap: Record<string, string> = {
  'R-101': 'Tcherassi',
  'R-102': 'Carrera 14 - Silencio',
  'R-103': 'Vivero Paraíso',
  'R-104': 'Carrera 50 - Paraiso',
  'R-105': 'Carrera 54 - Uninorte',
  'R-106': 'Calle 72 - Uninorte',
};

export function getCompanyRoutes(companyId: string): {
  routeId: string;
  name: string;
  terminalA: string | null;
  terminalB: string | null;
  total: number;
  online: number;
}[] {
  const db = getDb();
  const derived = db.prepare(`
    SELECT COALESCE(p.route_id, b.route_id) AS route_id,
           COUNT(DISTINCT b.bus_id) AS total,
           -- Conectado es el que sigue reportando: el barrido marca
           -- is_ghost a los que llevan GHOST_MS callados, y contarlos
           -- aquí daba una ruta llena de buses que ya no publican.
           SUM(CASE WHEN p.bus_id IS NOT NULL AND p.is_ghost = 0 THEN 1 ELSE 0 END) AS online
    FROM buses b
    LEFT JOIN positions p ON p.bus_id = b.bus_id
    WHERE b.company_id = ? AND COALESCE(p.route_id, b.route_id) IS NOT NULL
    GROUP BY COALESCE(p.route_id, b.route_id)
  `).all(companyId) as { route_id: string; total: number; online: number }[];
  const catalog = db.prepare(`
    SELECT route_id, name, terminal_a, terminal_b FROM company_routes
    WHERE company_id = ?
    ORDER BY route_id ASC
  `).all(companyId) as { route_id: string; name: string; terminal_a: string | null; terminal_b: string | null }[];

  const totals = new Map(derived.map((r) => [r.route_id, r]));
  const byId = new Map(catalog.map((r) => [r.route_id, r.name]));
  const seen = new Set<string>();
  const merged: {
    routeId: string;
    name: string;
    terminalA: string | null;
    terminalB: string | null;
    total: number;
    online: number;
  }[] = [];

  for (const route of catalog) {
    seen.add(route.route_id);
    merged.push({
      routeId: route.route_id,
      name: route.name,
      terminalA: route.terminal_a,
      terminalB: route.terminal_b,
      total: totals.get(route.route_id)?.total ?? 0,
      online: totals.get(route.route_id)?.online ?? 0,
    });
  }
  for (const row of derived) {
    if (seen.has(row.route_id)) continue;
    merged.push({
      routeId: row.route_id,
      name: byId.get(row.route_id) ?? routeNameMap[row.route_id] ?? `Ruta ${row.route_id}`,
      terminalA: null,
      terminalB: null,
      total: row.total,
      online: row.online ?? 0,
    });
  }
  return merged;
}

export function routeNameExists(companyId: string, name: string, excludeRouteId?: string): boolean {
  const db = getDb();
  const cleaned = name.trim().toLowerCase();
  if (!cleaned) return false;
  const excluded = excludeRouteId ?? '';
  const inCatalog = db.prepare(
    'SELECT 1 FROM company_routes WHERE company_id = ? AND LOWER(name) = ? AND route_id != ? LIMIT 1',
  ).get(companyId, cleaned, excluded);
  if (inCatalog) return true;
  const derived = db.prepare(`
    SELECT COALESCE(p.route_id, b.route_id) AS route_id
    FROM buses b
    LEFT JOIN positions p ON p.bus_id = b.bus_id
    WHERE b.company_id = ? AND COALESCE(p.route_id, b.route_id) IS NOT NULL
  `).all(companyId) as { route_id: string }[];
  return derived.some((r) => {
    if (r.route_id === excluded) return false;
    const fallback = routeNameMap[r.route_id] ?? `Ruta ${r.route_id}`;
    return fallback.toLowerCase() === cleaned;
  });
}

/**
 * Forma válida de un identificador de ruta: grupos alfanuméricos separados
 * por guiones (R-106, RUTA-1A), de 2 a 20 caracteres. El patrón viejo
 * aceptaba `---` o `-R-`: guiones sueltos como identificador.
 *
 * Vive aquí y se exporta porque el alta de rutas no es el único sitio que
 * necesita saberlo: el socket también recibe identificadores del cliente.
 */
export function isRouteId(routeId: string): boolean {
  return (
    /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(routeId)
    && routeId.length >= 2
    && routeId.length <= 20
  );
}

/**
 * Si la ruta existe en alguna parte: en el catálogo de alguna empresa, como
 * ruta de algún bus o de alguna posición guardada, o entre las rutas de la
 * demo. Son las mismas tres fuentes de las que sale la lista de rutas que ve
 * el pasajero, así que lo que la app puede pedir, existe.
 *
 * `isRouteId` solo mira la forma: `ZZ-999` la pasa sin existir, y el socket
 * abría una sala para ella. Con esto, el pasajero ya no puede inventarse
 * salas aunque respete el formato.
 */
export function routeExists(routeId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(routeNameMap, routeId)) return true;
  const hit = getDb().prepare(`
    SELECT 1 FROM company_routes WHERE route_id = ?
    UNION ALL SELECT 1 FROM buses WHERE route_id = ?
    UNION ALL SELECT 1 FROM positions WHERE route_id = ?
    LIMIT 1
  `).get(routeId, routeId, routeId);
  return hit !== undefined;
}

/**
 * Largo máximo del nombre de una ruta. El nombre sale tal cual en el selector
 * de la app del pasajero y en `/api/companies/:id/routes`, que es público, y
 * hasta ahora el único tope era el del cuerpo de la petición (32 KB): una
 * empresa podía dejar un nombre de miles de caracteres en la lista que ven
 * todos los pasajeros. El más largo de verdad hoy es «Carrera 14 - Silencio».
 */
export const MAX_NOMBRE_RUTA = 60;

/**
 * Alta de una ruta en el catálogo de la empresa. Devuelve la ruta, `null` si
 * el nombre o el identificador no valen, o `'taken'` si el identificador ya
 * es de una ruta, de esta empresa o de cualquier otra, o de la demo.
 *
 * El choque con la misma empresa se resolvía con `ON CONFLICT DO UPDATE SET
 * name`: un alta con un identificador repetido renombraba en silencio la ruta
 * que ya existía —con sus buses y sus pasajeros suscritos— y respondía 201
 * como si hubiera creado otra. Renombrar tiene su propio PATCH; aquí un
 * choque es un choque.
 *
 * Y el choque con otra empresa ni siquiera se miraba: la sala del pasajero
 * (`route:{id}`) y la consulta de posiciones van por identificador a secas,
 * así que dos empresas con R-001 enseñaban cada una los buses de la otra. El
 * índice único `idx_company_routes_route_id` (migración 20) lo garantiza en
 * la base; el 409 no dice de quién es la ruta.
 */
export type AddRouteError = 'taken';

/** El número más alto de las rutas de la demo (R-106): la cuenta sigue desde ahí. */
const MAYOR_RUTA_DEMO = Math.max(
  ...Object.keys(routeNameMap).map((id) => parseInt(id.slice(2), 10)),
);

export function addCompanyRoute(
  companyId: string,
  routeId: string,
  name: string,
): { routeId: string; name: string } | AddRouteError | null {
  const cleanedName = name.trim();
  if (!cleanedName || cleanedName.length > MAX_NOMBRE_RUTA) return null;
  const db = getDb();
  let cleanedId = routeId.trim().toUpperCase();
  if (!cleanedId) {
    // Global y numérica. Antes era por empresa —toda empresa nueva empezaba
    // en R-001— y ordenaba texto: tras R-999 venía R-1000, pero el mayor
    // como texto seguía siendo 'R-999' y la siguiente volvía a pedir R-1000.
    const { mayor } = db.prepare(`
      SELECT MAX(CAST(substr(route_id, 3) AS INTEGER)) AS mayor
      FROM company_routes
      WHERE route_id GLOB 'R-[0-9]*' AND substr(route_id, 3) NOT GLOB '*[^0-9]*'
    `).get() as { mayor: number | null };
    const next = Math.max(mayor ?? 0, MAYOR_RUTA_DEMO) + 1;
    cleanedId = `R-${String(next).padStart(3, '0')}`;
  }
  if (!isRouteId(cleanedId)) return null;
  // Las de la demo tienen su recorrido dibujado en la app del pasajero
  // (assets/data/rutas.json): otra empresa con ese código heredaría el mapa.
  if (Object.prototype.hasOwnProperty.call(routeNameMap, cleanedId)) return 'taken';
  // Sin columna en el ON CONFLICT: vale para la clave (empresa, ruta) y para
  // el índice único de `route_id` solo.
  const result = db.prepare(`
    INSERT INTO company_routes (company_id, route_id, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(companyId, cleanedId, cleanedName, Date.now());
  if (result.changes === 0) return 'taken';
  return { routeId: cleanedId, name: cleanedName };
}

export function renameCompanyRoute(
  companyId: string,
  routeId: string,
  name: string,
): { routeId: string; name: string } | null {
  const cleanedName = name.trim();
  if (!cleanedName || cleanedName.length > MAX_NOMBRE_RUTA) return null;
  const result = getDb().prepare(
    'UPDATE company_routes SET name = ? WHERE company_id = ? AND route_id = ?',
  ).run(cleanedName, companyId, routeId);
  if (result.changes === 0) return null;
  return { routeId, name: cleanedName };
}

export function removeCompanyRoute(companyId: string, routeId: string): boolean {
  const db = getDb();
  const remove = db.transaction(() => {
    const result = db.prepare(
      'DELETE FROM company_routes WHERE company_id = ? AND route_id = ?',
    ).run(companyId, routeId);
    if (result.changes === 0) return false;

    const busIds = (db.prepare(
      'SELECT bus_id FROM buses WHERE company_id = ? AND route_id = ?',
    ).all(companyId, routeId) as { bus_id: string }[]).map((r) => r.bus_id);

    if (busIds.length > 0) {
      const fallback = db.prepare(
        'SELECT route_id FROM company_routes WHERE company_id = ? ORDER BY route_id ASC LIMIT 1',
      ).get(companyId) as { route_id: string } | undefined;
      // Si a la empresa no le queda ninguna ruta, el fallback era 'R-101'
      // a pelo: los buses quedaban apuntando a una ruta que puede no
      // existir, y el pasajero pedía posiciones de un identificador
      // fantasma. Sin ruta a la que mudarlos, se quedan sin ruta.
      const fallbackId = fallback?.route_id ?? null;
      db.prepare(
        'UPDATE buses SET route_id = ?, updated_at = ? WHERE company_id = ? AND route_id = ?',
      ).run(fallbackId, Date.now(), companyId, routeId);
      if (fallbackId) {
        const setPositionRoute = db.prepare(
          'UPDATE positions SET route_id = ? WHERE bus_id = ?',
        );
        for (const busId of busIds) {
          setPositionRoute.run(fallbackId, busId);
        }
      }
    }
    return true;
  });
  return remove();
}
