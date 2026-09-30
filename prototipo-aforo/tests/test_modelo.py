#!/usr/bin/env python3
"""Tests con torch: el peso guardado vuelve igual y el clasificador corre.
Se saltan si torch/torchvision no están (el Mac del backend sin el venv)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import torch  # noqa: F401
    import torchvision  # noqa: F401
    HAY_TORCH = True
except ImportError:
    HAY_TORCH = False

import modelo as M


@unittest.skipUnless(HAY_TORCH, "sin torch/torchvision")
class TestModelo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ruta = os.path.join(self.tmp.name, "best.pt")

    def test_tres_salidas_y_vuelta_identica(self):
        import torch

        red = M.construir("efficientnet_b0", imagenet=False).eval()
        M.guardar(self.ruta, red, "efficientnet_b0", 224, {"macro_f1": 0.5})
        otra, imgsz = M.cargar(self.ruta, "cpu")
        x = torch.randn(1, 3, 224, 224)
        with torch.inference_mode():
            self.assertEqual(tuple(red(x).shape), (1, 3))
            self.assertTrue(torch.allclose(red(x), otra(x)))
        self.assertEqual(imgsz, 224)

    def test_peso_de_otras_clases_no_carga(self):
        import torch

        red = M.construir("efficientnet_b0", imagenet=False)
        torch.save({"formato": M.FORMATO_PESO, "arquitectura": "efficientnet_b0",
                    "imgsz": 224, "estados": ["LLENO", "MEDIO", "VACÍO"],
                    "pesos": red.state_dict(), "metricas": {}}, self.ruta)
        with self.assertRaisesRegex(ValueError, "clases"):
            M.cargar(self.ruta)

    def test_formato_viejo_no_carga(self):
        import torch

        torch.save({"formato": 0}, self.ruta)
        with self.assertRaisesRegex(ValueError, "formato"):
            M.cargar(self.ruta)

    def test_arquitectura_desconocida(self):
        with self.assertRaises(ValueError):
            M.construir("resnet50")

    def test_clasificador_da_probabilidades(self):
        import numpy as np

        import aforo as A

        red = M.construir("efficientnet_b0", imagenet=False)
        M.guardar(self.ruta, red, "efficientnet_b0", 224, {})
        c = A.Clasificador(A.Config(source="x", modelo=self.ruta, device="cpu"))
        p = c.probabilidades(np.zeros((240, 320, 3), dtype=np.uint8))
        self.assertEqual(len(p), 3)
        self.assertAlmostEqual(sum(p), 1.0, places=4)
        self.assertIn(A.decidir(p), A.ESTADOS)

    def test_transformaciones_dan_el_tamano(self):
        from PIL import Image

        img = Image.new("RGB", (320, 240))
        for entrenamiento in (True, False):
            t = M.transformaciones(224, entrenamiento)(img)
            self.assertEqual(tuple(t.shape), (3, 224, 224))


if __name__ == "__main__":
    unittest.main()
