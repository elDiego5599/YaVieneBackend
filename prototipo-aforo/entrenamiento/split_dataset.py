#!/usr/bin/env python3
"""Reparte las fotos etiquetadas en train / val / test SIN fuga entre ellos.

Regla crítica: se parte POR SESIÓN DE GRABACIÓN, no por foto. Los fotogramas
de un mismo video se parecen demasiado; si van unos a train y otros a val,
la métrica miente (el modelo reconoce ESE bus a ESA hora, no el aforo). Todas
las fotos de `frontal_bus12_0930_*.jpg` van juntas al mismo grupo, aunque
unas estén en `lleno/` y otras en `medio/` (el bus se llenó en el video).

Además se estratifica: cada sesión cuenta para la clase de la mayoría de sus
fotos, y cada clase se reparte por separado. Así LLENO, que es la escasa,
aparece en val y en test y no solo en train.

Uso:
    python split_dataset.py --origen dataset/etiquetado --destino dataset/partido
Espera: origen/vacio/*.jpg, origen/medio/*.jpg, origen/lleno/*.jpg.
Sale:   destino/{train,val,test}/{vacio,medio,lleno}/*.jpg
"""
from __future__ import annotations

import argparse
import random
import re
import sys
from collections import Counter
from pathlib import Path
from shutil import copy2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modelo import CARPETAS, listar_fotos  # noqa: E402

PATRON_SESION = re.compile(r"^(?P<sesion>.+)_\d{4}$")
GRUPOS = ("train", "val", "test")


def sesion_de(foto: Path) -> str:
    """`frontal_bus12_0930_0042.jpg` -> `frontal_bus12_0930` (el nombre que
    le pone extraer_frames.py: el video más un número de 4 cifras)."""
    m = PATRON_SESION.match(foto.stem)
    return m.group("sesion") if m else foto.stem


def repartir(fotos: list[tuple[Path, int]], val: float, test: float,
             semilla: int) -> tuple[dict[str, list[tuple[Path, int]]], list[str]]:
    """Devuelve ({grupo: [(foto, nivel)]}, avisos). Determinista por semilla."""
    if not (0 <= val < 1 and 0 <= test < 1 and val + test < 1):
        raise ValueError("val y test deben estar en [0, 1) y sumar menos de 1")
    sesiones: dict[str, list[tuple[Path, int]]] = {}
    for foto, nivel in fotos:
        sesiones.setdefault(sesion_de(foto), []).append((foto, nivel))

    por_clase: dict[int, list[str]] = {n: [] for n in range(len(CARPETAS))}
    for nombre, lista in sesiones.items():
        conteo = Counter(nivel for _, nivel in lista)
        # Empate: gana el nivel más bajo (el orden de most_common no se fía).
        mayor = max(conteo.values())
        por_clase[min(n for n, c in conteo.items() if c == mayor)].append(nombre)

    asignado: dict[str, str] = {}
    avisos: list[str] = []
    for nivel, nombres in por_clase.items():
        if not nombres:
            avisos.append(f"{CARPETAS[nivel]}: no hay ninguna sesión de esta clase")
            continue
        nombres = sorted(nombres)
        random.Random(f"{semilla}-{nivel}").shuffle(nombres)
        total = sum(len(sesiones[s]) for s in nombres)
        necesita = 1 + (val > 0) + (test > 0)
        if len(nombres) < necesita:
            avisos.append(f"{CARPETAS[nivel]}: {len(nombres)} sesión(es); hacen falta "
                          f"{necesita} para que salga en todos los grupos. Graba más.")
        pendientes = list(nombres)
        # train se queda siempre con al menos una sesión: sin ella la clase
        # no se aprende. Luego test y val, por fotos, hasta su fracción.
        for grupo, fraccion in (("test", test), ("val", val)):
            quedan_para_despues = 1 + (grupo == "test" and val > 0)
            meta, llevan = fraccion * total, 0
            while (fraccion > 0 and llevan < meta
                   and len(pendientes) > quedan_para_despues):
                s = pendientes.pop()
                asignado[s] = grupo
                llevan += len(sesiones[s])
        for s in pendientes:
            asignado[s] = "train"

    grupos: dict[str, list[tuple[Path, int]]] = {g: [] for g in GRUPOS}
    for nombre, lista in sorted(sesiones.items()):
        grupos[asignado[nombre]] += lista
    for grupo in ("val", "test"):
        if (val if grupo == "val" else test) > 0:
            faltan = [CARPETAS[n] for n in range(len(CARPETAS))
                      if not any(nv == n for _, nv in grupos[grupo])]
            if faltan:
                avisos.append(f"{grupo} sin fotos de: {', '.join(faltan)}")
    return grupos, avisos


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Reparte el dataset por sesión.")
    p.add_argument("--origen", required=True)
    p.add_argument("--destino", required=True)
    p.add_argument("--val", type=float, default=0.15)
    p.add_argument("--test", type=float, default=0.15)
    p.add_argument("--semilla", type=int, default=42)
    a = p.parse_args(argv)

    destino = Path(a.destino)
    if destino.exists() and any(destino.iterdir()):
        # Restos de un reparto viejo = fuga garantizada entre grupos.
        p.error(f"{destino} ya tiene archivos: bórralo o usa otra carpeta")
    fotos = listar_fotos(a.origen)
    if not fotos:
        p.error(f"no hay fotos en {a.origen}/{{{','.join(CARPETAS)}}}")
    grupos, avisos = repartir(fotos, a.val, a.test, a.semilla)

    for grupo, lista in grupos.items():
        for carpeta in CARPETAS:
            (destino / grupo / carpeta).mkdir(parents=True, exist_ok=True)
        for foto, nivel in lista:
            copy2(foto, destino / grupo / CARPETAS[nivel] / foto.name)
        conteo = Counter(CARPETAS[n] for _, n in lista)
        print(f"{grupo:5s} {len(lista):5d} fotos  "
              + "  ".join(f"{c}={conteo.get(c, 0)}" for c in CARPETAS)
              + f"  sesiones={len({sesion_de(f) for f, _ in lista})}", flush=True)
    for aviso in avisos:
        print(f"[aviso] {aviso}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
