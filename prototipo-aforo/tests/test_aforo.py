#!/usr/bin/env python3
"""Tests del aforo (stdlib unittest: corren sin GPU y sin torch, hasta en Mac).

Cubre la regla «tira pa abajo», el promedio de probabilidades, el CLI y el
salto de fotogramas. Lo que pide torch (Clasificador, train.py) se prueba
en test_modelo.py, que se salta si torch no está instalado.
"""
import contextlib
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aforo as A


class TestDecidir(unittest.TestCase):
    def test_seguro_de_cada_estado(self):
        self.assertEqual(A.decidir([0.9, 0.08, 0.02]), "VACÍO")
        self.assertEqual(A.decidir([0.1, 0.8, 0.1]), "MEDIO")
        self.assertEqual(A.decidir([0.02, 0.08, 0.9]), "LLENO")

    def test_empate_entre_dos_gana_el_bajo(self):
        # Una red que duda 50/50 no alcanza ningún umbral alto.
        self.assertEqual(A.decidir([0.5, 0.5, 0.0]), "VACÍO")
        self.assertEqual(A.decidir([0.0, 0.5, 0.5]), "MEDIO")

    def test_argmax_lleno_no_basta(self):
        # P(lleno)=0.60 es la mayor, pero no llega a 0.80: dice MEDIO.
        self.assertEqual(A.decidir([0.30, 0.10, 0.60]), "MEDIO")
        # Y con P(≥medio)=0.55 < 0.60, ni siquiera MEDIO.
        self.assertEqual(A.decidir([0.45, 0.30, 0.25]), "VACÍO")

    def test_bordes_exactos_incluyen(self):
        self.assertEqual(A.decidir([0.0, 0.2, 0.8]), "LLENO")
        self.assertEqual(A.decidir([0.4, 0.3, 0.3]), "MEDIO")

    def test_umbrales_propios(self):
        self.assertEqual(A.decidir([0.3, 0.1, 0.6], umbral_lleno=0.55), "LLENO")
        self.assertEqual(A.decidir([0.45, 0.3, 0.25], umbral_medio=0.5), "MEDIO")

    def test_nunca_pasa_de_la_mediana(self):
        # Propiedad del sesgo: con umbrales ≥ 0.5 el estado nunca pasa de la
        # mediana ordinal (el nivel más alto con P(≥ nivel) ≥ 0.5). Ojo: SÍ
        # puede pasar del argmax: (0.4, 0.3, 0.3) es MEDIO porque hay 60 %
        # de que vaya al menos medio. Rejilla a pasos de 0.05.
        pasos = [i / 20 for i in range(21)]
        for pv in pasos:
            for pm in pasos:
                pl = round(1 - pv - pm, 10)
                if pl < 0:
                    continue
                probs = [pv, pm, pl]
                mediana = max(k for k in range(3) if sum(probs[k:]) >= 0.5 - 1e-9)
                nivel = A.ESTADOS.index(A.decidir(probs))
                self.assertLessEqual(nivel, mediana, probs)

    def test_longitud_mala_falla(self):
        with self.assertRaises(ValueError):
            A.decidir([0.5, 0.5])


class TestSuavizador(unittest.TestCase):
    def test_promedia_y_expulsa_viejos(self):
        s = A.Suavizador(ventana=2)
        s.agregar([0.0, 0.0, 1.0])
        m = s.agregar([1.0, 0.0, 0.0])
        self.assertEqual(m.probs, [0.5, 0.0, 0.5])
        self.assertEqual(m.estado_ocupacion, "VACÍO")  # 0.5 < 0.6: tira pa abajo
        m = s.agregar([1.0, 0.0, 0.0])                  # el LLENO ya salió
        self.assertEqual(m.probs, [1.0, 0.0, 0.0])
        self.assertEqual(m.probs_crudas, [1.0, 0.0, 0.0])

    def test_un_fotograma_raro_no_cambia_el_estado(self):
        s = A.Suavizador(ventana=5)
        for _ in range(4):
            s.agregar([0.9, 0.1, 0.0])
        self.assertEqual(s.agregar([0.0, 0.0, 1.0]).estado_ocupacion, "VACÍO")

    def test_usa_sus_umbrales(self):
        s = A.Suavizador(ventana=1, umbral_lleno=0.5)
        self.assertEqual(s.agregar([0.2, 0.2, 0.6]).estado_ocupacion, "LLENO")

    def test_ventana_invalida_y_longitud_mala(self):
        with self.assertRaises(ValueError):
            A.Suavizador(ventana=0)
        with self.assertRaises(ValueError):
            A.Suavizador().agregar([1.0])

    def test_sale_json_serializable(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("sin numpy")
        m = A.Suavizador().agregar(np.array([0.1, 0.2, 0.7], dtype=np.float32))
        linea = json.loads(json.dumps(m.__dict__, ensure_ascii=False))
        self.assertEqual(linea["probs"], [0.1, 0.2, 0.7])
        self.assertEqual(set(linea), {"timestamp", "estado_ocupacion", "probs", "probs_crudas"})


class TestCLI(unittest.TestCase):
    def _falla(self, argv):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            A.parse_args(argv)

    def test_defaults(self):
        c = A.parse_args(["--source", "v.mp4", "--modelo", "best.pt"])
        self.assertEqual((c.stride_seconds, c.ventana, c.device, c.show),
                         (2.0, 5, "auto", True))
        self.assertEqual((c.umbral_lleno, c.umbral_medio), (A.UMBRAL_LLENO, A.UMBRAL_MEDIO))

    def test_flags(self):
        c = A.parse_args(["--source", "rtsp://x", "--modelo", "m.pt", "--cada-segundos", "1",
                          "--ventana", "3", "--umbral-lleno", "0.9", "--umbral-medio", "0.7",
                          "--no-show", "--save-jsonl", "a.jsonl", "--device", "cpu"])
        self.assertEqual((c.stride_seconds, c.ventana, c.umbral_lleno, c.umbral_medio),
                         (1.0, 3, 0.9, 0.7))
        self.assertEqual((c.show, c.save_jsonl, c.device), (False, "a.jsonl", "cpu"))

    def test_modelo_obligatorio(self):
        self._falla(["--source", "v.mp4"])

    def test_valores_invalidos_fallan_en_voz_alta(self):
        base = ["--source", "v.mp4", "--modelo", "m.pt"]
        self._falla(base + ["--cada-segundos", "0"])
        self._falla(base + ["--ventana", "0"])
        self._falla(base + ["--umbral-lleno", "0"])
        self._falla(base + ["--umbral-medio", "1.5"])


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


if __name__ == "__main__":
    unittest.main()
