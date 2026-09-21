#!/usr/bin/env python3
"""Reparte fotos+etiquetas en train/val (80/20) SIN fuga entre ambos.

Regla crítica: se parte POR SESIÓN DE GRABACIÓN, no por foto. Los frames
de un mismo video se parecen demasiado; si van mitad a train y mitad a val,
la métrica de val miente (el modelo "reconoce" el bus, no a la gente).
Todas las fotos de `frontal_lleno_*.jpg` van juntas a train O a val.

Uso:
    python split_dataset.py --origen dataset/etiquetado --destino dataset
Espera: origen/*.jpg con su *.txt al lado (fotos de bus vacío sin .txt
también sirven: enséñale cómo se ve un bus vacío).
"""
import argparse
import random
import re
from pathlib import Path
from shutil import copy2

PATRON_SESION = re.compile(r"^(?P<sesion>.+)_\d{4}$")


def sesion_de(foto: Path) -> str:
    m = PATRON_SESION.match(foto.stem)
    return m.group("sesion") if m else foto.stem


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--origen", required=True)
    p.add_argument("--destino", required=True)
    p.add_argument("--val", type=float, default=0.20)
    p.add_argument("--semilla", type=int, default=42)
    a = p.parse_args()

    fotos = sorted(Path(a.origen).glob("*.jpg"))
    sesiones: dict[str, list[Path]] = {}
    for f in fotos:
        sesiones.setdefault(sesion_de(f), []).append(f)

    # Sesiones grandes primero: así el 20% no se lo come una sola sesión.
    orden = sorted(sesiones, key=lambda s: len(sesiones[s]), reverse=True)
    rnd = random.Random(a.semilla)
    # Baraja solo dentro de cada tamaño para no romper el orden anterior.
    val, train, n_val = [], [], max(1, round(len(fotos) * a.val))
    for s in orden:
        (val if sum(map(len, val)) < n_val else train).append(sesiones[s])

    grupos = {"val": [f for s in val for f in s],
              "train": [f for s in train for f in s]}
    for grupo, lista in grupos.items():
        for ext in ("images", "labels"):
            (Path(a.destino) / ext / grupo).mkdir(parents=True, exist_ok=True)
        for f in lista:
            copy2(f, Path(a.destino) / "images" / grupo / f.name)
            txt = f.with_suffix(".txt")
            destino = Path(a.destino) / "labels" / grupo / (f.stem + ".txt")
            copy2(txt, destino) if txt.exists() else destino.write_text("")
    print({k: len(v) for k, v in grupos.items()}, flush=True)
    print("sesiones en val:", sorted(sesion_de(f) for f in grupos["val"]),
          flush=True)


if __name__ == "__main__":
    main()
