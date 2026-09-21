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
  3. Outlier: sin capacidades, |conteoA - conteoB| > DIF_MAXIMA marca
     outlier=True (cámara tapada, sucia o caída). Con capacidades
     (--cap-a/--cap-b o campo `capacidad` del JSONL), manda la diferencia
     en puntos porcentuales: |pctA - pctB| > DIF_PP_MAX. El absoluto no
     escala (10 en sencillo es escándalo, en articulado es ruido).
     El bus sigue publicando con la cámara sana en ambos casos.

Uso como librería:
    from fusion import fusionar
    estado, confianza, outlier = fusionar("MEDIO", "VACÍO", 8, 3)
    estado, confianza, outlier = fusionar("MEDIO", "MEDIO", 20, 60,
                                          cap_a=40, cap_b=40)

Demo con dos JSONL del script de inferencia (última línea de cada uno):
    python fusion.py --a camara_frontal.jsonl --b camara_trasera.jsonl
    python fusion.py --a frontal.jsonl --b trasera.jsonl --cap-a 40 --cap-b 40
"""
import argparse
import json

DIF_MAXIMA = 10  # legado sin capacidades: diferencia cruda sospechosa
DIF_PP_MAX = 25.0  # con capacidades: puntos porcentuales sospechosos
ORDEN = {"VACÍO": 0, "MEDIO": 1, "LLENO": 2}


def fusionar(estado_a: str, estado_b: str, n_a: int, n_b: int,
             cap_a: float | None = None, cap_b: float | None = None,
             dif_pp_max: float = DIF_PP_MAX):
    """Devuelve (estado, confianza, outlier). Nunca inventa pasajeros:
    el máximo es cota inferior del total real."""
    if cap_a and cap_b:
        outlier = abs(n_a / cap_a * 100 - n_b / cap_b * 100) > dif_pp_max
    else:
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
    p.add_argument("--cap-a", type=float, default=None,
                   help="capacidad bus cámara A (si no, lee `capacidad` del JSONL)")
    p.add_argument("--cap-b", type=float, default=None)
    p.add_argument("--dif-pp", type=float, default=DIF_PP_MAX)
    a = p.parse_args()
    ma, mb = _ultima(a.a), _ultima(a.b)
    cap_a = a.cap_a if a.cap_a else ma.get("capacidad")
    cap_b = a.cap_b if a.cap_b else mb.get("capacidad")
    estado, confianza, outlier = fusionar(
        ma["estado_ocupacion"], mb["estado_ocupacion"],
        ma["conteo_crudo"], mb["conteo_crudo"],
        cap_a=cap_a, cap_b=cap_b, dif_pp_max=a.dif_pp,
    )
    print(json.dumps({
        "estado": estado,
        "confianza": confianza,
        "outlier": outlier,
        "detalle": {"frontal": ma, "trasera": mb},
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
