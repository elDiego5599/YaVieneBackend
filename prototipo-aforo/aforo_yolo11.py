#!/usr/bin/env python3
"""Aforo en vivo de buses Ya Viene con YOLO11 (prototipo, fuera de los repos).

Procesa 1 fotograma cada 2 s desde un video local o un RTSP (cámara del bus),
cuenta personas (COCO clase 0), estabiliza con promedio móvil de 5 conteos y
emite JSONL + ventana OpenCV con el estado VACÍO / MEDIO / LLENO.

Uso:
    python aforo_yolo11.py --source 0.mp4
    python aforo_yolo11.py --source rtsp://usuario:clave@ip:554/camara --no-show --save-jsonl aforo.jsonl

Requiere (solo en la máquina con GPU, NO en este Mac):
    pip install -r requirements.txt   # torch con CUDA, ultralytics, opencv, numpy
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

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

VACIO_MAX = 5       # promedio < 5  -> VACÍO  (calibrar por tipología de bus)
LLENO_MIN = 15      # promedio > 15 -> LLENO  (buseta vs bus padrón difieren)


@dataclass
class Config:
    source: str
    stride_seconds: float = 2.0
    conf: float = 0.40
    imgsz: int = 640
    model_name: str = "yolo11m.pt"
    device: str = "cuda:0"
    half: bool = True
    ventana: int = 5
    show: bool = True
    save_jsonl: str | None = None
    max_reconnect: int = 5


# ---------------------------------------------------------------------------
# Ingesta de video (archivo local o RTSP, misma interfaz)
# ---------------------------------------------------------------------------

class VideoSource:
    """Lee el stream y decide qué fotogramas se procesan (1 cada N segundos).

    El salto se calcula con los FPS reales del video: stride = round(fps * 2).
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
        """Devuelve (frame, tiempo_video_s) o (None, None) al agotarse/cortarse."""
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
# Detección (YOLO11 en CUDA:0, FP16)
# ---------------------------------------------------------------------------

class Detector:
    """YOLO11 Medium, solo clase 0 (person). Falla en voz alta sin CUDA."""

    def __init__(self, cfg: Config) -> None:
        import torch
        from ultralytics import YOLO

        if not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA no disponible: instala torch con CUDA en la máquina "
                "con la RTX 5070 (en este Mac no hay NVIDIA y no corre)."
            )
        torch.cuda.set_device(cfg.device)
        nombre = torch.cuda.get_device_name(0)
        cap = torch.cuda.get_device_capability(0)
        print(f"[gpu] {nombre} (capability {cap[0]}.{cap[1]})", flush=True)
        # Blackwell es sm_120: exige torch reciente (≥2.8) con CUDA ≥12.8.
        # Si la capability reportada es 0.0, el torch no conoce la tarjeta:
        # actualiza torch antes de culpar al script.
        if cap < (7, 5):
            print("[gpu] aviso: capability < 7.5, FP16 por Tensor Cores "
                  "puede no aplicar; sigo en FP32.", flush=True)
            cfg.half = False
        # El .pt se descarga solo la primera vez (necesita internet una vez).
        self.model = YOLO(cfg.model_name)
        self.cfg = cfg
        print(f"[modelo] {cfg.model_name} en {cfg.device} "
              f"({'FP16' if cfg.half else 'FP32'})", flush=True)

    def contar(self, frame):
        """Devuelve (conteo_personas, cajas_xyxy)."""
        res = self.model.predict(
            source=frame,
            classes=[0],            # solo 'person' de COCO
            conf=self.cfg.conf,
            imgsz=self.cfg.imgsz,
            half=self.cfg.half,
            device=self.cfg.device,
            verbose=False,
        )[0]
        cajas = res.boxes.xyxy.cpu().numpy() if res.boxes is not None else []
        return len(cajas), cajas


# ---------------------------------------------------------------------------
# Fusión y estabilización (promedio móvil de 5 + umbrales)
# ---------------------------------------------------------------------------

@dataclass
class Medicion:
    timestamp: str
    conteo_crudo: int
    conteo_promediado: float
    estado_ocupacion: str


