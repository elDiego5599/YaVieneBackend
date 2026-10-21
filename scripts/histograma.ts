/** Percentil por rango floor(total * p), con bins enteros de milisegundos. */
export function percentil(ordenadas: number[], p: number): number | null {
  if (ordenadas.length === 0) return null;
  return ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))];
}

export function percentilHistograma(
  histograma: Map<number, number>,
  total: number,
  p: number,
): number | null {
  if (total === 0) return null;
  const objetivo = Math.floor(total * p);
  let acumulado = 0;
  for (const [ms, cantidad] of [...histograma].sort((a, b) => a[0] - b[0])) {
    acumulado += cantidad;
    if (acumulado > objetivo) return ms;
  }
  return null;
}
