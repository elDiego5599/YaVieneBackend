#!/usr/bin/env python3
"""Tests de fusión (stdlib unittest: sin GPU, sin torch)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion import fusionar, main as fusion_main


class TestFusionar(unittest.TestCase):
    def test_iguales_confianza_alta(self):
        for e in ("VACÍO", "MEDIO", "LLENO"):
            self.assertEqual(fusionar(e, e), (e, "alta", False))

    def test_difieren_gana_el_bajo(self):
        self.assertEqual(fusionar("MEDIO", "VACÍO"), ("VACÍO", "media", False))
        self.assertEqual(fusionar("LLENO", "MEDIO"), ("MEDIO", "media", False))
        self.assertEqual(fusionar("MEDIO", "LLENO"), ("MEDIO", "media", False))

    def test_dos_niveles_es_outlier(self):
        self.assertEqual(fusionar("LLENO", "VACÍO"), ("VACÍO", "media", True))
        self.assertEqual(fusionar("VACÍO", "LLENO"), ("VACÍO", "media", True))

    def test_una_camara_confianza_baja(self):
        self.assertEqual(fusionar("LLENO", None), ("LLENO", "baja", False))
        self.assertEqual(fusionar(None, "VACÍO"), ("VACÍO", "baja", False))

    def test_errores_en_voz_alta(self):
        with self.assertRaises(ValueError):
            fusionar(None, None)
        with self.assertRaises(ValueError):
            fusionar("REPLETO", "MEDIO")
        with self.assertRaises(ValueError):
            fusionar("repleto", None)


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _jsonl(self, nombre, *estados):
        ruta = os.path.join(self.tmp.name, nombre)
        with open(ruta, "w", encoding="utf-8") as f:
            for e in estados:
                f.write(json.dumps({"timestamp": "t", "estado_ocupacion": e,
                                    "probs": [0.2, 0.3, 0.5]}, ensure_ascii=False) + "\n")
            f.write("\n")  # línea vacía al final: se ignora
        return ruta

    def _correr(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fusion_main(argv)
        return json.loads(buf.getvalue())

    def test_lee_la_ultima_linea_de_cada_camara(self):
        a = self._jsonl("a.jsonl", "VACÍO", "LLENO")
        b = self._jsonl("b.jsonl", "LLENO", "MEDIO")
        out = self._correr(["--a", a, "--b", b])
        self.assertEqual((out["estado"], out["confianza"], out["outlier"]),
                         ("MEDIO", "media", False))
        self.assertEqual(out["detalle"]["frontal"]["estado_ocupacion"], "LLENO")

    def test_solo_una_camara(self):
        out = self._correr(["--a", self._jsonl("a.jsonl", "MEDIO")])
        self.assertEqual((out["estado"], out["confianza"]), ("MEDIO", "baja"))
        self.assertIsNone(out["detalle"]["trasera"])

    def test_jsonl_vacio_falla(self):
        vacio = os.path.join(self.tmp.name, "v.jsonl")
        open(vacio, "w").close()
        with self.assertRaises(SystemExit):
            self._correr(["--a", vacio])


if __name__ == "__main__":
    unittest.main()