class Suavizador:
    """Promedio móvil de los últimos N conteos: tapa parpadeos y oclusiones
    de un segundo (alguien pasa frente a la cámara) sin reaccionar tarde:
    con 1 frame/2 s, 5 muestras = 10 s de memoria."""

    def __init__(self, ventana: int = 5) -> None:
        self._cola: deque[int] = deque(maxlen=ventana)

    def agregar(self, conteo: int, tiempo_video_s: float) -> Medicion:
        self._cola.append(conteo)
        prom = sum(self._cola) / len(self._cola)
        if prom < VACIO_MAX:
            estado = "VACÍO"
        elif prom <= LLENO_MIN:
            estado = "MEDIO"
        else:
            estado = "LLENO"
        return Medicion(
            timestamp=datetime.now(timezone.utc).isoformat(),
            conteo_crudo=conteo,
            conteo_promediado=round(prom, 1),
            estado_ocupacion=estado,
        )


# ---------------------------------------------------------------------------
# Salida: JSONL + ventana OpenCV
# ---------------------------------------------------------------------------

BANNER = "Ya Viene AMBQ | Pasajeros: {n} | Estado: {estado}"
VERDE = (0, 200, 0)
AMARILLO = (0, 220, 220)
ROJO = (0, 0, 255)

COLORES = {"VACÍO": VERDE, "MEDIO": AMARILLO, "LLENO": ROJO}


class Visualizador:
    def __init__(self, mostrar: bool) -> None:
        self.mostrar = mostrar
        self._cv2 = None
        if mostrar:
            import cv2
            self._cv2 = cv2

    def dibujar(self, frame, cajas, med: Medicion) -> None:
        if not self.mostrar:
            return
        cv2 = self._cv2
        for (x1, y1, x2, y2) in cajas:
            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)),
                          COLORES[med.estado_ocupacion], 2)
        texto = BANNER.format(n=med.conteo_crudo, estado=med.estado_ocupacion)
        cv2.rectangle(frame, (0, 0), (frame.shape[1], 40), (0, 0, 0), -1)
        cv2.putText(frame, texto, (10, 27), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.imshow("Ya Viene - aforo", frame)

    def tecla_q(self) -> bool:
        return self.mostrar and (self._cv2.waitKey(1) & 0xFF == ord("q"))

    def cerrar(self) -> None:
        if self.mostrar:
            self._cv2.destroyAllWindows()


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> Config:
    p = argparse.ArgumentParser(description="Aforo Ya Viene con YOLO11.")
    p.add_argument("--source", required=True,
                   help="video local (.mp4) o RTSP de la cámara del bus")
    p.add_argument("--cada-segundos", type=float, default=2.0)
    p.add_argument("--conf", type=float, default=0.40)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--modelo", default="yolo11m.pt")
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--fp32", action="store_true", help="desactiva FP16")
    p.add_argument("--no-show", action="store_true")
    p.add_argument("--save-jsonl", default=None)
    a = p.parse_args(argv)
    return Config(
        source=a.source, stride_seconds=a.cada_segundos, conf=a.conf,
        imgsz=a.imgsz, model_name=a.modelo, device=a.device,
        half=not a.fp32, show=not a.no_show, save_jsonl=a.save_jsonl,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    fuente = VideoSource(cfg)
    detector = Detector(cfg)
    suavizador = Suavizador(cfg.ventana)
    vista = Visualizador(cfg.show)
    salida = open(cfg.save_jsonl, "a", encoding="utf-8") if cfg.save_jsonl else None
    try:
        while True:
            frame, t_video = fuente.read()
            if frame is None:
                print("[video] fin del stream.", flush=True)
                break
            if frame is False:
                if vista.tecla_q():
                    break
                continue
            conteo, cajas = detector.contar(frame)
            med = suavizador.agregar(conteo, t_video)
            linea = json.dumps(med.__dict__, ensure_ascii=False)
            print(linea, flush=True)
            if salida is not None:
                salida.write(linea + "\n")
                salida.flush()
            vista.dibujar(frame, cajas, med)
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
