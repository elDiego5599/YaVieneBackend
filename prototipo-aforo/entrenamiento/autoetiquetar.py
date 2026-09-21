#!/usr/bin/env python3
"""Pre-etiqueta fotos con yolo11m (COCO) para corregir a mano después.

El truco para no etiquetar desde cero: el COCO pelado ya encuentra a la
mitad de la gente; tú solo BORRAS falsos positivos y AGREGAS los sentados
que no vio, en Roboflow o LabelImg. Ahorra ~70% del tiempo.

Uso:
    python autoetiquetar.py --fotos dataset/crudo --salida dataset/pre --conf 0.30
Salida: dataset/pre/*.txt en formato YOLO (una línea por persona: 0 cx cy w h).
Revisa el --conf BAJO (0.25-0.30): mejor que sobren cajas para borrar que
que falten personas por agregar.
"""
import argparse
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--fotos", required=True)
    p.add_argument("--salida", required=True)
    p.add_argument("--conf", type=float, default=0.30)
    a = p.parse_args()

    from ultralytics import YOLO

    model = YOLO("yolo11m.pt")
    fotos = sorted(Path(a.fotos).glob("*.jpg"))
    out = Path(a.salida)
    out.mkdir(parents=True, exist_ok=True)
    for f in fotos:
        r = model.predict(source=str(f), classes=[0], conf=a.conf,
                          device=0, half=True, verbose=False)[0]
        lineas = []
        if r.boxes is not None:
            for b in r.boxes.xywhn.cpu().numpy():
                cx, cy, w, h = b
                lineas.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        (out / (f.stem + ".txt")).write_text("\n".join(lineas),
                                             encoding="utf-8")
    print(f"{len(fotos)} fotos pre-etiquetadas en {out}. "
          f"Súbelas con sus .jpg a Roboflow/LabelImg y corrige.", flush=True)


if __name__ == "__main__":
    main()
