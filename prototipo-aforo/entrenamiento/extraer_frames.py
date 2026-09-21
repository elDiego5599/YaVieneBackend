#!/usr/bin/env python3
"""Saca fotos de los videos de las cámaras del bus para etiquetar.

Graba 2-5 min por cámara y escenario (vacío, medio, lleno, día, noche) y
extrae 1 frame cada N segundos. OJO: frames consecutivos se parecen mucho;
mejor poco video de MUCHAS situaciones que mucho video de una sola.

Uso:
    python extraer_frames.py --video camara_frontal_lleno.mp4 --salida dataset/crudo --cada-segundos 3
"""
import argparse
from pathlib import Path

import cv2


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True)
    p.add_argument("--salida", required=True)
    p.add_argument("--cada-segundos", type=float, default=3.0)
    a = p.parse_args()

    cap = cv2.VideoCapture(a.video)
    if not cap.isOpened():
        raise SystemExit(f"no abre: {a.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    stride = max(1, round(fps * a.cada_segundos))
    base = Path(a.video).stem
    out = Path(a.salida)
    out.mkdir(parents=True, exist_ok=True)

    i = n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % stride == 0:
            cv2.imwrite(str(out / f"{base}_{n:04d}.jpg"), frame,
                        [cv2.IMWRITE_JPEG_QUALITY, 92])
            n += 1
        i += 1
    cap.release()
    print(f"{n} fotos en {out} (stride {stride}, fps {fps:.1f})")


if __name__ == "__main__":
    main()
