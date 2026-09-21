#!/usr/bin/env python3
"""Entrena YOLO11m en interiores de bus (SOLO en la torre con la RTX 5070).

Transfer learning: parte de yolo11m.pt (COCO) y afina SOLO la cabeza de
detección para cabezas/hombros sentados y ocluidos. Con 300-800 fotos
bien variadas (día/noche, vacío/lleno, ambas cámaras) ya se nota el salto
frente al COCO pelado.

Uso:
    python train.py --data data.yaml --epochs 100
El mejor peso queda en runs/aforo/bus_<fecha>/weights/best.pt -> ese .pt
es el que luego usa aforo_yolo11.py con --modelo.
"""
import argparse
from datetime import datetime


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", default="data.yaml")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--batch", type=int, default=32,
                   help="12 GB VRAM aguantan 32 a 640px; si OOM, baja a 16")
    a = p.parse_args()

    import torch
    from ultralytics import YOLO

    assert torch.cuda.is_available(), "sin CUDA no hay entrenamiento"
    print("GPU:", torch.cuda.get_device_name(0),
          torch.cuda.get_device_capability(0), flush=True)

    model = YOLO("yolo11m.pt")
    model.train(
        data=a.data,
        epochs=a.epochs,
        imgsz=a.imgsz,
        batch=a.batch,
        device=0,
        half=True,            # Tensor Cores de la 5070
        patience=20,          # early stopping: para si no mejora en 20 épocas
        workers=8,
        cache="ram",          # dataset cabe en RAM -> dataloader no espera disco
        project="runs/aforo",
        name="bus_" + datetime.now().strftime("%Y%m%d_%H%M"),
        exist_ok=False,
        verbose=True,
    )
    print("Listo. Usa weights/best.pt en el script de inferencia.", flush=True)


if __name__ == "__main__":
    main()
