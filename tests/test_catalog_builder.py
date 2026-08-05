import argparse
import gzip
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from scripts import build_catalog


FIXTURES = Path(__file__).parent / "fixtures" / "catalog"


class CatalogBuilderTests(unittest.TestCase):
    def test_modifier_normalization_deduplicates_repeated_source_values(self):
        self.assertEqual(build_catalog.normalize_modifier(["SG", "SG", "53", "53"]), "SG|53")
        self.assertEqual(build_catalog.normalize_modifier("26|26|TC"), "26|TC")

    def test_numeric_hcpcs_codes_are_normalized_as_cpt_level_one_codes(self):
        codes = build_catalog.canonical_codes(
            [{"type": "HCPCS", "code": "45378"}, {"type": "CPT", "code": "45378"}]
        )
        self.assertEqual(codes, [{"type": "CPT", "code": "45378"}])

    def test_items_without_a_numeric_price_are_not_publishable(self):
        empty_item = {
            "grossValues": [],
            "cashValues": [],
            "supplementalValues": [],
            "negotiatedValues": [],
            "deidentifiedMin": None,
            "deidentifiedMax": None,
            "negotiatedMin": None,
            "negotiatedMax": None,
        }
        self.assertFalse(build_catalog.item_has_numeric_price(empty_item))
        self.assertTrue(build_catalog.item_has_numeric_price({**empty_item, "cashValues": [(0, "free")] }))

    def build_fixture(self, fixture: Path, source_format: str, provider_id: str = "fixture-provider"):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        providers = root / "providers.json"
        aliases = root / "aliases.json"
        providers.write_text(
            json.dumps(
                {
                    "manifestVersion": "test",
                    "lastVerified": "2026-08-05",
                    "providers": [
                        {
                            "id": provider_id,
                            "name": "Fixture Provider",
                            "town": "Montpelier",
                            "state": "VT",
                            "scopeClass": "acute_care_hospital",
                            "coverageScope": "vermont",
                            "required": True,
                            "availability": "available",
                            "officialPageUrl": "https://example.test/prices",
                            "mrfUrl": "https://example.test/source",
                            "format": source_format,
                            "schemaVersion": "3.0.0",
                            "dataDate": "2026-08-05",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        aliases.write_text(
            json.dumps(
                {
                    "aliases": [
                        {
                            "codeType": "CPT",
                            "code": "45378",
                            "preferredName": "Diagnostic colonoscopy without biopsy",
                            "terms": ["colonoscopy", "colon exam"],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        output = root / "catalog"
        arguments = argparse.Namespace(
            providers=providers,
            aliases=aliases,
            output=output,
            cache_dir=root / "cache",
            work_db=root / "work.sqlite",
            provider=[],
            input=[f"{provider_id}={fixture}"],
            offline=True,
            refresh=False,
            allow_source_errors=False,
            max_shard_mb=8.0,
        )
        manifest = build_catalog.run_build(arguments)
        return root, output, manifest

    def load_group(self, output: Path, group_id: str):
        with gzip.open(output / "search.json.gz", "rt", encoding="utf-8") as handle:
            search = json.load(handle)
        entry = next(item for item in search if item["id"] == group_id)
        with gzip.open(output / "shards" / f"{entry['shard']}.json.gz", "rt", encoding="utf-8") as handle:
            shard = json.load(handle)
        return entry, shard[group_id]

    def test_v3_wide_preserves_codes_context_and_each_cash_policy(self):
        _, output, manifest = self.build_fixture(FIXTURES / "v3-wide.csv", "csv")
        entry, group = self.load_group(output, "CPT:45378")
        self.assertEqual(entry["name"], "Diagnostic colonoscopy without biopsy")
        self.assertEqual(entry["terms"], ["colonoscopy", "colon exam"])
        variant = group["variants"][0]
        self.assertEqual(variant["setting"], "outpatient")
        self.assertEqual(variant["billingClass"], "facility")
        self.assertEqual(variant["modifiers"], "PT")
        self.assertEqual(variant["codes"], [{"type": "CDM", "code": "ABC123"}, {"type": "CPT", "code": "45378"}])
        self.assertEqual(variant["prices"]["gross"], 1000)
        self.assertEqual(variant["prices"]["cash"], 800)
        self.assertEqual(
            variant["prices"]["cashValues"],
            [
                {"amount": 800, "label": "Standard discounted cash"},
                {"amount": 750, "label": "paid within 30 days"},
            ],
        )
        self.assertEqual(variant["prices"]["deidentifiedMin"], 550)
        self.assertEqual(variant["prices"]["deidentifiedMax"], 650)
        self.assertEqual(variant["prices"]["negotiatedCount"], 1)
        self.assertEqual(manifest["counts"]["normalizedVariants"], 2)
        local_entry, _ = self.load_group(output, "local:fixture-provider:LOCAL:LOCAL-2")
        self.assertTrue(local_entry["local"])
        self.assertEqual(local_entry["providerId"], "fixture-provider")

    def test_v3_tall_merges_payer_rows_without_publishing_payer_names(self):
        _, output, _ = self.build_fixture(FIXTURES / "v3-tall.csv", "csv")
        _, group = self.load_group(output, "CPT:73721")
        self.assertEqual(len(group["variants"]), 1)
        variant = group["variants"][0]
        self.assertEqual(variant["sourceRows"], 2)
        self.assertEqual(variant["prices"]["negotiatedMin"], 300)
        self.assertEqual(variant["prices"]["negotiatedMax"], 325)
        self.assertEqual(variant["prices"]["negotiatedCount"], 2)
        published = json.dumps(group)
        self.assertNotIn("Payer Alpha", published)
        self.assertNotIn("Payer Beta", published)
        self.assertNotIn("Plan A", published)

    def test_v2_wide_uses_the_same_normalized_price_contract(self):
        _, output, _ = self.build_fixture(FIXTURES / "v2-wide.csv", "csv")
        _, group = self.load_group(output, "CPT:74177")
        prices = group["variants"][0]["prices"]
        self.assertEqual(prices["gross"], 900)
        self.assertEqual(prices["cash"], 700)
        self.assertEqual(prices["deidentifiedMin"], 500)
        self.assertEqual(prices["deidentifiedMax"], 850)
        self.assertEqual(prices["negotiatedMin"], 625)
        self.assertEqual(prices["negotiatedCount"], 1)

    def test_zip_csv_is_streamed_through_the_csv_parser(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        archive = Path(temporary.name) / "source.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output_zip:
            output_zip.write(FIXTURES / "v3-wide.csv", "nested/standardcharges.csv")
        _, output, _ = self.build_fixture(archive, "zip", "zip-provider")
        _, group = self.load_group(output, "CPT:45378")
        self.assertEqual(group["variants"][0]["providerId"], "zip-provider")

    def test_claraprice_json_stream_preserves_drug_and_modifier_context(self):
        _, output, _ = self.build_fixture(FIXTURES / "claraprice.json", "json", "clara-provider")
        _, group = self.load_group(output, "HCPCS:J1234")
        variant = group["variants"][0]
        self.assertEqual(variant["drug"], {"unit": 10, "type": "UN"})
        self.assertEqual(variant["modifiers"], "JW")
        self.assertEqual(variant["prices"]["negotiatedMin"], 70)
        self.assertEqual(variant["prices"]["negotiatedMax"], 85)
        self.assertEqual(variant["prices"]["negotiatedCount"], 2)
        published = json.dumps(group)
        self.assertNotIn("Payer Red", published)
        self.assertNotIn("Payer Blue", published)

    def test_gmsc_adapter_keeps_comparator_rates_out_of_gross_and_cash(self):
        _, output, _ = self.build_fixture(
            FIXTURES / "supplemental-gmsc.json", "supplemental-json", "gmsc-provider"
        )
        _, group = self.load_group(output, "CPT:45378")
        variant = group["variants"][0]
        self.assertEqual(variant["setting"], "outpatient")
        self.assertEqual(variant["billingClass"], "facility")
        self.assertEqual(variant["sourceRow"], 5)
        self.assertEqual(variant["sourcePage"], "https://example.test/gmsc.pdf")
        prices = variant["prices"]
        self.assertEqual(prices["gross"], 1612)
        self.assertNotIn("cash", prices)
        self.assertEqual(prices["negotiatedMin"], 1085)
        self.assertEqual(prices["negotiatedMax"], 1245)
        self.assertEqual(prices["negotiatedCount"], 2)
        self.assertEqual(
            prices["supplementalValues"],
            [
                {"amount": 364.32, "label": "GMSC Medicare Rate"},
                {"amount": 950.1, "label": "HOPD Medicare Rate"},
            ],
        )

    def test_reviewed_supplemental_contract_uses_the_hospital_variant_schema(self):
        _, output, _ = self.build_fixture(
            FIXTURES / "supplemental-reviewed.json",
            "supplemental-json",
            "independent-imaging",
        )
        _, group = self.load_group(output, "CPT:73721")
        variant = group["variants"][0]
        self.assertEqual(variant["providerId"], "independent-imaging")
        self.assertEqual(variant["sourcePage"], "https://example.test/independent-mri-prices")
        self.assertEqual(variant["prices"]["gross"], 725)
        self.assertEqual(variant["prices"]["cash"], 500)
        self.assertEqual(variant["prices"]["deidentifiedMin"], 410)
        self.assertEqual(variant["prices"]["deidentifiedMax"], 690)
        self.assertEqual(variant["prices"]["negotiatedCount"], 4)
        self.assertEqual(
            variant["prices"]["supplementalValues"],
            [{"amount": 600, "label": "Published comparison rate"}],
        )


if __name__ == "__main__":
    unittest.main()
