"""Tests du serveur — surtout la barrière du jeton d'accès.

Lancer depuis le dossier bot-code/ :   py -m unittest discover -s tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MISTRAL_API_KEY", "test")
import app


class TestSecurite(unittest.TestCase):
    def setUp(self):
        self.c = app.app.test_client()

    def _cle(self):
        return self.c.get("/api/cle-locale").get_json()["cle"]

    def test_api_sans_cle_refusee(self):
        self.assertEqual(self.c.get("/api/reseau").status_code, 403)

    def test_cle_locale_puis_acces(self):
        r = self.c.get("/api/cle-locale")
        self.assertEqual(r.status_code, 200)
        cle = r.get_json()["cle"]
        self.assertEqual(self.c.get("/api/reseau", headers={"X-Cle": cle}).status_code, 200)

    def test_mauvaise_cle_refusee(self):
        self.assertEqual(self.c.get("/api/reseau", headers={"X-Cle": "faux"}).status_code, 403)

    def test_shell_et_sw_libres(self):
        self.assertEqual(self.c.get("/").status_code, 200)
        self.assertEqual(self.c.get("/sw.js").status_code, 200)

    def test_parcourir_protege_puis_ok(self):
        self.assertEqual(self.c.get("/api/parcourir").status_code, 403)
        r = self.c.get("/api/parcourir", headers={"X-Cle": self._cle()})
        self.assertEqual(r.status_code, 200)
        self.assertIn("entrees", r.get_json())


if __name__ == "__main__":
    unittest.main()
