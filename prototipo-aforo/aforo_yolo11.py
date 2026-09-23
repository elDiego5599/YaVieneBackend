#!/usr/bin/env python3
"""Aforo en vivo de buses Ya Viene con YOLO11 (prototipo, fuera de los repos).

Procesa 1 fotograma cada 2 s desde un video local o un RTSP (cámara del bus),
cuenta personas (COCO clase 0), estabiliza con promedio móvil de 5 conteos y
emite JSONL + ventana OpenCV con el estado VACÍO / MEDIO / LLENO.

Uso:
    python aforo_yolo11.py --source 0.mp4
    python aforo_yolo11.py --source rtsp://usuario:clave@ip:554/camara --no-show --save-jsonl aforo.jsonl
    python aforo_yolo11.py --source bus.mp4 --capacidad 40 --no-show
        # con --capacidad el estado sale por % (<40 VACÍO, 40-85 MEDIO,
        # >=85 LLENO); sin ella, por conteo absoluto legado (<5/5-15/>15).

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

VACIO_MAX = 5       # modo legado (sin --capacidad): promedio < 5  -> VACÍO
LLENO_MIN = 15      # modo legado (sin --capacidad): promedio > 15 -> LLENO
VACIO_PCT = 40.0    # con --capacidad: pct < 40  -> VACÍO  (bandas dueño)
LLENO_PCT = 85.0    # con --capacidad: pct >= 85 -> LLENO  (<40 / 40-85 / >=85)

# Aforo ejemplo por tipología (sentados + de pie, números del dueño).
# --tipologia pone la capacidad default; --capacidad manda si se dan los dos.
TIPOLOGIA_AFORO = {"SENCILLO": 30.0, "PADRON": 60.0, "ARTICULADO": 80.0}


@dataclass
class Config:
    source: str
    stride_seconds: float = 2.0
    conf: float = 0.40
    iou: float = 0.70
    imgsz: int = 640
    model_name: str = "yolo11m.pt"
    device: str = "cuda:0"
    half: bool = True
    ventana: int = 5
    show: bool = True
    save_jsonl: str | None = None
    max_reconnect: int = 5
    capacidad: float | None = None  # pasajeros aprox. del bus (sentados+pie);
    vacio_pct: float = 40.0         # con capacidad: bandas <40 / 40-85 / >=85
    lleno_pct: float = 85.0         # sin capacidad: umbrales absolutos legado


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
            iou=self.cfg.iou,       # NMS: 0.9 separa mejor multitudes apiñadas
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

# ---------------------------------------------------------------------------
# Apiñado: cobertura y solape medio a partir de las cajas ya detectadas.
# Sin otro modelo: n solo no distingue "10 sentados separados" de
# "6 de pie encimados"; cobertura alta + solape alto sí. Costo ~0.
# ---------------------------------------------------------------------------

def _iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    ua = (max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
          + max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1]) - inter)
    return inter / ua if ua > 0 else 0.0


def densidad(cajas, ancho_img: int, alto_img: int) -> tuple[float, float]:
    """Devuelve (cobertura, solape_medio).

    cobertura = suma(áreas cajas) / área imagen (puede pasar de 1.0 cuando
    las cajas se enciman: eso también es señal de apiñado, no un error).
    solape_medio = IoU medio de los pares que se tocan (0.0 si <2 cajas).
    OJO perspectiva: una caja cercana es más grande; C y S se normalizan
    por cámara con video real, no se comparan entre buses distintos."""
    area_img = max(1, ancho_img * alto_img)
    areas = [max(0.0, x2 - x1) * max(0.0, y2 - y1)
             for (x1, y1, x2, y2) in (tuple(map(float, b)) for b in cajas)]
    cobertura = sum(areas) / area_img
    cajas_f = [tuple(map(float, b)) for b in cajas]
    ious = [v for v in (
        _iou(a, b) for i, a in enumerate(cajas_f) for b in cajas_f[i + 1:]
    ) if v > 0]
    solape = sum(ious) / len(ious) if ious else 0.0
    # float() ANTES de round(): el float32 ya trae error binario y
    # round() solo no lo limpia (0.15500000119 Revienta JSONL legible).
    return round(float(cobertura), 3), round(float(solape), 3)


@dataclass
class Medicion:
    timestamp: str
    conteo_crudo: int
    conteo_promediado: float
    estado_ocupacion: str
    pct_promediado: float | None = None   # prom/capacidad*100 (None sin --capacidad)
    capacidad: float | None = None
    cobertura: float = 0.0                # apiñado instantáneo del frame
    solape_medio: float = 0.0


class Suavizador:
    """Promedio móvil de los últimos N conteos: tapa parpadeos y oclusiones
    de un segundo (alguien pasa frente a la cámara) sin reaccionar tarde:
    con 1 frame/2 s, 5 muestras = 10 s de memoria.

    Con capacidad: el estado sale por % (<40 VACÍO, 40-85 MEDIO, >=85 LLENO).
    Sin capacidad: umbrales absolutos legado (<5 / 5-15 / >15)."""

    def __init__(self, ventana: int = 5, capacidad: float | None = None,
                 vacio_pct: float = VACIO_PCT, lleno_pct: float = LLENO_PCT) -> None:
        self._cola: deque[int] = deque(maxlen=ventana)
        self.capacidad = capacidad
        self.vacio_pct = vacio_pct
        self.lleno_pct = lleno_pct

    def agregar(self, conteo: int, tiempo_video_s: float,
                cobertura: float = 0.0, solape_medio: float = 0.0) -> Medicion:
        self._cola.append(conteo)
        prom = sum(self._cola) / len(self._cola)
        pct = round(prom / self.capacidad * 100, 1) if self.capacidad else None
        if pct is None:
            if prom < VACIO_MAX:
                estado = "VACÍO"
            elif prom <= LLENO_MIN:
                estado = "MEDIO"
            else:
                estado = "LLENO"
        else:
            if pct < self.vacio_pct:
                estado = "VACÍO"
            elif pct >= self.lleno_pct:
                estado = "LLENO"
            else:
                estado = "MEDIO"
        return Medicion(
            timestamp=datetime.now(timezone.utc).isoformat(),
            conteo_crudo=conteo,
            conteo_promediado=round(prom, 1),
            estado_ocupacion=estado,
            pct_promediado=pct,
            capacidad=self.capacidad,
            cobertura=cobertura,
            solape_medio=solape_medio,
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
    p.add_argument("--iou", type=float, default=0.70,
                   help="NMS: 0.9 separa mejor multitudes apiñadas (más recall)")
    p.add_argument("--capacidad", type=float, default=None,
                   help="pasajeros aprox. del bus (sentados+pie): activa bandas %%")
    p.add_argument("--tipologia", default=None,
                   help="SENCILLO|PADRON|ARTICULADO: pone capacidad 30|60|80 salvo --capacidad")
    p.add_argument("--vacio-pct", type=float, default=40.0)
    p.add_argument("--lleno-pct", type=float, default=85.0)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--modelo", default="yolo11m.pt")
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--fp32", action="store_true", help="desactiva FP16")
    p.add_argument("--no-show", action="store_true")
    p.add_argument("--save-jsonl", default=None)
    a = p.parse_args(argv)
    if a.vacio_pct >= a.lleno_pct:
        p.error("--vacio-pct debe ser menor que --lleno-pct (bandas <VACÍO/MEDIO/LLENO>)")
    tip = (a.tipologia or "").strip().upper() or None
    if tip is not None and tip not in TIPOLOGIA_AFORO:
        p.error(f"tipologia debe ser una de: {', '.join(TIPOLOGIA_AFORO)}")
    capacidad = a.capacidad if a.capacidad is not None else (
        TIPOLOGIA_AFORO[tip] if tip else None)
    return Config(
        source=a.source, stride_seconds=a.cada_segundos, conf=a.conf,
        iou=a.iou, capacidad=capacidad, vacio_pct=a.vacio_pct,
        lleno_pct=a.lleno_pct,
        imgsz=a.imgsz, model_name=a.modelo, device=a.device,
        half=not a.fp32, show=not a.no_show, save_jsonl=a.save_jsonl,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    fuente = VideoSource(cfg)
    detector = Detector(cfg)
    suavizador = Suavizador(cfg.ventana, cfg.capacidad,
                            cfg.vacio_pct, cfg.lleno_pct)
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
            alto, ancho = frame.shape[0], frame.shape[1]
            cobertura, solape = densidad(cajas, ancho, alto)
            med = suavizador.agregar(conteo, t_video, cobertura, solape)
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
