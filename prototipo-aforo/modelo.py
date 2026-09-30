"""Lo que comparten el entrenamiento y la inferencia del aforo.

Un solo lugar para las clases, la arquitectura, el preprocesado y el
formato del peso guardado: si el entrenamiento y la inferencia los
tuvieran cada uno por su lado, un cambio en uno solo (el tamaño de la
imagen, la normalización, el orden de las clases) daría estados
equivocados sin ningún error. torch y torchvision se importan dentro de
las funciones: así las pruebas de lo demás corren sin ellos.
"""
from __future__ import annotations

# Orden ordinal: el índice ES el nivel (0 < 1 < 2). La regla de decisión
# y la fusión dependen de este orden; no lo cambies sin cambiar ambas.
ESTADOS = ("VACÍO", "MEDIO", "LLENO")

# Carpetas del dataset, en el mismo orden que ESTADOS. Sin tildes: rutas
# de Windows y zips no siempre las respetan.
CARPETAS = ("vacio", "medio", "lleno")

# Tamaño nativo de cada variante (el que usó su entrenamiento en ImageNet).
# B0 es el punto de partida; B2 y V2-S solo si B0 se queda corto en val.
ARQUITECTURAS = {
    "efficientnet_b0": 224,
    "efficientnet_b2": 260,
    "efficientnet_v2_s": 384,
}

# Normalización de ImageNet: la que esperan los pesos preentrenados.
MEDIA = (0.485, 0.456, 0.406)
DESVIACION = (0.229, 0.224, 0.225)

FORMATO_PESO = 1  # sube si cambia lo que guarda `guardar`

EXTENSIONES = (".jpg", ".jpeg", ".png")


def listar_fotos(raiz) -> list[tuple["Path", int]]:
    """(foto, nivel) de `raiz/<vacio|medio|lleno>/*`, en orden estable.

    Cualquier otra carpeta (p. ej. `descartadas/`, las fotos que no se
    pudieron etiquetar con seguridad) se ignora a propósito."""
    from pathlib import Path

    raiz = Path(raiz)
    fotos = []
    for nivel, carpeta in enumerate(CARPETAS):
        d = raiz / carpeta
        if d.is_dir():
            fotos += [(f, nivel) for f in sorted(d.iterdir())
                      if f.is_file() and f.suffix.lower() in EXTENSIONES]
    return fotos


def construir(arquitectura: str, imagenet: bool = True):
    """EfficientNet de torchvision con la última capa cambiada a 3 clases."""
    if arquitectura not in ARQUITECTURAS:
        raise ValueError(f"arquitectura debe ser una de: {', '.join(ARQUITECTURAS)}")
    import torch.nn as nn
    from torchvision import models

    fabrica = getattr(models, arquitectura)
    pesos = "DEFAULT" if imagenet else None
    red = fabrica(weights=pesos)
    # En las tres variantes la cabeza es Sequential(Dropout, Linear).
    lineal = red.classifier[-1]
    red.classifier[-1] = nn.Linear(lineal.in_features, len(ESTADOS))
    return red


def transformaciones(imgsz: int, entrenamiento: bool):
    """Preprocesado de torchvision. El de entrenamiento aumenta los datos
    con lo que de verdad cambia entre fotos de un mismo bus: la luz (día,
    noche, sol por la ventana), un leve encuadre distinto y el espejo. No
    hay giro vertical: un bus al revés no existe."""
    from torchvision import transforms as T

    normalizar = T.Normalize(MEDIA, DESVIACION)
    if entrenamiento:
        return T.Compose([
            T.RandomResizedCrop(imgsz, scale=(0.80, 1.0), ratio=(0.9, 1.1)),
            T.RandomHorizontalFlip(),
            T.RandomRotation(5),
            T.ColorJitter(brightness=0.4, contrast=0.3, saturation=0.3, hue=0.02),
            T.ToTensor(),
            normalizar,
        ])
    return T.Compose([
        T.Resize((imgsz, imgsz)),
        T.ToTensor(),
        normalizar,
    ])


def guardar(ruta, red, arquitectura: str, imgsz: int, metricas: dict) -> None:
    import torch

    torch.save({
        "formato": FORMATO_PESO,
        "arquitectura": arquitectura,
        "imgsz": imgsz,
        "estados": list(ESTADOS),
        "pesos": red.state_dict(),
        "metricas": metricas,
    }, ruta)


def cargar(ruta, dispositivo: str = "cpu"):
    """Devuelve (red en modo eval, imgsz). Falla en voz alta si el peso no
    es de este formato o trae otras clases: mejor no arrancar que publicar
    estados con las clases corridas."""
    import torch

    datos = torch.load(ruta, map_location=dispositivo, weights_only=True)
    if datos.get("formato") != FORMATO_PESO:
        raise ValueError(f"{ruta}: formato {datos.get('formato')!r}, se esperaba {FORMATO_PESO}")
    if tuple(datos.get("estados", ())) != ESTADOS:
        raise ValueError(f"{ruta}: clases {datos.get('estados')!r}, se esperaban {list(ESTADOS)}")
    red = construir(datos["arquitectura"], imagenet=False)
    red.load_state_dict(datos["pesos"])
    red.to(dispositivo).eval()
    return red, int(datos["imgsz"])


def elegir_dispositivo(pedido: str = "auto") -> str:
    """auto: CUDA (la torre) > MPS (Mac) > CPU. B0 corre bien en CPU."""
    if pedido != "auto":
        return pedido
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
