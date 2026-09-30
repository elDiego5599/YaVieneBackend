#!/usr/bin/env python3
"""Tests del flujo de entrenamiento que no piden torch: reparto sin fuga,
métricas, barrido de umbrales y pesos por clase."""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, "entrenamiento"))

import evaluar as E
import split_dataset as S
import train as T
from modelo import CARPETAS, listar_fotos


def fotos_de(sesiones_por_clase, por_sesion=10):
    """{nivel: n_sesiones} -> [(Path, nivel)] con nombres de extraer_frames."""
    return [(Path(f"cam_c{nivel}s{s}_{i:04d}.jpg"), nivel)
            for nivel, n in sesiones_por_clase.items()
            for s in range(n) for i in range(por_sesion)]


class TestSesion(unittest.TestCase):
    def test_nombre_de_extraer_frames(self):
        self.assertEqual(S.sesion_de(Path("frontal_bus12_0930_0042.jpg")), "frontal_bus12_0930")

    def test_sin_numero_es_su_propia_sesion(self):
        self.assertEqual(S.sesion_de(Path("suelta.jpg")), "suelta")
        self.assertEqual(S.sesion_de(Path("foto_12.jpg")), "foto_12")


class TestRepartir(unittest.TestCase):
    def test_sin_fuga_y_nada_se_pierde(self):
        fotos = fotos_de({0: 7, 1: 7, 2: 7})
        grupos, avisos = S.repartir(fotos, 0.15, 0.15, semilla=1)
        self.assertEqual(avisos, [])
        sesiones = {g: {S.sesion_de(f) for f, _ in l} for g, l in grupos.items()}
        self.assertFalse(sesiones["train"] & sesiones["val"])
        self.assertFalse(sesiones["train"] & sesiones["test"])
        self.assertFalse(sesiones["val"] & sesiones["test"])
        self.assertEqual(sorted(sum(grupos.values(), [])), sorted(fotos))

    def test_cada_clase_en_cada_grupo(self):
        grupos, _ = S.repartir(fotos_de({0: 5, 1: 4, 2: 3}), 0.15, 0.15, semilla=7)
        for g in ("train", "val", "test"):
            self.assertEqual({n for _, n in grupos[g]}, {0, 1, 2}, g)

    def test_sesion_mixta_va_entera_a_un_grupo(self):
        # Un video que empieza medio y termina lleno: sus fotos no se parten.
        mixta = [(Path(f"mix_{i:04d}.jpg"), 1 if i < 6 else 2) for i in range(10)]
        grupos, _ = S.repartir(fotos_de({0: 4, 1: 4, 2: 4}) + mixta, 0.15, 0.15, semilla=3)
        dueños = [g for g, l in grupos.items() if any(S.sesion_de(f) == "mix" for f, _ in l)]
        self.assertEqual(len(dueños), 1)
        self.assertEqual(sum(1 for f, _ in grupos[dueños[0]] if S.sesion_de(f) == "mix"), 10)

    def test_determinista_por_semilla(self):
        fotos = fotos_de({0: 6, 1: 6, 2: 6})
        self.assertEqual(S.repartir(fotos, 0.2, 0.2, 5), S.repartir(fotos, 0.2, 0.2, 5))

    def test_pocas_sesiones_avisa_y_train_no_queda_sin_clase(self):
        grupos, avisos = S.repartir(fotos_de({0: 3, 1: 3, 2: 1}), 0.15, 0.15, semilla=0)
        self.assertTrue(any("lleno: 1 sesión" in a for a in avisos), avisos)
        self.assertTrue(any("sin fotos de: lleno" in a for a in avisos), avisos)
        self.assertIn(2, {n for _, n in grupos["train"]})

    def test_clase_ausente_avisa(self):
        _, avisos = S.repartir(fotos_de({0: 3, 1: 3}), 0.15, 0.15, semilla=0)
        self.assertTrue(any("lleno: no hay ninguna sesión" in a for a in avisos), avisos)

    def test_fracciones_invalidas(self):
        with self.assertRaises(ValueError):
            S.repartir([], 0.5, 0.5, 0)
        with self.assertRaises(ValueError):
            S.repartir([], -0.1, 0.2, 0)

    def test_sin_val_ni_test_todo_a_train(self):
        fotos = fotos_de({0: 2, 1: 2, 2: 2})
        grupos, avisos = S.repartir(fotos, 0.0, 0.0, 0)
        self.assertEqual((len(grupos["train"]), grupos["val"], grupos["test"], avisos),
                         (len(fotos), [], [], []))


