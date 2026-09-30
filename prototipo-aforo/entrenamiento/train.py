#!/usr/bin/env python3
"""Ajusta EfficientNet (preentrenada en ImageNet) a VACÍO / MEDIO / LLENO.

Transfer learning en dos tiempos:
  1. Calentamiento (`--calentar` épocas): el cuerpo de la red congelado,
     solo aprende la cabeza nueva. Así la cabeza, que arranca al azar, no
     destroza con gradientes grandes lo que el cuerpo ya sabe de ImageNet.
  2. Ajuste fino: todo se entrena; el cuerpo con 1/10 del paso de la cabeza.

Pérdida con pesos por clase (LLENO suele ser la escasa). Se guarda el peso
de la época con mejor macro-F1 en val; empate -> menos sobreestimación. Se
para si `--paciencia` épocas seguidas no mejoran.

Uso (en la torre con la RTX 5070; en el Mac también corre, más lento):
    python train.py --datos dataset/partido
    python train.py --datos dataset/partido --arch efficientnet_b2 --epocas 40
Sale: runs/aforo/<fecha>/best.pt  +  metricas.json
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from evaluar import metricas  # noqa: E402
from modelo import (ARQUITECTURAS, ESTADOS, construir, elegir_dispositivo,  # noqa: E402
                    guardar, listar_fotos, transformaciones)


class Fotos:
    """Dataset de torch (le basta __len__ y __getitem__). Va a nivel de
    módulo y no dentro de main: en macOS y Windows los workers del
    DataLoader arrancan con «spawn» y necesitan poder importarlo."""

    def __init__(self, raiz: Path, tf):
        self.items = listar_fotos(raiz)
        self.tf = tf

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        from PIL import Image

        foto, nivel = self.items[i]
        with Image.open(foto) as img:
            return self.tf(img.convert("RGB")), nivel


def pesos_por_clase(niveles: list[int]) -> list[float]:
    """Inverso de la frecuencia, normalizado a media 1. Clase sin fotos -> 0
    (no hay nada que pesar; el aviso lo da el split)."""
    conteo = [niveles.count(c) for c in range(len(ESTADOS))]
    presentes = [c for c in conteo if c]
    if not presentes:
        raise ValueError("no hay fotos")
    total = sum(conteo)
    crudos = [total / (len(presentes) * c) if c else 0.0 for c in conteo]
    return [round(w, 6) for w in crudos]


def _entero_positivo(texto: str) -> int:
    v = int(texto)
    if v < 1:
        raise argparse.ArgumentTypeError("debe ser ≥ 1")
    return v


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Entrena el clasificador de aforo.")
    p.add_argument("--datos", required=True, help="salida de split_dataset.py (train/ y val/)")
    p.add_argument("--arch", default="efficientnet_b0", choices=list(ARQUITECTURAS))
    p.add_argument("--epocas", type=_entero_positivo, default=30)
    p.add_argument("--calentar", type=int, default=3, help="épocas con el cuerpo congelado")
    p.add_argument("--lote", type=_entero_positivo, default=32)
    p.add_argument("--lr", type=float, default=1e-3, help="paso de la cabeza; el cuerpo usa lr/10")
    p.add_argument("--paciencia", type=_entero_positivo, default=8)
    p.add_argument("--semilla", type=int, default=42)
    p.add_argument("--device", default="auto")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--salida", default=str(RAIZ / "runs" / "aforo"))
    p.add_argument("--sin-imagenet", action="store_true",
                   help="arranca sin pesos de ImageNet (solo para humo/sin red)")
    a = p.parse_args(argv)
    if a.calentar < 0 or a.calentar >= a.epocas:
        p.error("--calentar debe estar en [0, --epocas)")
    if a.lr <= 0:
        p.error("--lr debe ser > 0")
    return a


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    import torch
    from torch import nn
    from torch.utils.data import DataLoader

    random.seed(a.semilla)
    torch.manual_seed(a.semilla)

    datos = Path(a.datos)
    imgsz = ARQUITECTURAS[a.arch]
    train = Fotos(datos / "train", transformaciones(imgsz, entrenamiento=True))
    val = Fotos(datos / "val", transformaciones(imgsz, entrenamiento=False))
    if not len(train) or not len(val):
        raise SystemExit(f"faltan fotos en {datos}/train o {datos}/val (usa split_dataset.py)")

    dispositivo = elegir_dispositivo(a.device)
    cuda = dispositivo == "cuda"
    cargar_t = DataLoader(train, batch_size=a.lote, shuffle=True, num_workers=a.workers,
                          pin_memory=cuda, drop_last=len(train) > a.lote)
    cargar_v = DataLoader(val, batch_size=a.lote, num_workers=a.workers, pin_memory=cuda)

    red = construir(a.arch, imagenet=not a.sin_imagenet).to(dispositivo)
    cabeza = list(red.classifier.parameters())
    ids_cabeza = {id(q) for q in cabeza}
    cuerpo = [q for q in red.parameters() if id(q) not in ids_cabeza]

    pesos = pesos_por_clase([n for _, n in train.items])
    perdida = nn.CrossEntropyLoss(weight=torch.tensor(pesos, device=dispositivo))
    opt = torch.optim.AdamW([{"params": cuerpo, "lr": a.lr / 10},
                             {"params": cabeza, "lr": a.lr}], weight_decay=1e-4)
    plan = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=a.epocas)
    escalador = torch.amp.GradScaler("cuda", enabled=cuda)

    carpeta = Path(a.salida) / datetime.now().strftime("%Y%m%d-%H%M%S")
    carpeta.mkdir(parents=True, exist_ok=False)
    print(f"{a.arch} {imgsz}px en {dispositivo}  train={len(train)} val={len(val)}  "
          f"pesos={pesos}  -> {carpeta}", flush=True)

    mejor_clave, mejor, sin_mejorar, historia = None, None, 0, []
    for epoca in range(1, a.epocas + 1):
        congelado = epoca <= a.calentar
        for q in cuerpo:
            q.requires_grad_(not congelado)

        red.train()
        suma, vistos = 0.0, 0
        for x, y in cargar_t:
            x, y = x.to(dispositivo, non_blocking=True), y.to(dispositivo, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.autocast("cuda", enabled=cuda):
                costo = perdida(red(x), y)
            escalador.scale(costo).backward()
            escalador.step(opt)
            escalador.update()
            suma += costo.item() * len(y)
            vistos += len(y)
        plan.step()

        red.eval()
        reales, predichos = [], []
        with torch.inference_mode():
            for x, y in cargar_v:
                # En val se mide la cabeza cruda (argmax); los umbrales de
                # «tira pa abajo» se calibran después con evaluar.py --barrer.
                predichos += red(x.to(dispositivo)).argmax(1).cpu().tolist()
                reales += y.tolist()
        met = metricas(reales, predichos)
        historia.append({"epoca": epoca, "perdida": round(suma / vistos, 4),
                         "congelado": congelado, **{k: met[k] for k in
                         ("exactitud", "macro_f1", "sobreestimacion", "subestimacion")}})
        print(json.dumps(historia[-1], ensure_ascii=False), flush=True)

        clave = (met["macro_f1"], -met["sobreestimacion"])
        if mejor_clave is None or clave > mejor_clave:
            mejor_clave, mejor, sin_mejorar = clave, {"epoca": epoca, **met}, 0
            guardar(carpeta / "best.pt", red, a.arch, imgsz, mejor)
        else:
            sin_mejorar += 1
            if sin_mejorar >= a.paciencia and not congelado:
                print(f"sin mejora en {a.paciencia} épocas: paro en la {epoca}", flush=True)
                break

    resumen = {"arquitectura": a.arch, "imgsz": imgsz, "dispositivo": dispositivo,
               "semilla": a.semilla, "imagenet": not a.sin_imagenet,
               "pesos_clase": pesos, "mejor": mejor, "historia": historia}
    (carpeta / "metricas.json").write_text(json.dumps(resumen, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
    print(f"mejor época {mejor['epoca']}: macro-F1 {mejor['macro_f1']}  "
          f"sobreestimación {mejor['sobreestimacion']}  -> {carpeta / 'best.pt'}", flush=True)
    print("Siguiente: calibra los umbrales con evaluar.py --barrer sobre val.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
