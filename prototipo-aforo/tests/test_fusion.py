#!/usr/bin/env python3
"""Tests de fusión (stdlib unittest: sin GPU, sin torch)."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion import DIF_MAXIMA, DIF_PP_MAX, fusionar, main as fusion_main


def linea(estado, n, cap=None):
    med = {"timestamp": "t", "conteo_crudo": n, "conteo_promediado": float(n),
           "estado_ocupacion": estado}
    if cap is not None:
        med["capacidad"] = cap
    return med


def correr_cli(a, b, extra=()):
    fa = fb = None
    try:
        fa = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False,
                                         encoding="utf-8")
        fb = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False,
                                         encoding="utf-8")
        fa.write(json.dumps(a, ensure_ascii=False) + "\n")
        fb.write(json.dumps(b, ensure_ascii=False) + "\n")
        fa.close()
        fb.close()
        argv = ["fusion.py", "--a", fa.name, "--b", fb.name, *extra]
        viejo = sys.argv
        sys.argv = argv
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                fusion_main()
            return json.loads(buf.getvalue())
        finally:
            sys.argv = viejo
    finally:
        for p in (fa.name if fa else None, fb.name if fb else None):
            if p and os.path.exists(p):
                os.unlink(p)


class TestLegado(unittest.TestCase):
    def test_iguales_confianza_alta(self):
        self.assertEqual(fusionar("MEDIO", "MEDIO", 8, 8),
                         ("MEDIO", "alta", False))

    def test_difieren_gana_maximo(self):
        self.assertEqual(fusionar("MEDIO", "VACÍO", 8, 3)[0:2],
                         ("MEDIO", "media"))
        self.assertEqual(fusionar("VACÍO", "LLENO", 1, 20)[0:2],
                         ("LLENO", "media"))

    def test_outlier_absoluto_bordes(self):
        self.assertFalse(fusionar("MEDIO", "MEDIO", 0, DIF_MAXIMA)[2])      # == 10
        self.assertTrue(fusionar("MEDIO", "MEDIO", 0, DIF_MAXIMA + 1)[2])   # 11


class TestPuntosPorcentuales(unittest.TestCase):
    def test_misma_pp_no_outlier(self):
        # 20/40 = 50 % vs 60/150 = 40 %: dif 10pp < 25.
        self.assertEqual(fusionar("MEDIO", "MEDIO", 20, 60,
                                  cap_a=40, cap_b=150),
                         ("MEDIO", "alta", False))

    def test_outlier_pp_bordes(self):
        self.assertFalse(fusionar("VACÍO", "VACÍO", 0, 10,
                                  cap_a=40, cap_b=40)[2])  # 25.0pp exactos
        self.assertTrue(fusionar("VACÍO", "MEDIO", 0, 11,
                                 cap_a=40, cap_b=40)[2])   # 27.5pp

    def test_articulado_tolera_dif_absoluta(self):
        # |10-22| = 12 > 10 (legado diría outlier); en pp es 8 < 25.
        self.assertFalse(fusionar("VACÍO", "VACÍO", 10, 22,
                                  cap_a=150, cap_b=150)[2])

    def test_sin_capacidades_cae_a_legado(self):
        self.assertEqual(fusionar("MEDIO", "VACÍO", 8, 3,
                                  cap_a=None, cap_b=None),
                         fusionar("MEDIO", "VACÍO", 8, 3))
        # Una sola capacidad no basta: también legado.
        self.assertEqual(fusionar("MEDIO", "MEDIO", 0, 11, cap_a=40)[2],
                         fusionar("MEDIO", "MEDIO", 0, 11)[2])

    def test_dif_pp_custom(self):
        self.assertTrue(fusionar("VACÍO", "VACÍO", 0, 10,
                                 cap_a=40, cap_b=40, dif_pp_max=20.0)[2])


class TestCLI(unittest.TestCase):
    def test_lee_capacidad_del_jsonl(self):
        sal = correr_cli(linea("MEDIO", 20, 40), linea("MEDIO", 60, 150))
        self.assertEqual(sal["estado"], "MEDIO")
        self.assertEqual(sal["confianza"], "alta")
        self.assertFalse(sal["outlier"])

    def test_flags_mandan_sobre_jsonl(self):
        sal = correr_cli(linea("VACÍO", 0), linea("LLENO", 60),
                         ["--cap-a", "40", "--cap-b", "40"])
        self.assertEqual(sal["estado"], "LLENO")
        self.assertTrue(sal["outlier"])

    def test_sin_capacidad_legado(self):
        sal = correr_cli(linea("MEDIO", 8), linea("VACÍO", 3))
        self.assertEqual((sal["estado"], sal["confianza"], sal["outlier"]),
                         ("MEDIO", "media", False))


if __name__ == "__main__":
    unittest.main()
