#!/usr/bin/env python3
"""Fusión de las 2 cámaras del bus a UN estado (VACÍO / MEDIO / LLENO).

NO suma ni promedia conteos: cada cámara ya trae su estado (suavizado por
el promedio móvil en aforo_yolo11.py) y aquí se decide el estado del bus.

Reglas, en orden:
  1. Si ambas cámaras dicen lo mismo -> ese estado, confianza alta.
  2. Si difieren -> el estado MÁS ALTO, confianza media. Es conservador a
     propósito: nunca se promete espacio que quizá no hay. El desacuerdo
     fino (4 vs 5 personas, VACÍO vs MEDIO) se resuelve solo porque cada
     cámara ya viene suavizada.
  3. Outlier: si |conteoA - conteoB| > DIF_MAXIMA, se marca outlier=True
     para revisión operativa (cámara tapada, sucia o caída), aunque el
     estado publicado siga saliendo. Un bus con una cámara en negro no
     deja de publicar: la otra sostiene la lectura.

Uso como librería:
    from fusion import fusionar
    estado, confianza, outlier = fusionar("MEDIO", "VACÍO", 8, 3)

Demo con dos JSONL del script de inferencia (última línea de cada uno):
    python fusion.py --a camara_frontal.jsonl --b camara_trasera.jsonl
"""
import argparse
import json

DIF_MAXIMA = 10  # diferencia cruda que huele a cámara tapada/caída
ORDEN = {"VACÍO": 0, "MEDIO": 1, "LLENO": 2}


def fusionar(estado_a: str, estado_b: str, n_a: int, n_b: int):
    """Devuelve (estado, confianza, outlier). Nunca inventa pasajeros:
    el máximo es cota inferior del total real."""
    outlier = abs(n_a - n_b) > DIF_MAXIMA
    if estado_a == estado_b:
        return estado_a, "alta", outlier
    ganador = estado_a if ORDEN[estado_a] > ORDEN[estado_b] else estado_b
    return ganador, "media", outlier


def _ultima(ruta: str) -> dict:
    with open(ruta, encoding="utf-8") as f:
        lineas = [l for l in f if l.strip()]
    if not lineas:
        raise SystemExit(f"sin mediciones en {ruta}")
    return json.loads(lineas[-1])


def main() -> None:
    p = argparse.ArgumentParser(description="Fusiona 2 cámaras a un estado.")
    p.add_argument("--a", required=True, help="JSONL cámara frontal")
    p.add_argument("--b", required=True, help="JSONL cámara trasera")
    a = p.parse_args()
    ma, mb = _ultima(a.a), _ultima(a.b)
    estado, confianza, outlier = fusionar(
        ma["estado_ocupacion"], mb["estado_ocupacion"],
        ma["conteo_crudo"], mb["conteo_crudo"],
    )
    print(json.dumps({
        "estado": estado,
        "confianza": confianza,
        "outlier": outlier,
        "detalle": {"frontal": ma, "trasera": mb},
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
