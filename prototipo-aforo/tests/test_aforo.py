#!/usr/bin/env python3
"""Tests del aforo (stdlib unittest: corren sin GPU, sin torch, hasta en Mac).

Cubre lo que hoy solo estaba verificado a mano: bandas %, legado absoluto,
ventana móvil, densidad de apiñado y CLI. Lo que exige GPU/cámara
(Detector, VideoSource contra RTSP, train.py) queda fuera a propósito y se
verifica con video real en la torre.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aforo_yolo11 as A


def estable(ventana, capacidad, n, repeticiones=5):
    s = A.Suavizador(ventana, capacidad)
    med = None
    for _ in range(repeticiones):
        med = s.agregar(n, 0.0)
    return med


class TestBandas(unittest.TestCase):
    def test_bordes_40_85_cap40(self):
        self.assertEqual(estable(5, 40.0, 5).estado_ocupacion, "VACÍO")    # 12.5
        self.assertEqual(estable(5, 40.0, 15).estado_ocupacion, "VACÍO")   # 37.5
        m = estable(5, 40.0, 16)
        self.assertEqual(m.pct_promediado, 40.0)
        self.assertEqual(m.estado_ocupacion, "MEDIO")                      # 40.0 exacto
        m = estable(5, 40.0, 34)
        self.assertEqual(m.pct_promediado, 85.0)
        self.assertEqual(m.estado_ocupacion, "LLENO")                      # 85.0 exacto
        self.assertEqual(estable(5, 40.0, 40).estado_ocupacion, "LLENO")   # 100

    def test_pct_en_medicion(self):
        m = estable(5, 60.0, 30)
        self.assertEqual(m.pct_promediado, 50.0)
        self.assertEqual(m.capacidad, 60.0)
        self.assertEqual(m.estado_ocupacion, "MEDIO")


class TestLegado(unittest.TestCase):
    def test_sin_capacidad_umbrales_absolutos(self):
        self.assertEqual(estable(5, None, 4).estado_ocupacion, "VACÍO")
        self.assertEqual(estable(5, None, 5).estado_ocupacion, "MEDIO")
        self.assertEqual(estable(5, None, 15).estado_ocupacion, "MEDIO")
        self.assertEqual(estable(5, None, 16).estado_ocupacion, "LLENO")
        m = estable(5, None, 7)
        self.assertIsNone(m.pct_promediado)
        self.assertIsNone(m.capacidad)

    def test_capacidad_cero_no_divide_cae_a_legado(self):
        m = estable(5, 0.0, 20)
        self.assertEqual(m.estado_ocupacion, "LLENO")  # 20 > 15, sin ZeroDivision


class TestVentana(unittest.TestCase):
    def test_promedia_y_expulsa_viejos(self):
        s = A.Suavizador(5, None)
        for _ in range(4):
            s.agregar(10, 0.0)
        self.assertEqual(s.agregar(0, 0.0).conteo_promediado, 8.0)  # (40+0)/5
        for _ in range(5):
            m = s.agregar(20, 0.0)
        self.assertEqual(m.conteo_promediado, 20.0)  # los 10/0 ya salieron
        self.assertEqual(m.conteo_crudo, 20)


class TestDensidad(unittest.TestCase):
    def test_vacia(self):
        self.assertEqual(A.densidad([], 640, 480), (0.0, 0.0))

    def test_una_caja_sin_solape(self):
        cob, sol = A.densidad([(0, 0, 100, 100)], 640, 480)
        self.assertEqual(cob, round(10000 / (640 * 480), 3))  # redondeo a 3
        self.assertEqual(sol, 0.0)

    def test_gemelas_solape_uno_y_cobertura_doble(self):
        cob, sol = A.densidad([(0, 0, 100, 100), (0, 0, 100, 100)], 640, 480)
        self.assertEqual(sol, 1.0)
        self.assertEqual(cob, round(2 * 10000 / (640 * 480), 3))

    def test_separadas_solape_cero(self):
        _, sol = A.densidad([(0, 0, 10, 10), (100, 100, 110, 110)], 640, 480)
        self.assertEqual(sol, 0.0)

    def test_degeneradas_no_rompen(self):
        self.assertEqual(A.densidad([(5, 5, 5, 5)], 640, 480)[0], 0.0)  # área 0
        A.densidad([(10, 10, 0, 0)], 640, 480)  # invertida: max(0) la tapa
        A.densidad([(-50, -50, 3000, 3000)], 640, 480)  # fuera de marco

    def test_sale_json_serializable(self):
        # Regresión real: cobertura float32 reventaba json.dumps del JSONL.
        import numpy as np
        arr = np.array([[0, 0, 100, 100], [50, 50, 150, 150]], dtype="float32")
        cob, sol = A.densidad(arr, 640, 480)
        self.assertIsInstance(cob, float)
        self.assertIsInstance(sol, float)
        json.dumps({"cobertura": cob, "solape_medio": sol})


class TestCLI(unittest.TestCase):
    def test_defaults_legado(self):
        cfg = A.parse_args(["--source", "x.mp4"])
        self.assertIsNone(cfg.capacidad)
        self.assertEqual((cfg.conf, cfg.iou, cfg.vacio_pct, cfg.lleno_pct),
                         (0.40, 0.70, 40.0, 85.0))

    def test_tipologia_pone_default(self):
        cfg = A.parse_args(["--source", "x.mp4", "--tipologia", "padron"])
        self.assertEqual(cfg.capacidad, 60.0)

    def test_capacidad_manda_sobre_tipologia(self):
        cfg = A.parse_args(["--source", "x.mp4", "--tipologia", "PADRON",
                            "--capacidad", "55"])
        self.assertEqual(cfg.capacidad, 55.0)

    def test_tipologia_invalida_falla_en_voz_alta(self):
        with self.assertRaises(SystemExit):
            A.parse_args(["--source", "x.mp4", "--tipologia", "BUSETA"])

    def test_bandas_invertidas_fallan_en_voz_alta(self):
        with self.assertRaises(SystemExit):
            A.parse_args(["--source", "x.mp4", "--capacidad", "40",
                          "--vacio-pct", "90", "--lleno-pct", "10"])


class TestStride(unittest.TestCase):
    def test_un_frame_cada_2s_segun_fps_reales(self):
        # VideoSource sin GPU: genera mp4 de 30 fps x 2 s y verifica que solo
        # 1 frame llegue a procesarse (stride = round(30*2) = 60).
        import tempfile
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("sin cv2/numpy")
        tmp = tempfile.mkdtemp(prefix="aforo_stride_")
        ruta = os.path.join(tmp, "v.mp4")
        w = cv2.VideoWriter(ruta, cv2.VideoWriter_fourcc(*"mp4v"), 30, (160, 120))
        if not w.isOpened():
            self.skipTest("VideoWriter no disponible")
        for _ in range(60):
            w.write(np.zeros((120, 160, 3), dtype="uint8"))
        w.release()
        try:
            cfg = A.Config(source=ruta, stride_seconds=2.0)
            vs = A.VideoSource(cfg)
            try:
                self.assertEqual(vs.stride, 60)
                proc = 0
                while True:
                    frame, _ = vs.read()
                    if frame is None:
                        break
                    if frame is not False:
                        proc += 1
                self.assertEqual(proc, 1)
            finally:
                vs.release()
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestConsistenciaBackend(unittest.TestCase):
    def test_mismos_aforos_que_fleet_admin_ts(self):
        # Doble fuente de verdad (TS + PY) para 30/60/80: si derivan, el %
        # cambia en silencio. Este test lee el archivo real del backend.
        ts = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "..", "src", "data", "fleet_admin.ts")
        self.assertTrue(os.path.exists(ts), f"no existe {ts}")
        import re
        with open(ts, encoding="utf-8") as f:
            cuerpo = f.read()
        m = re.search(r"CAPACIDAD_POR_TIPOLOGIA[^=]*=\s*\{([^}]*)\}", cuerpo)
        self.assertIsNotNone(m, "CAPACIDAD_POR_TIPOLOGIA no encontrado en fleet_admin.ts")
        pares = dict(re.findall(r"(SENCILLO|PADRON|ARTICULADO)\s*:\s*(\d+)", m.group(1)))
        self.assertEqual({k: float(v) for k, v in pares.items()}, A.TIPOLOGIA_AFORO)


if __name__ == "__main__":
    unittest.main()
