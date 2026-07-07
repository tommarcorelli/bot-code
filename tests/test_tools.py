"""Tests des outils fichiers — stdlib unittest, aucune dépendance.

Lancer depuis le dossier bot-code/ :   py -m unittest discover -s tests
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tools_web as tools


class TestConfinement(unittest.TestCase):
    """resoudre() est LA barrière de sécurité : rien ne doit sortir du workspace."""

    def setUp(self):
        self.base = tempfile.mkdtemp()

    def test_chemin_relatif_ok(self):
        self.assertEqual(
            tools.resoudre(self.base, "a/b.txt"),
            os.path.abspath(os.path.join(self.base, "a/b.txt")),
        )

    def test_remontee_bloquee(self):
        self.assertIsNone(tools.resoudre(self.base, "../secret.txt"))
        self.assertIsNone(tools.resoudre(self.base, "..\\..\\Windows"))

    def test_absolu_hors_base_bloque(self):
        self.assertIsNone(tools.resoudre(self.base, "C:\\Windows"))

    def test_base_elle_meme(self):
        self.assertEqual(tools.resoudre(self.base, ""), os.path.abspath(self.base))


class TestFichiers(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()

    def test_ecrire_puis_lire(self):
        self.assertIn("succès", tools.ecrire_fichier("x.txt", "coucou", base=self.base))
        self.assertEqual(tools.lire_fichier("x.txt", base=self.base), "coucou")

    def test_ecrire_hors_base(self):
        self.assertEqual(
            tools.ecrire_fichier("../x.txt", "non", base=self.base), tools.ERREUR_SORTIE
        )

    def test_remplacer_texte(self):
        tools.ecrire_fichier("f.py", "a=1\nb=1\n", base=self.base)
        msg = tools.remplacer_texte("f.py", "1", "2", base=self.base)
        self.assertIn("2 occurrence", msg)
        self.assertEqual(tools.lire_fichier("f.py", base=self.base), "a=2\nb=2\n")

    def test_remplacer_introuvable(self):
        tools.ecrire_fichier("f.txt", "abc", base=self.base)
        self.assertIn("introuvable", tools.remplacer_texte("f.txt", "zzz", "y", base=self.base))

    def test_renommer(self):
        tools.ecrire_fichier("vieux.txt", "hey", base=self.base)
        msg = tools.renommer("vieux.txt", "sous/neuf.txt", base=self.base)
        self.assertIn("→", msg)
        self.assertFalse(os.path.exists(os.path.join(self.base, "vieux.txt")))
        self.assertEqual(tools.lire_fichier("sous/neuf.txt", base=self.base), "hey")

    def test_renommer_destination_existante(self):
        tools.ecrire_fichier("a.txt", "1", base=self.base)
        tools.ecrire_fichier("b.txt", "2", base=self.base)
        self.assertIn("existe déjà", tools.renommer("a.txt", "b.txt", base=self.base))

    def test_renommer_hors_base(self):
        tools.ecrire_fichier("a.txt", "1", base=self.base)
        self.assertEqual(
            tools.renommer("a.txt", "../evade.txt", base=self.base), tools.ERREUR_SORTIE
        )

    def test_lire_extrait(self):
        tools.ecrire_fichier("g.txt", "\n".join(f"L{i}" for i in range(1, 21)), base=self.base)
        out = tools.lire_extrait("g.txt", debut=5, lignes=3, base=self.base)
        self.assertIn("lignes 5–7 sur 20", out)
        self.assertIn("L5", out)
        self.assertIn("L7", out)
        self.assertNotIn("L8", out)

    def test_chercher_texte(self):
        tools.ecrire_fichier("h.py", "def foo():\n    return 42\n", base=self.base)
        out = tools.chercher_texte("foo", base=self.base)
        self.assertIn("h.py", out)
        self.assertIn(":1:", out)

    def test_supprimer(self):
        tools.ecrire_fichier("del.txt", "x", base=self.base)
        self.assertIn("supprimé", tools.supprimer_fichier("del.txt", base=self.base))
        self.assertFalse(os.path.exists(os.path.join(self.base, "del.txt")))


if __name__ == "__main__":
    unittest.main()
