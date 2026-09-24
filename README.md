<h1 align="center">Vermont Price Compare</h1>

<p align="center">
  <strong>Search provider-published healthcare prices across Vermont from one static site.</strong>
</p>

<p align="center">
  <code>hospital catalogues</code> &bull; <code>procedure and billing codes</code> &bull; <code>client-side search</code>
</p>

---

Vermont Price Compare turns provider price files into a searchable catalogue. It supports procedure names, CPT, HCPCS, DRG, revenue codes, and provider-local codes.

The private preview is live at [oliverames.github.io/vermont-price-compare](https://oliverames.github.io/vermont-price-compare/). Enter `cows` when the site asks for the preview password.

> [!CAUTION]
> The password form is a client-side preview gate, not secure access control. GitHub Pages serves static files, so visitors can inspect the password and request catalogue files directly. Do not use this gate to protect confidential data.

## Why this exists

Healthcare providers publish prices in different formats, with different code systems and billing assumptions. A person who needs one procedure should not have to locate and interpret every source file first.

This project normalizes those files without treating unlike prices as equivalent. It preserves price types and service variants, then links each result to the provider's source.

## What the catalogue covers

The inventory accounts for all 16 Vermont hospitals in the project configuration. This includes 14 community hospitals, Brattleboro Retreat, and Vermont Psychiatric Care Hospital. It also includes Mary Hitchcock Memorial Hospital in Lebanon, New Hampshire, which is commonly known as Dartmouth Hitchcock Medical Center.

The inventory tracks independent Vermont facilities whose public price pages were checked. Examples include Green Mountain Surgery Center, Vermont OPEN Imaging, Vermont Diagnostic Imaging, Vermont Eye Surgery Laser Center, and several urgent care providers.

Coverage does not mean that every provider supplied a complete catalogue:

- Hospital machine-readable files are ingested when the official source is available and supported.
- Vermont Psychiatric Care Hospital remains an explicit gap because no public machine-readable price file was found during the August 5, 2026 review.
- Green Mountain Surgery Center publishes selected facility prices rather than a complete hospital-style file.
- Vermont OPEN Imaging and Vermont Diagnostic Imaging publish selected prices or category amounts, not complete procedure catalogues.
- Vermont Eye Surgery Laser Center and the reviewed urgent care providers do not publish browsable procedure-price catalogues.

The current build tracks 25 providers and price sources. It processed 19 sources into 444,435 service variants and 210,442 searchable items. Six providers remain visible as public-data gaps.

The live coverage ledger shows each provider, source date, and ingestion status. Federal hospital price-transparency requirements apply to hospitals. They do not require every independent clinician or outpatient facility to publish a hospital-style file. Vermont also does not publish a public statewide roster of registered imaging facilities, so the independent imaging inventory is audited but cannot claim statewide completeness.

## Primary sources

Primary references include the [Vermont hospital report cards](https://www.healthvermont.gov/systems/hospitals-health-systems/hospital-report-cards) and [CMS hospital price-transparency guidance](https://www.cms.gov/priorities/key-initiatives/hospital-price-transparency). Provider source links appear in the site's coverage ledger.

## How to read the prices

The interface keeps each price type separate:

| Price type | Meaning |
|------------|---------|
| Discounted cash | The provider's published cash amount. A source may contain more than one labeled cash policy. |
| Gross charge | The provider's undiscounted list charge. |
| Negotiated dollar range | The lowest and highest numeric negotiated dollar amounts in the source row. Commercial payer and plan identities are excluded. |
| Deidentified range | The minimum and maximum negotiated amounts that the provider publishes without an identity. |
| Other published rate | A source-labeled category ceiling, comparison rate, or example from an independent facility. Each label remains separate. |

The site never combines these price types in one ranking. It also separates inpatient, outpatient, facility, professional, modifier, and drug variants when the source distinguishes them.

Multiple source rows for one provider and service variant appear as a range. The details view preserves each published amount. Local codes remain provider-specific because they cannot support a reliable cross-provider comparison.

Published prices are not patient estimates. Separate clinician, anesthesia, pathology, facility, or other bills may apply. Confirm the code and request an estimate from the provider and health plan.

## Architecture

The site has no runtime service or database. GitHub Pages serves a compact generated catalogue, and the browser searches it in a Web Worker.

```text
config/providers.json          Provider inventory and official source metadata
config/procedure-aliases.json  Plain-language aliases for common codes
scripts/build_catalog.py       Streaming source importer
catalog/manifest.json          Coverage, counts, and source dates
catalog/search.json.gz         Compact search index
catalog/shards/*.json.gz       Procedure groups and price variants
search-worker.js               Background catalogue search
app.js                         Results and coverage interface
access-gate.js                 Casual private-preview gate
```

The builder streams large CSV, JSON, and ZIP sources through SQLite. It then creates a gzip search index and two-character hexadecimal shards. The catalogue retains numeric amounts and source context, but excludes commercial payer and plan identities.

## Local development

Serve the repository root, then open [localhost:4173](http://localhost:4173/):

```bash
/opt/homebrew/bin/python3 -m http.server 4173
```

Run JavaScript syntax checks, catalogue integrity tests, and Python importer tests:

```bash
npm run check
```

The Node tests decompress every shard, validate the manifest and search schema, and confirm each search item resolves to its shard. They also verify provider uniqueness and payer-identity exclusions.

## Rebuilding the catalogue

Run the streaming builder from the repository root:

```bash
/opt/homebrew/bin/python3 scripts/build_catalog.py
```

Rutland Regional Medical Center rejects the builder’s current direct download request (HTTP 403, verified September 24, 2026). Before a rebuild that includes Rutland, open its [official pricing page](https://www.rrmc.org/patient-visitors/billing-insurance/pricing-estimates/) in a browser, download the standard-charges CSV, and provide the verified local path:

```bash
/opt/homebrew/bin/python3 scripts/build_catalog.py \
  --input "rutland-regional-medical-center=/absolute/path/to/030183483_RutlandRegionalMedicalCenter_standardcharges.csv"
```

The builder checks browser-only inputs before opening the work database or writing catalogue artifacts. Missing, empty, or non-CSV inputs stop the build with a concrete `--input` instruction, even with `--allow-source-errors`. A saved browser error page is not a valid source. The preflight checks the CMS header and first item; normal streaming ingestion validates the rest.

Repeat the same `--input` option when resuming a build. An existing valid source cache can also be reused in normal or `--offline` mode. `--refresh` requires a new explicit local override for Rutland, unless `--offline` is also set. Builds selecting only other providers do not require Rutland input. Request headers and download policy are unchanged.

The builder writes deployable artifacts to `catalog/`. Raw hospital files stay in `.cache/catalog/sources/` or at the supplied local path. Git excludes them because they are large source records that providers can replace independently.

The committed `catalog/` directory is the GitHub Pages data source. Do not commit `.cache/`, the SQLite work database, or downloaded raw files.

## Data limits

- The catalogue reflects sources verified on August 5, 2026. Each provider can publish a different internal data date.
- A missing price does not mean that a provider does not perform the service.
- A listed amount may cover only one billing component.
- Negotiated ranges omit percentage, formula, and algorithm-based rates that cannot become reliable dollar comparisons.
- Emergency care decisions should never depend on this site.

This independent prototype is not affiliated with a healthcare provider or government agency. It does not provide medical or financial advice.
