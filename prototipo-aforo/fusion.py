#!/usr/bin/env python3
"""Fusión de las 2 cámaras del bus a UN estado (VACÍO / MEDIO / LLENO).

Cada cámara ya trae su estado, suavizado y decidido en aforo.py. Aquí solo
se decide el del bus, con la misma línea que el resto del aforo: tirar pa
abajo. Decir «lleno» de un bus con espacio le quita pasajeros a la empresa.

Reglas, en orden:
  1. Si solo hay una cámara (la otra caída o sin datos) -> su estado,
     confianza baja. Una cámara en negro no tumba la lectura del bus.
  2. Si ambas dicen lo mismo -> ese estado, confianza alta.
  3. Si difieren -> el estado MÁS BAJO, confianza media. Una cámara que ve
     su mitad llena y otra que ve la suya vacía describen un bus con espacio.
  4. Si difieren en dos niveles (VACÍO contra LLENO) -> además outlier=True:
     lo más probable es una cámara tapada, sucia o mal apuntada, y alguien
     de la operación debe mirarla.

Uso como librería:
    from fusion import fusionar
    estado, confianza, outlier = fusionar("MEDIO", "VACÍO")
    estado, confianza, outlier = fusionar("LLENO", None)

Con los JSONL de aforo.py (última línea de cada uno):
    python fusion.py --a camara_frontal.jsonl --b camara_trasera.jsonl
    python fusion.py --a camara_frontal.jsonl          # solo una cámara
"""
from __future__ import annotations

import argparse
import json

from modelo import ESTADOS

ORDEN = {estado: nivel for nivel, estado in enumerate(ESTADOS)}


def _nivel(estado: str) -> int:
    if estado not in ORDEN:
        raise ValueError(f"estado desconocido {estado!r}; se esperaba uno de {list(ESTADOS)}")
    return ORDEN[estado]


def fusionar(estado_a: str | None, estado_b: str | None):
    """Devuelve (estado, confianza, outlier). None = cámara sin dato."""
    if estado_a is None and estado_b is None:
        raise ValueError("ninguna cámara trae estado")
    if estado_a is None or estado_b is None:
        unico = estado_b if estado_a is None else estado_a
        _nivel(unico)
        return unico, "baja", False
    na, nb = _nivel(estado_a), _nivel(estado_b)
    if na == nb:
        return estado_a, "alta", False
    return ESTADOS[min(na, nb)], "media", abs(na - nb) >= 2


def _ultima(ruta: str) -> dict:
    with open(ruta, encoding="utf-8") as f:
        lineas = [linea for linea in f if linea.strip()]
    if not lineas:
        raise SystemExit(f"sin mediciones en {ruta}")
    return json.loads(lineas[-1])


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Fusiona 2 cámaras a un estado.")
    p.add_argument("--a", required=True, help="JSONL cámara frontal")
    p.add_argument("--b", default=None, help="JSONL cámara trasera (opcional)")
    a = p.parse_args(argv)
    ma = _ultima(a.a)
    mb = _ultima(a.b) if a.b else None
    estado, confianza, outlier = fusionar(
        ma["estado_ocupacion"], mb["estado_ocupacion"] if mb else None)
    print(json.dumps({
        "estado": estado,
        "confianza": confianza,
        "outlier": outlier,
        "detalle": {"frontal": ma, "trasera": mb},
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
