import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from scripts import build_catalog

FIXTURE = Path(__file__).parent / "fixtures/catalog/v3-wide.csv"
ID = "rutland-regional-medical-center"

class ManualSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.provider = {"id": ID, "name": "Rutland fixture", "format": "csv", "availability": "available_browser_only", "required": True, "officialPageUrl": "https://example.test/pricing", "mrfUrl": "https://example.test/charges.csv"}
        providers = self.root / "providers.json"
        providers.write_text(json.dumps({"providers": [self.provider]}))
        aliases = self.root / "aliases.json"
        aliases.write_text('{"aliases": []}')
        self.args = build_catalog.build_argument_parser().parse_args(["--providers", str(providers), "--aliases", str(aliases), "--cache-dir", str(self.root / "cache"), "--work-db", str(self.root / "work.sqlite"), "--output", str(self.root / "catalog")])

    def test_missing_input_preserves_database_and_output_even_with_allow_errors(self):
        self.args.allow_source_errors = True
        self.args.work_db.write_bytes(b"existing work")
        self.args.output.mkdir()
        sentinel = self.args.output / "manifest.json"
        sentinel.write_text("existing catalogue")
        with patch.object(build_catalog, "connect_database", side_effect=AssertionError("database opened before preflight")) as database, patch.object(build_catalog, "download_source") as download:
            with self.assertRaisesRegex(build_catalog.CatalogBuildError, '--input "rutland-regional-medical-center='):
                build_catalog.run_build(self.args)
            database.assert_not_called()
            download.assert_not_called()
        self.assertEqual(self.args.work_db.read_bytes(), b"existing work")
        self.assertEqual(sentinel.read_text(), "existing catalogue")

    def test_valid_override_builds_without_network(self):
        self.args.input = [f"{ID}={FIXTURE}"]
        with patch.object(build_catalog, "download_source", side_effect=AssertionError("network called")):
            result = build_catalog.run_build(self.args)
        self.assertEqual(result["providers"][0]["status"], "ingested")

    def test_cached_input_resumes_and_refresh_requires_override(self):
        cache = build_catalog.cache_path_for(self.args.cache_dir, self.provider)
        cache.parent.mkdir(parents=True)
        shutil.copyfile(FIXTURE, cache)
        self.assertEqual(build_catalog.check_manual_sources([self.provider], {}, self.args)[ID], cache)
        self.args.refresh = True
        with self.assertRaises(build_catalog.CatalogBuildError):
            build_catalog.check_manual_sources([self.provider], {}, self.args)
        self.args.offline = True
        self.assertEqual(build_catalog.check_manual_sources([self.provider], {}, self.args)[ID], cache)
        self.assertEqual(build_catalog.check_manual_sources([self.provider], {ID: FIXTURE}, self.args)[ID], FIXTURE)

    def test_empty_and_html_input_fail_before_database(self):
        source = self.root / "source.csv"
        for content in ["", "<html>Access denied</html>"]:
            with self.subTest(content=content):
                source.write_text(content)
                self.args.input = [f"{ID}={source}"]
                with patch.object(build_catalog, "connect_database", side_effect=AssertionError("database opened before preflight")) as database:
                    with self.assertRaises(build_catalog.CatalogBuildError):
                        build_catalog.run_build(self.args)
                    database.assert_not_called()

    def test_other_provider_selection_does_not_require_rutland(self):
        other = {**self.provider, "id": "other", "availability": "available"}
        self.args.providers.write_text(json.dumps({"providers": [self.provider, other]}))
        self.args.provider = ["other"]
        self.args.input = [f"other={FIXTURE}"]
        with patch.object(build_catalog, "download_source", side_effect=AssertionError("network called")):
            result = build_catalog.run_build(self.args)
        self.assertEqual(result["providers"][0]["id"], "other")

    def test_existing_override_validation_remains(self):
        for override, message in [(f"unknown={FIXTURE}", "no selected provider"), (f"{ID}={self.root / 'missing'}", "does not exist")]:
            self.args.input = [override]
            with self.assertRaisesRegex(build_catalog.CatalogBuildError, message):
                build_catalog.run_build(self.args)