class TestSplitCLI(unittest.TestCase):
    def test_copia_ignora_descartadas_y_no_pisa(self):
        with tempfile.TemporaryDirectory() as tmp:
            origen, destino = Path(tmp, "et"), Path(tmp, "partido")
            for nivel, carpeta in enumerate(CARPETAS):
                (origen / carpeta).mkdir(parents=True)
                for s in range(3):
                    for i in range(4):
                        (origen / carpeta / f"c{nivel}s{s}_{i:04d}.jpg").write_bytes(b"x")
            (origen / "descartadas").mkdir()
            (origen / "descartadas" / "mala_0000.jpg").write_bytes(b"x")
            (origen / "vacio" / "notas.txt").write_text("no es foto")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(S.main(["--origen", str(origen), "--destino", str(destino)]), 0)
            copiadas = sorted(p.name for p in destino.rglob("*") if p.is_file())
            self.assertEqual(len(copiadas), 36)
            self.assertNotIn("mala_0000.jpg", copiadas)
            self.assertEqual(len(listar_fotos(destino / "val")), 12)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                S.main(["--origen", str(origen), "--destino", str(destino)])


class TestMetricas(unittest.TestCase):
    def test_matriz_y_tasas(self):
        reales = [0, 0, 1, 1, 2, 2, 2, 0]
        pred = [0, 1, 1, 0, 2, 1, 2, 2]
        m = E.metricas(reales, pred)
        self.assertEqual(m["matriz"], [[1, 1, 1], [1, 1, 0], [0, 1, 2]])
        self.assertEqual(m["sobreestimacion"], 0.25)   # 0→1, 0→2
        self.assertEqual(m["subestimacion"], 0.25)     # 1→0, 2→1
        self.assertEqual(m["exactitud"], 0.5)
        self.assertEqual(m["por_clase"]["LLENO"], {"precision": 0.6667, "recall": 0.6667,
                                                   "f1": 0.6667, "n": 3})

    def test_perfecto_y_clase_ausente(self):
        m = E.metricas([0, 1, 1], [0, 1, 1])
        self.assertEqual((m["macro_f1"], m["exactitud"]), (1.0, 1.0))  # LLENO no cuenta
        self.assertEqual(m["por_clase"]["LLENO"]["n"], 0)

    def test_vacio_y_largos_distintos(self):
        self.assertEqual(E.metricas([], [])["n"], 0)
        with self.assertRaises(ValueError):
            E.metricas([0], [])


class TestBarrer(unittest.TestCase):
    def test_respeta_el_objetivo_de_sobreestimacion(self):
        # Vacíos que la red ve medio-dudosos: con umbral_medio bajo se
        # sobreestiman; el barrido debe subirlo.
        probs = [[0.4, 0.55, 0.05]] * 4 + [[0.1, 0.85, 0.05]] * 4 + [[0.0, 0.1, 0.9]] * 4
        reales = [0] * 4 + [1] * 4 + [2] * 4
        mejor = E.barrer(probs, reales, objetivo_sobre=0.0)
        self.assertEqual(mejor["metricas"]["sobreestimacion"], 0.0)
        self.assertEqual(mejor["metricas"]["macro_f1"], 1.0)
        self.assertGreater(mejor["umbral_medio"], 0.60)
        self.assertLessEqual(mejor["umbral_lleno"], 0.90)

    def test_ninguno_cumple_devuelve_none(self):
        # Un VACÍO que la red jura LLENO: ningún umbral ≤ 0.95 lo salva.
        self.assertIsNone(E.barrer([[0.0, 0.0, 1.0]], [0], objetivo_sobre=0.0))

    def test_rejilla(self):
        r = E._rejilla()
        self.assertEqual((r[0], r[-1], len(r)), (0.5, 0.95, 10))


class TestTrain(unittest.TestCase):
    def test_pesos_por_clase(self):
        self.assertEqual(T.pesos_por_clase([0, 0, 1, 1, 2, 2]), [1.0, 1.0, 1.0])
        w = T.pesos_por_clase([0] * 6 + [1] * 3 + [2])
        self.assertGreater(w[2], w[1])
        self.assertGreater(w[1], w[0])
        self.assertEqual(T.pesos_por_clase([0, 0, 1])[2], 0.0)
        with self.assertRaises(ValueError):
            T.pesos_por_clase([])

    def test_cli(self):
        a = T.parse_args(["--datos", "d"])
        self.assertEqual((a.arch, a.epocas, a.calentar, a.lote), ("efficientnet_b0", 30, 3, 32))
        for malo in (["--calentar", "30"], ["--epocas", "0"], ["--lr", "0"],
                     ["--arch", "resnet50"], ["--calentar", "-1"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                T.parse_args(["--datos", "d", *malo])


if __name__ == "__main__":
    unittest.main()
