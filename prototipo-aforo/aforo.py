#!/usr/bin/env python3
"""Aforo en vivo de buses Ya Viene con un clasificador EfficientNet.

Mira 1 fotograma cada N segundos de un video local o un RTSP (la cámara del
bus o la plataforma de video de la empresa), lo clasifica en VACÍO / MEDIO /
LLENO, promedia las probabilidades de los últimos fotogramas y emite JSONL
(más una ventana OpenCV si se pide).

No cuenta personas: en un bus lleno la gente se tapa entre sí y un detector
cuenta de menos justo cuando más importa. Un clasificador aprende cómo se ve
un bus lleno. El porqué de EfficientNet está en README.md.

Tira pa abajo a propósito: un estado alto necesita más evidencia que uno
bajo (ver `decidir`). Decir «lleno» de un bus con espacio le quita pasajeros
a la empresa.

Uso:
    python aforo.py --source prueba.mp4 --modelo runs/aforo/<fecha>/best.pt
    python aforo.py --source rtsp://ip:554/camara --modelo best.pt --no-show --save-jsonl aforo.jsonl

La foto se procesa en memoria y se descarta: al JSONL solo salen el estado
y sus probabilidades, nunca la imagen (Ley 1581: la imagen de un pasajero
es un dato personal).
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

from modelo import ESTADOS

# ---------------------------------------------------------------------------
# Regla de decisión: tirar pa abajo
# ---------------------------------------------------------------------------

# Provisionales hasta calibrarlos con `entrenamiento/evaluar.py --barrer`
# sobre fotos reales. Los dos pasan de 0,5 a propósito: con una red dudosa
# entre dos estados, gana el más bajo.
UMBRAL_LLENO = 0.80   # P(LLENO) mínima para decir LLENO
UMBRAL_MEDIO = 0.60   # P(MEDIO o más) mínima para decir MEDIO


def decidir(probs, umbral_lleno: float = UMBRAL_LLENO,
            umbral_medio: float = UMBRAL_MEDIO) -> str:
    """Estado a partir de las probabilidades (vacío, medio, lleno).

    Se mira la probabilidad ACUMULADA de «al menos este nivel», de arriba
    abajo: LLENO si P(lleno) ≥ umbral_lleno; si no, MEDIO si
    P(medio) + P(lleno) ≥ umbral_medio; si no, VACÍO. Por eso (0,30, 0,10,
    0,60) sale MEDIO y no LLENO: hay 70 % de que vaya al menos medio, pero
    solo 60 % de que vaya lleno, y eso no alcanza para decirlo.
    """
    if len(probs) != len(ESTADOS):
        raise ValueError(f"se esperaban {len(ESTADOS)} probabilidades, llegaron {len(probs)}")
    _, p_medio, p_lleno = (float(p) for p in probs)
    if p_lleno >= umbral_lleno:
        return "LLENO"
    if p_medio + p_lleno >= umbral_medio:
        return "MEDIO"
    return "VACÍO"


# ---------------------------------------------------------------------------
# Suavizado: promedio móvil de las probabilidades
# ---------------------------------------------------------------------------

@dataclass
class Medicion:
    timestamp: str
    estado_ocupacion: str
    probs: list[float]                # promediadas: (vacío, medio, lleno)
    probs_crudas: list[float] = field(default_factory=list)  # solo este fotograma


class Suavizador:
    """Promedia las probabilidades de los últimos N fotogramas antes de
    decidir. Tapa el parpadeo de un fotograma raro (alguien pasa pegado a la
    cámara) sin reaccionar tarde: a 1 foto cada 2 s, 5 muestras son 10 s.

    Se promedian probabilidades, no estados: dos fotos «casi llenas» y tres
    «medias» no son lo mismo que cinco «medias», y el promedio lo nota."""

    def __init__(self, ventana: int = 5, umbral_lleno: float = UMBRAL_LLENO,
                 umbral_medio: float = UMBRAL_MEDIO) -> None:
        if ventana < 1:
            raise ValueError("la ventana debe ser de al menos 1 fotograma")
        self._cola: deque[tuple[float, ...]] = deque(maxlen=ventana)
        self.umbral_lleno = umbral_lleno
        self.umbral_medio = umbral_medio

    def agregar(self, probs) -> Medicion:
        crudas = tuple(float(p) for p in probs)
        if len(crudas) != len(ESTADOS):
            raise ValueError(f"se esperaban {len(ESTADOS)} probabilidades, llegaron {len(crudas)}")
        self._cola.append(crudas)
        n = len(self._cola)
        prom = [sum(p[i] for p in self._cola) / n for i in range(len(ESTADOS))]
        return Medicion(
            timestamp=datetime.now(timezone.utc).isoformat(),
            estado_ocupacion=decidir(prom, self.umbral_lleno, self.umbral_medio),
            # float() antes de round(): un float32 de numpy no es serializable
            # a JSON y trae el error binario pegado.
            probs=[round(float(p), 3) for p in prom],
            probs_crudas=[round(float(p), 3) for p in crudas],
        )


# ---------------------------------------------------------------------------
# Ingesta de video (archivo local o RTSP, misma interfaz)
# ---------------------------------------------------------------------------

@dataclass
class Config:
    source: str
    modelo: str = ""
    stride_seconds: float = 2.0
    ventana: int = 5
    umbral_lleno: float = UMBRAL_LLENO
    umbral_medio: float = UMBRAL_MEDIO
    device: str = "auto"
    show: bool = True
    save_jsonl: str | None = None
    max_reconnect: int = 5


class VideoSource:
    """Lee el stream y decide qué fotogramas se procesan (1 cada N segundos).

    El salto se calcula con los FPS reales del video: stride = round(fps * N).
    Si el origen no reporta FPS (RTSP intermitente), se asume 30.
    """

    def __init__(self, cfg: Config) -> None:
        import cv2  # import tardío: el error sale solo al usarse

        self._cv2 = cv2
        self.cfg = cfg
        self.cap = None
        self.fps = 30.0
        self.stride = 60
        self.idx = 0
        self._open()

    def _open(self) -> None:
        for intento in range(1, self.cfg.max_reconnect + 1):
            cap = self._cv2.VideoCapture(self.cfg.source)
            if cap.isOpened():
                self.cap = cap
                fps = cap.get(self._cv2.CAP_PROP_FPS)
                if fps and fps == fps and fps > 0:  # descarta NaN y 0
                    self.fps = float(fps)
                self.stride = max(1, round(self.fps * self.cfg.stride_seconds))
                print(
                    f"[video] abierto (intento {intento}): "
                    f"fps={self.fps:.1f} stride={self.stride} "
                    f"~= 1 frame cada {self.stride / self.fps:.1f}s",
                    flush=True,
                )
                return
            print(f"[video] no abre, reintento {intento}/{self.cfg.max_reconnect}…",
                  flush=True)
            time.sleep(min(2 ** intento, 10))
        raise RuntimeError(f"no se pudo abrir la fuente: {self.cfg.source}")

    def read(self):
        """Devuelve (frame, tiempo_video_s), (False, None) si se salta o
        (None, None) al agotarse/cortarse."""
        ok, frame = self.cap.read()
        if not ok:
            return None, None
        idx = self.idx
        self.idx += 1
        if idx % self.stride != 0:
            return False, None  # saltado: no se procesa
        return frame, idx / self.fps

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None


# ---------------------------------------------------------------------------
# Clasificador (EfficientNet de torchvision, peso de entrenamiento/train.py)
# ---------------------------------------------------------------------------

class Clasificador:
    def __init__(self, cfg: Config) -> None:
        import torch

        from modelo import cargar, elegir_dispositivo, transformaciones

        self._torch = torch
        self.dispositivo = elegir_dispositivo(cfg.device)
        self.red, imgsz = cargar(cfg.modelo, self.dispositivo)
        self.preprocesar = transformaciones(imgsz, entrenamiento=False)
        print(f"[modelo] {cfg.modelo} en {self.dispositivo} ({imgsz}px)", flush=True)

    def probabilidades(self, frame_bgr) -> list[float]:
        from PIL import Image

        rgb = Image.fromarray(frame_bgr[:, :, ::-1].copy())  # OpenCV da BGR
        x = self.preprocesar(rgb).unsqueeze(0).to(self.dispositivo)
        with self._torch.inference_mode():
            logits = self.red(x)
        return self._torch.softmax(logits.float(), dim=1)[0].cpu().tolist()


# ---------------------------------------------------------------------------
# Salida: ventana OpenCV
# ---------------------------------------------------------------------------

BANNER = "Ya Viene AMBQ | Estado: {estado} | P(lleno) {p:.2f}"
COLORES = {"VACÍO": (0, 200, 0), "MEDIO": (0, 220, 220), "LLENO": (0, 0, 255)}


class Visualizador:
    def __init__(self, mostrar: bool) -> None:
        self.mostrar = mostrar
        self._cv2 = None
        if mostrar:
            import cv2
            self._cv2 = cv2

    def dibujar(self, frame, med: Medicion) -> None:
        if not self.mostrar:
            return
        cv2 = self._cv2
        texto = BANNER.format(estado=med.estado_ocupacion, p=med.probs[2])
        cv2.rectangle(frame, (0, 0), (frame.shape[1], 40),
                      COLORES[med.estado_ocupacion], -1)
        cv2.putText(frame, texto, (10, 27), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (0, 0, 0), 2, cv2.LINE_AA)
        cv2.imshow("Ya Viene - aforo", frame)

    def tecla_q(self) -> bool:
        return self.mostrar and (self._cv2.waitKey(1) & 0xFF == ord("q"))

    def cerrar(self) -> None:
        if self.mostrar:
            self._cv2.destroyAllWindows()


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def _umbral(texto: str) -> float:
    valor = float(texto)
    if not 0.0 < valor <= 1.0:
        raise argparse.ArgumentTypeError("debe estar entre 0 (sin incluir) y 1")
    return valor


def parse_args(argv: list[str] | None = None) -> Config:
    p = argparse.ArgumentParser(description="Aforo Ya Viene con EfficientNet.")
    p.add_argument("--source", required=True,
                   help="video local (.mp4) o RTSP de la cámara del bus")
    p.add_argument("--modelo", required=True,
                   help="best.pt que deja entrenamiento/train.py")
    p.add_argument("--cada-segundos", type=float, default=2.0)
    p.add_argument("--ventana", type=int, default=5,
                   help="fotogramas que se promedian antes de decidir")
    p.add_argument("--umbral-lleno", type=_umbral, default=UMBRAL_LLENO)
    p.add_argument("--umbral-medio", type=_umbral, default=UMBRAL_MEDIO)
    p.add_argument("--device", default="auto", help="auto | cuda | mps | cpu")
    p.add_argument("--no-show", action="store_true")
    p.add_argument("--save-jsonl", default=None)
    a = p.parse_args(argv)
    if a.cada_segundos <= 0:
        p.error("--cada-segundos debe ser mayor que 0")
    if a.ventana < 1:
        p.error("--ventana debe ser de al menos 1")
    return Config(
        source=a.source, modelo=a.modelo, stride_seconds=a.cada_segundos,
        ventana=a.ventana, umbral_lleno=a.umbral_lleno,
        umbral_medio=a.umbral_medio, device=a.device, show=not a.no_show,
        save_jsonl=a.save_jsonl,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    clasificador = Clasificador(cfg)  # antes que el video: un peso malo falla ya
    fuente = VideoSource(cfg)
    suavizador = Suavizador(cfg.ventana, cfg.umbral_lleno, cfg.umbral_medio)
    vista = Visualizador(cfg.show)
    salida = open(cfg.save_jsonl, "a", encoding="utf-8") if cfg.save_jsonl else None
    try:
        while True:
            frame, _ = fuente.read()
            if frame is None:
                print("[video] fin del stream.", flush=True)
                break
            if frame is False:
                if vista.tecla_q():
                    break
                continue
            med = suavizador.agregar(clasificador.probabilidades(frame))
            linea = json.dumps(med.__dict__, ensure_ascii=False)
            print(linea, flush=True)
            if salida is not None:
                salida.write(linea + "\n")
                salida.flush()
            vista.dibujar(frame, med)
            if vista.tecla_q():
                break
    except KeyboardInterrupt:
        print("\n[fin] interrumpido por el usuario.", flush=True)
    finally:
        fuente.release()
        vista.cerrar()
        if salida is not None:
            salida.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
