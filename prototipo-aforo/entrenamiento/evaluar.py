#!/usr/bin/env python3
"""Mide un peso entrenado y calibra los umbrales de la regla «tira pa abajo».

La exactitud sola no sirve aquí: los dos errores no cuestan lo mismo.
  - SOBREESTIMAR (decir MEDIO o LLENO de un bus que tiene menos gente) le
    quita pasajeros a la empresa: la gente deja pasar un bus con espacio.
    Es el error que la regla castiga.
  - SUBESTIMAR (decir VACÍO de un bus MEDIO) molesta al pasajero, pero no
    le cuesta el pasaje a nadie. Se acepta más de este.

Por eso las métricas separan ambas tasas, y `--barrer` busca el par de
umbrales (lleno, medio) con la mejor macro-F1 entre los que dejan la
sobreestimación por debajo de `--objetivo-sobre`. Los umbrales que salen
se pasan tal cual a aforo.py (`--umbral-lleno`, `--umbral-medio`).

Calibra SIEMPRE sobre `val`, nunca sobre `test`: test se mira una sola
vez, al final, para saber cuánto se equivoca el modelo de verdad.

Uso:
    python evaluar.py --modelo runs/aforo/<fecha>/best.pt --datos dataset/partido/val --barrer
    python evaluar.py --modelo ... --datos dataset/partido/test \\
        --umbral-lleno 0.85 --umbral-medio 0.65
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from aforo import UMBRAL_LLENO, UMBRAL_MEDIO, decidir  # noqa: E402
from modelo import ESTADOS, listar_fotos  # noqa: E402

N = len(ESTADOS)


def matriz_confusion(reales: list[int], predichos: list[int]) -> list[list[int]]:
    """m[real][predicho]."""
    if len(reales) != len(predichos):
        raise ValueError("reales y predichos deben medir lo mismo")
    m = [[0] * N for _ in range(N)]
    for r, p in zip(reales, predichos):
        m[r][p] += 1
    return m


def metricas(reales: list[int], predichos: list[int]) -> dict:
    m = matriz_confusion(reales, predichos)
    total = len(reales)
    sobre = sum(m[r][p] for r in range(N) for p in range(N) if p > r)
    sub = sum(m[r][p] for r in range(N) for p in range(N) if p < r)
    por_clase, f1s = {}, []
    for c, nombre in enumerate(ESTADOS):
        vp = m[c][c]
        predichos_c = sum(m[r][c] for r in range(N))
        reales_c = sum(m[c])
        precision = vp / predichos_c if predichos_c else 0.0
        recall = vp / reales_c if reales_c else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if reales_c:  # una clase ausente no cuenta en la macro-F1
            f1s.append(f1)
        por_clase[nombre] = {"precision": round(precision, 4), "recall": round(recall, 4),
                             "f1": round(f1, 4), "n": reales_c}
    return {
        "n": total,
        "exactitud": round(sum(m[c][c] for c in range(N)) / total, 4) if total else 0.0,
        "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else 0.0,
        "sobreestimacion": round(sobre / total, 4) if total else 0.0,
        "subestimacion": round(sub / total, 4) if total else 0.0,
        "por_clase": por_clase,
        "matriz": m,
    }


def _rejilla(desde: float = 0.50, hasta: float = 0.95, paso: float = 0.05) -> list[float]:
    pasos = round((hasta - desde) / paso)
    return [round(desde + i * paso, 2) for i in range(pasos + 1)]


def barrer(probs: list[list[float]], reales: list[int],
           objetivo_sobre: float) -> dict | None:
    """Mejor par (lleno, medio) con sobreestimación <= objetivo_sobre.

    Criterio: más macro-F1; empate -> menos sobreestimación; empate ->
    umbrales más altos (más conservador). None si ningún par cumple."""
    mejor, clave_mejor = None, None
    for ul in _rejilla():
        for um in _rejilla():
            pred = [ESTADOS.index(decidir(p, ul, um)) for p in probs]
            met = metricas(reales, pred)
            if met["sobreestimacion"] > objetivo_sobre:
                continue
            clave = (met["macro_f1"], -met["sobreestimacion"], ul, um)
            if clave_mejor is None or clave > clave_mejor:
                clave_mejor = clave
                mejor = {"umbral_lleno": ul, "umbral_medio": um, "metricas": met}
    return mejor


def inferir(modelo: str, datos: str, dispositivo: str, lote: int = 32):
    """(probs, reales) de todas las fotos de `datos/<clase>/`."""
    import torch
    from PIL import Image

    from modelo import cargar, elegir_dispositivo, transformaciones

    dispositivo = elegir_dispositivo(dispositivo)
    red, imgsz = cargar(modelo, dispositivo)
    tf = transformaciones(imgsz, entrenamiento=False)
    fotos = listar_fotos(datos)
    if not fotos:
        raise SystemExit(f"no hay fotos en {datos}")
    probs: list[list[float]] = []
    with torch.inference_mode():
        for i in range(0, len(fotos), lote):
            tanda = torch.stack([tf(Image.open(f).convert("RGB")) for f, _ in fotos[i:i + lote]])
            salida = torch.softmax(red(tanda.to(dispositivo)).float(), dim=1)
            probs += salida.cpu().tolist()
    return probs, [n for _, n in fotos]


def _umbral(texto: str) -> float:
    v = float(texto)
    if not 0 < v <= 1:
        raise argparse.ArgumentTypeError("debe estar en (0, 1]")
    return v


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Evalúa el clasificador de aforo.")
    p.add_argument("--modelo", required=True)
    p.add_argument("--datos", required=True, help="carpeta con vacio/ medio/ lleno/")
    p.add_argument("--umbral-lleno", type=_umbral, default=UMBRAL_LLENO)
    p.add_argument("--umbral-medio", type=_umbral, default=UMBRAL_MEDIO)
    p.add_argument("--barrer", action="store_true", help="busca los umbrales (solo en val)")
    p.add_argument("--objetivo-sobre", type=float, default=0.05,
                   help="sobreestimación máxima aceptada al barrer (0.05 = 5%%)")
    p.add_argument("--device", default="auto")
    a = p.parse_args(argv)

    probs, reales = inferir(a.modelo, a.datos, a.device)
    pred = [ESTADOS.index(decidir(pr, a.umbral_lleno, a.umbral_medio)) for pr in probs]
    salida = {"umbrales": {"lleno": a.umbral_lleno, "medio": a.umbral_medio},
              "metricas": metricas(reales, pred)}
    if a.barrer:
        salida["barrido"] = barrer(probs, reales, a.objetivo_sobre)
        if salida["barrido"] is None:
            print(f"[aviso] ningún par de umbrales deja la sobreestimación en "
                  f"{a.objetivo_sobre:.0%}: hacen falta más datos o más épocas", flush=True)
    print(json.dumps(salida, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
