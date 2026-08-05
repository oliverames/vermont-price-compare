#!/usr/bin/env python3
"""Build a compact static catalog from hospital price-transparency files.

The importer streams CSV and ZIP sources, incrementally decodes the large array
inside CMS JSON sources, and uses SQLite as bounded-memory working storage. The
published artifacts intentionally exclude payer and plan names. They retain the
numeric negotiated-dollar range and count for each normalized item variant.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile


CATALOG_SCHEMA_VERSION = "1.0.0"
DEFAULT_MAX_SHARD_BYTES = 8 * 1024 * 1024
JSON_CHUNK_SIZE = 1024 * 1024

KNOWN_STANDARD_CODE_TYPES = {
    "CPT",
    "NDC",
    "HCPCS",
    "RC",
    "ICD",
    "DRG",
    "MS-DRG",
    "R-DRG",
    "S-DRG",
    "APS-DRG",
    "AP-DRG",
    "APR-DRG",
    "APC",
    "EAPG",
    "HIPPS",
    "CDT",
    "TRIS-DRG",
    "CMG",
    "MS-LTC-DRG",
}
LOCAL_CODE_TYPES = {"LOCAL", "CDM", "UNSPECIFIED"}
SUPPORTED_FORMATS = {"csv", "json", "zip", "supplemental-json"}


class CatalogBuildError(RuntimeError):
    """Raised when a catalog source or artifact cannot be built safely."""


def _utf8_cp1252_fallback(error: UnicodeDecodeError) -> tuple[str, int]:
    """Preserve valid UTF-8 while mapping isolated legacy bytes through cp1252."""

    raw = error.object[error.start : error.end]
    return raw.decode("cp1252", errors="replace"), error.end


try:
    import codecs

    codecs.lookup_error("vpc_cp1252")
except LookupError:
    codecs.register_error("vpc_cp1252", _utf8_cp1252_fallback)


def clean_text(value: object) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\x00", "").split())


def normalize_header(value: object) -> str:
    text = clean_text(value).lstrip("\ufeff").lower()
    text = re.sub(r"\s*\|\s*", "|", text)
    text = re.sub(r"[\s-]+", "_", text)
    return text.strip("_")


def normalize_code_type(value: object) -> str:
    text = clean_text(value).upper().replace("_", "-")
    text = re.sub(r"\s+", "-", text)
    aliases = {
        "CPT/HCPCS": "HCPCS",
        "REV": "RC",
        "REVENUE": "RC",
        "REVENUE-CODE": "RC",
        "MSDRG": "MS-DRG",
        "APRDRG": "APR-DRG",
    }
    return aliases.get(text, text or "UNSPECIFIED")


def parse_number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = clean_text(value)
        if not text or text.lower() in {"n/a", "na", "null", "none", "-", "--"}:
            return None
        negative = text.startswith("(") and text.endswith(")")
        text = text.strip("()$%").replace(",", "")
        try:
            number = float(text)
        except ValueError:
            return None
        if negative:
            number = -number
    if number < 0 or number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def json_number(value: float) -> int | float:
    if value.is_integer():
        return int(value)
    return round(value, 6)


def canonical_codes(raw_codes: list[dict[str, object]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw in raw_codes:
        code = clean_text(raw.get("code"))
        if not code:
            continue
        code_type = normalize_code_type(raw.get("type"))
        if code_type == "HCPCS" and re.fullmatch(r"\d{5}", code):
            code_type = "CPT"
        key = (code_type, code)
        if key in seen:
            continue
        seen.add(key)
        result.append({"type": code_type, "code": code})
    return result


def normalize_modifier(value: object) -> str:
    raw_values = value if isinstance(value, list) else [value]
    modifiers: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        for modifier in re.split(r"[|,;]+", clean_text(raw)):
            modifier = modifier.strip().upper()
            if not modifier or modifier in seen:
                continue
            seen.add(modifier)
            modifiers.append(modifier)
    return "|".join(modifiers)


def normalize_drug(value: object, fallback_unit: object = None, fallback_type: object = None) -> dict[str, object] | None:
    if isinstance(value, dict):
        unit_raw = value.get("unit", value.get("drug_unit_of_measurement"))
        type_raw = value.get("type", value.get("drug_type_of_measurement"))
    else:
        unit_raw = fallback_unit
        type_raw = fallback_type
    unit = parse_number(unit_raw)
    drug_type = clean_text(type_raw).upper()
    if unit is None and not drug_type:
        return None
    result: dict[str, object] = {}
    if unit is not None:
        result["unit"] = json_number(unit)
    if drug_type:
        result["type"] = drug_type
    return result


def local_code_type(code_type: str) -> bool:
    return code_type in LOCAL_CODE_TYPES or code_type not in KNOWN_STANDARD_CODE_TYPES


def group_identity(provider_id: str, code_type: str, code: str) -> tuple[str, bool, str | None]:
    if local_code_type(code_type):
        return f"local:{provider_id}:{code_type}:{code}", True, provider_id
    return f"{code_type}:{code}", False, None


def uncoded_identity(provider_id: str, variant_key: str) -> tuple[str, bool, str]:
    return f"uncoded:{provider_id}:{variant_key[:20]}", True, provider_id


def shard_for(group_id: str) -> str:
    return hashlib.sha256(group_id.encode("utf-8")).hexdigest()[:2]


def load_json(path: Path) -> object:
    with path.open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def load_providers(path: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    payload = load_json(path)
    if isinstance(payload, list):
        root: dict[str, object] = {"providers": payload}
        raw_providers = payload
    elif isinstance(payload, dict):
        root = payload
        raw_providers = payload.get("providers", [])
    else:
        raise CatalogBuildError(f"Provider manifest must be an object or array: {path}")
    if not isinstance(raw_providers, list):
        raise CatalogBuildError(f"Provider manifest 'providers' must be an array: {path}")
    providers: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in raw_providers:
        if not isinstance(raw, dict):
            raise CatalogBuildError("Each provider entry must be an object")
        provider_id = clean_text(raw.get("id"))
        if not provider_id:
            raise CatalogBuildError("Each provider entry needs an id")
        if provider_id in seen:
            raise CatalogBuildError(f"Duplicate provider id: {provider_id}")
        seen.add(provider_id)
        providers.append(dict(raw))
    return root, providers


def load_aliases(path: Path | None) -> dict[tuple[str, str], dict[str, object]]:
    if path is None or not path.exists():
        return {}
    payload = load_json(path)
    if isinstance(payload, dict):
        rows = payload.get("aliases", [])
    elif isinstance(payload, list):
        rows = payload
    else:
        raise CatalogBuildError(f"Alias file must be an object or array: {path}")
    aliases: dict[tuple[str, str], dict[str, object]] = {}
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        code_type = normalize_code_type(raw.get("codeType", raw.get("type")))
        code = clean_text(raw.get("code"))
        if not code:
            continue
        aliases[(code_type, code)] = {
            "preferredName": clean_text(raw.get("preferredName")),
            "terms": [clean_text(term) for term in raw.get("terms", []) if clean_text(term)],
        }
    return aliases


def cache_path_for(cache_dir: Path, provider: dict[str, object]) -> Path:
    provider_id = clean_text(provider["id"])
    url = clean_text(provider.get("mrfUrl"))
    source_format = clean_text(provider.get("format")).lower()
    extension = {"csv": ".csv", "json": ".json", "zip": ".zip"}.get(source_format)
    if extension is None:
        extension = Path(urllib.parse.urlparse(url).path).suffix or ".source"
    fingerprint = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return cache_dir / f"{provider_id}-{fingerprint}{extension}"


def supplemental_spec(
    provider: dict[str, object],
    manifest_dir: Path,
) -> tuple[str, Path | str] | None:
    """Return a reviewed supplemental catalog as either a local path or URL."""

    raw = provider.get("supplementalCatalog")
    if not raw:
        return None
    if isinstance(raw, str):
        value = raw
    elif isinstance(raw, dict):
        value = clean_text(raw.get("path", raw.get("url")))
    else:
        raise CatalogBuildError(
            f"supplementalCatalog must be a path, URL, or object for {provider.get('id')}"
        )
    if not value:
        raise CatalogBuildError(f"supplementalCatalog is empty for {provider.get('id')}")
    if value.startswith(("https://", "http://")):
        return "url", value
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = manifest_dir / path
    return "path", path.resolve()


def supplemental_cache_path(cache_dir: Path, provider: dict[str, object], url: str) -> Path:
    provider_id = clean_text(provider["id"])
    fingerprint = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return cache_dir / f"{provider_id}-supplemental-{fingerprint}.json"


def download_source(url: str, destination: Path, refresh: bool = False) -> Path:
    if destination.exists() and destination.stat().st_size > 0 and not refresh:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_name(destination.name + ".part")
    if part.exists():
        part.unlink()
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; VermontPriceCompare/1.0; +https://github.com/oliverames/vermont-price-compare)",
            "Accept": "text/csv, application/json, application/zip, application/octet-stream, */*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response, part.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
    except (OSError, urllib.error.URLError) as error:
        if part.exists():
            part.unlink()
        raise CatalogBuildError(f"Download failed for {url}: {error}") from error
    if not part.exists() or part.stat().st_size == 0:
        raise CatalogBuildError(f"Download returned an empty file: {url}")
    os.replace(part, destination)
    return destination


@contextlib.contextmanager
def open_csv_source(path: Path, source_format: str):
    stack = contextlib.ExitStack()
    try:
        if source_format == "zip":
            archive = stack.enter_context(zipfile.ZipFile(path))
            members = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith(".csv")]
            if not members:
                raise CatalogBuildError(f"ZIP source contains no CSV file: {path}")
            member = max(members, key=lambda item: item.file_size)
            binary = stack.enter_context(archive.open(member, "r"))
        else:
            binary = stack.enter_context(path.open("rb"))
        text = stack.enter_context(
            io.TextIOWrapper(binary, encoding="utf-8-sig", errors="vpc_cp1252", newline="")
        )
        yield text
    finally:
        stack.close()


def _csv_field_limit() -> None:
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit //= 10


def _column_indices(headers: list[str]) -> dict[str, object]:
    exact: dict[str, int] = {}
    codes: dict[int, int] = {}
    code_types: dict[int, int] = {}
    gross: list[int] = []
    cash: list[int] = []
    negotiated: list[int] = []
    deidentified_min: list[int] = []
    deidentified_max: list[int] = []
    for index, name in enumerate(headers):
        exact.setdefault(name, index)
        code_match = re.fullmatch(r"code\|(\d+)", name)
        type_match = re.fullmatch(r"code\|(\d+)\|type", name)
        if code_match:
            codes[int(code_match.group(1))] = index
        elif type_match:
            code_types[int(type_match.group(1))] = index
        elif name == "standard_charge|gross" or name.startswith("standard_charge|gross|"):
            gross.append(index)
        elif name.startswith("standard_charge|discounted_cash"):
            cash.append(index)
        elif name.startswith("standard_charge|") and name.endswith("|negotiated_dollar"):
            negotiated.append(index)
        elif name in {
            "standard_charge|min",
            "standard_charge|minimum",
            "standard_charge|deidentified_minimum",
            "standard_charge|de_identified_minimum",
        }:
            deidentified_min.append(index)
        elif name in {
            "standard_charge|max",
            "standard_charge|maximum",
            "standard_charge|deidentified_maximum",
            "standard_charge|de_identified_maximum",
        }:
            deidentified_max.append(index)
    if not codes and "code" in exact:
        codes[1] = exact["code"]
    if not code_types:
        for candidate in ("code_type", "code|type", "type"):
            if candidate in exact:
                code_types[1] = exact[candidate]
                break
    return {
        "exact": exact,
        "codes": codes,
        "codeTypes": code_types,
        "gross": gross,
        "cash": cash,
        "negotiated": negotiated,
        "deidentifiedMin": deidentified_min,
        "deidentifiedMax": deidentified_max,
    }


def _cash_label(raw_header: str, normalized_header: str) -> str:
    marker = "discounted_cash"
    position = normalized_header.find(marker)
    if position < 0:
        return ""
    suffix = normalized_header[position + len(marker) :].strip("|_ -")
    if not suffix:
        return ""
    return clean_text(suffix.replace("_", " "))


def _values_at(row: list[str], indices: list[int]) -> list[float]:
    values: list[float] = []
    for index in indices:
        if index >= len(row):
            continue
        number = parse_number(row[index])
        if number is not None:
            values.append(number)
    return values


def iter_csv_items(path: Path, source_format: str, stats: dict[str, object]):
    _csv_field_limit()
    with open_csv_source(path, source_format) as handle:
        reader = csv.reader(handle)
        prelude: list[list[str]] = []
        raw_headers: list[str] | None = None
        for _ in range(20):
            try:
                candidate = next(reader)
            except StopIteration as error:
                raise CatalogBuildError(f"CSV source has no item header: {path}") from error
            normalized = [normalize_header(value) for value in candidate]
            if "description" in normalized and any(name.startswith("standard_charge|") for name in normalized):
                raw_headers = candidate
                headers = normalized
                break
            prelude.append(candidate)
        if raw_headers is None:
            raise CatalogBuildError(f"Could not locate the CMS item header in {path}")

        metadata: dict[str, str] = {}
        if len(prelude) >= 2:
            for key, value in zip(prelude[-2], prelude[-1]):
                normalized_key = normalize_header(key)
                if normalized_key:
                    metadata[normalized_key] = clean_text(value)
        stats["reportedHospitalName"] = metadata.get("hospital_name")
        stats["reportedDataDate"] = metadata.get("last_updated_on")
        stats["reportedSchemaVersion"] = metadata.get("version")

        columns = _column_indices(headers)
        exact: dict[str, int] = columns["exact"]  # type: ignore[assignment]
        code_indices: dict[int, int] = columns["codes"]  # type: ignore[assignment]
        type_indices: dict[int, int] = columns["codeTypes"]  # type: ignore[assignment]
        gross_indices: list[int] = columns["gross"]  # type: ignore[assignment]
        cash_indices: list[int] = columns["cash"]  # type: ignore[assignment]
        negotiated_indices: list[int] = columns["negotiated"]  # type: ignore[assignment]
        min_indices: list[int] = columns["deidentifiedMin"]  # type: ignore[assignment]
        max_indices: list[int] = columns["deidentifiedMax"]  # type: ignore[assignment]
        tall = "payer_name" in exact and "plan_name" in exact
        stats["schemaLayout"] = "tall" if tall else "wide"
        stats["columnCount"] = len(headers)

        def get(row: list[str], name: str) -> str:
            index = exact.get(name)
            return row[index] if index is not None and index < len(row) else ""

        header_record = len(prelude) + 1
        source_record = header_record
        for row in reader:
            source_record += 1
            if not row or not any(clean_text(value) for value in row):
                continue
            stats["sourceRows"] = int(stats.get("sourceRows", 0)) + 1
            raw_codes: list[dict[str, object]] = []
            for position in sorted(set(code_indices) | set(type_indices)):
                code_index = code_indices.get(position)
                type_index = type_indices.get(position)
                code = row[code_index] if code_index is not None and code_index < len(row) else ""
                code_type = row[type_index] if type_index is not None and type_index < len(row) else ""
                if clean_text(code):
                    raw_codes.append({"code": code, "type": code_type})
            gross_values = [(number, "") for number in _values_at(row, gross_indices)]
            cash_values: list[tuple[float, str]] = []
            for index in cash_indices:
                if index >= len(row):
                    continue
                number = parse_number(row[index])
                if number is not None:
                    cash_values.append((number, _cash_label(raw_headers[index], headers[index])))
            deidentified_min_values = _values_at(row, min_indices)
            deidentified_max_values = _values_at(row, max_indices)
            drug = normalize_drug(
                None,
                get(row, "drug_unit_of_measurement"),
                get(row, "drug_type_of_measurement"),
            )
            yield {
                "description": clean_text(get(row, "description")) or "Unlabeled hospital item",
                "codes": canonical_codes(raw_codes),
                "setting": clean_text(get(row, "setting")).lower(),
                "billingClass": clean_text(get(row, "billing_class")).lower(),
                "modifiers": normalize_modifier(get(row, "modifiers")),
                "drug": drug,
                "grossValues": gross_values,
                "cashValues": cash_values,
                "deidentifiedMin": min(deidentified_min_values) if deidentified_min_values else None,
                "deidentifiedMax": max(deidentified_max_values) if deidentified_max_values else None,
                "negotiatedValues": _values_at(row, negotiated_indices),
                "sourceRow": source_record,
            }


def iter_json_array(path: Path, key: str):
    """Incrementally decode objects in a named top-level JSON array."""

    decoder = json.JSONDecoder()
    key_pattern = re.compile(rf'"{re.escape(key)}"\s*:\s*\[')
    with path.open(encoding="utf-8-sig", errors="vpc_cp1252") as handle:
        buffer = ""
        eof = False
        while True:
            match = key_pattern.search(buffer)
            if match:
                buffer = buffer[match.end() :]
                break
            chunk = handle.read(JSON_CHUNK_SIZE)
            if not chunk:
                raise CatalogBuildError(f"JSON source has no {key!r} array: {path}")
            buffer += chunk
            if len(buffer) > JSON_CHUNK_SIZE * 4:
                buffer = buffer[-JSON_CHUNK_SIZE * 2 :]
        while True:
            buffer = buffer.lstrip()
            if buffer.startswith(","):
                buffer = buffer[1:].lstrip()
            if buffer.startswith("]"):
                return
            while True:
                try:
                    item, end = decoder.raw_decode(buffer)
                    break
                except json.JSONDecodeError as error:
                    if eof:
                        raise CatalogBuildError(f"Invalid or truncated JSON array in {path}: {error}") from error
                    chunk = handle.read(JSON_CHUNK_SIZE)
                    if chunk:
                        buffer += chunk
                    else:
                        eof = True
            yield item
            buffer = buffer[end:]


def _json_scalar_near_edges(path: Path, key: str) -> str | None:
    size = path.stat().st_size
    with path.open("rb") as handle:
        head = handle.read(min(size, 256 * 1024))
        tail = b""
        if size > len(head):
            handle.seek(max(0, size - 256 * 1024))
            tail = handle.read()
    text = (head + b"\n" + tail).decode("utf-8", errors="vpc_cp1252")
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"((?:\\.|[^"\\])*)"', text)
    if not match:
        return None
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return clean_text(match.group(1))


def iter_claraprice_json_items(path: Path, stats: dict[str, object]):
    stats["schemaLayout"] = "json"
    stats["reportedHospitalName"] = _json_scalar_near_edges(path, "hospital_name")
    stats["reportedDataDate"] = _json_scalar_near_edges(path, "last_updated_on")
    stats["reportedSchemaVersion"] = _json_scalar_near_edges(path, "version")
    for source_row, item in enumerate(iter_json_array(path, "standard_charge_information"), start=1):
        if not isinstance(item, dict):
            continue
        stats["sourceRows"] = int(stats.get("sourceRows", 0)) + 1
        codes = canonical_codes(item.get("code_information", [])) if isinstance(item.get("code_information"), list) else []
        description = clean_text(item.get("description")) or "Unlabeled hospital item"
        item_drug = normalize_drug(item.get("drug_information"))
        charges = item.get("standard_charges")
        if not isinstance(charges, list) or not charges:
            charges = [item]
        for charge in charges:
            if not isinstance(charge, dict):
                continue
            payers = charge.get("payers_information", [])
            negotiated: list[float] = []
            if isinstance(payers, list):
                for payer in payers:
                    if not isinstance(payer, dict):
                        continue
                    number = parse_number(
                        payer.get("standard_charge_dollar", payer.get("negotiated_dollar"))
                    )
                    if number is not None:
                        negotiated.append(number)
            gross = parse_number(charge.get("gross_charge", charge.get("gross")))
            cash = parse_number(charge.get("discounted_cash"))
            yield {
                "description": description,
                "codes": codes,
                "setting": clean_text(charge.get("setting", item.get("setting"))).lower(),
                "billingClass": clean_text(
                    charge.get("billing_class", item.get("billing_class"))
                ).lower(),
                "modifiers": normalize_modifier(
                    charge.get(
                        "modifier_code",
                        charge.get("modifiers", item.get("modifier_code", item.get("modifiers"))),
                    )
                ),
                "drug": item_drug,
                "grossValues": [(gross, "")] if gross is not None else [],
                "cashValues": [(cash, "")] if cash is not None else [],
                "deidentifiedMin": parse_number(
                    charge.get("minimum", charge.get("deidentified_minimum"))
                ),
                "deidentifiedMax": parse_number(
                    charge.get("maximum", charge.get("deidentified_maximum"))
                ),
                "negotiatedValues": negotiated,
                "sourceRow": source_row,
                "sourcePage": "",
            }


def _supplemental_price_values(prices: dict[str, object], kind: str) -> list[tuple[float, str]]:
    values: list[tuple[float, str]] = []
    direct = parse_number(prices.get(kind))
    if direct is not None:
        values.append((direct, ""))
    raw_values = prices.get(f"{kind}Values", [])
    if isinstance(raw_values, list):
        for raw in raw_values:
            if isinstance(raw, dict):
                amount = parse_number(raw.get("amount"))
                label = clean_text(raw.get("label"))
            else:
                amount = parse_number(raw)
                label = ""
            if amount is not None:
                values.append((amount, label))
    return values


def iter_supplemental_json_items(path: Path, stats: dict[str, object]):
    payload = load_json(path)
    if isinstance(payload, dict):
        if isinstance(payload.get("items"), list):
            raw_items = payload["items"]
            adapter = "reviewed-items"
        elif isinstance(payload.get("procedures"), list):
            raw_items = payload["procedures"]
            adapter = "gmsc-procedures"
        else:
            raw_items = []
            adapter = "reviewed-items"
        stats["reportedDataDate"] = clean_text(
            payload.get(
                "dataDate",
                payload.get(
                    "lastUpdatedOn",
                    payload.get("catalog", {}).get("effectiveDate")
                    if isinstance(payload.get("catalog"), dict)
                    else None,
                ),
            )
        ) or None
        stats["reportedSchemaVersion"] = clean_text(payload.get("schemaVersion")) or None
    elif isinstance(payload, list):
        raw_items = payload
        adapter = "reviewed-items"
    else:
        raise CatalogBuildError(f"Supplemental catalog must be an object or array: {path}")
    if not isinstance(raw_items, list):
        raise CatalogBuildError(f"Supplemental catalog 'items' must be an array: {path}")
    stats["schemaLayout"] = f"supplemental-json:{adapter}"
    for source_row, raw in enumerate(raw_items, start=1):
        if not isinstance(raw, dict):
            continue
        stats["sourceRows"] = int(stats.get("sourceRows", 0)) + 1
        if adapter == "gmsc-procedures":
            source_prices = raw.get("prices", [])
            by_type: dict[str, dict[str, object]] = {}
            if isinstance(source_prices, list):
                for price in source_prices:
                    if isinstance(price, dict):
                        by_type[clean_text(price.get("priceType"))] = price

            def gmsc_amount(price_type: str) -> float | None:
                price = by_type.get(price_type, {})
                return parse_number(price.get("amount"))

            gross = gmsc_amount("gmsc_charge")
            negotiated_low = gmsc_amount("gmsc_lowest_commercial_rate")
            negotiated_high = gmsc_amount("gmsc_highest_commercial_rate")
            commercial_count = int(negotiated_low is not None) + int(negotiated_high is not None)
            labeled_values: list[tuple[float, str]] = []
            for price_type in ("gmsc_medicare_rate", "hopd_medicare_rate"):
                price = by_type.get(price_type, {})
                amount = parse_number(price.get("amount"))
                if amount is not None:
                    labeled_values.append(
                        (amount, clean_text(price.get("priceTypeLabel")) or price_type)
                    )
            source_url = clean_text(
                next(
                    (
                        price.get("sourceUrl")
                        for price in by_type.values()
                        if clean_text(price.get("sourceUrl"))
                    ),
                    "",
                )
            )
            yield {
                "description": clean_text(raw.get("description")) or "Unlabeled provider item",
                "codes": canonical_codes(
                    [{"code": raw.get("code"), "type": raw.get("codeSystem")}]
                ),
                "setting": "outpatient",
                "billingClass": "facility",
                "modifiers": "",
                "drug": None,
                "grossValues": [(gross, "")] if gross is not None else [],
                "cashValues": [],
                "supplementalValues": labeled_values,
                "deidentifiedMin": None,
                "deidentifiedMax": None,
                "negotiatedValues": [],
                "negotiatedMin": negotiated_low,
                "negotiatedMax": negotiated_high,
                "negotiatedCount": commercial_count,
                "sourceRow": int(parse_number(raw.get("sourceRow")) or source_row),
                "sourcePage": source_url,
            }
            continue
        raw_codes = raw.get("codes", [])
        if not isinstance(raw_codes, list):
            raw_codes = []
        if not raw_codes and clean_text(raw.get("code")):
            raw_codes = [
                {
                    "code": raw.get("code"),
                    "type": raw.get("codeType", raw.get("type")),
                }
            ]
        prices = raw.get("prices", {})
        if not isinstance(prices, dict):
            prices = {}
        negotiated_min = parse_number(prices.get("negotiatedMin"))
        negotiated_max = parse_number(prices.get("negotiatedMax"))
        negotiated_count_number = parse_number(prices.get("negotiatedCount"))
        yield {
            "description": clean_text(raw.get("description", raw.get("name")))
            or "Unlabeled provider item",
            "codes": canonical_codes(raw_codes),
            "setting": clean_text(raw.get("setting")).lower(),
            "billingClass": clean_text(raw.get("billingClass", raw.get("billing_class"))).lower(),
            "modifiers": normalize_modifier(raw.get("modifiers")),
            "drug": normalize_drug(raw.get("drug")),
            "grossValues": _supplemental_price_values(prices, "gross"),
            "cashValues": _supplemental_price_values(prices, "cash"),
            "supplementalValues": _supplemental_price_values(prices, "supplemental"),
            "deidentifiedMin": parse_number(prices.get("deidentifiedMin")),
            "deidentifiedMax": parse_number(prices.get("deidentifiedMax")),
            "negotiatedValues": [],
            "negotiatedMin": negotiated_min,
            "negotiatedMax": negotiated_max,
            "negotiatedCount": int(negotiated_count_number or 0),
            "sourceRow": int(parse_number(raw.get("sourceRow")) or source_row),
            "sourcePage": clean_text(raw.get("sourcePage")),
        }


def connect_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode=MEMORY;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=MEMORY;
        PRAGMA cache_size=-200000;

        CREATE TABLE variants (
          provider_id TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          description TEXT NOT NULL,
          setting TEXT NOT NULL,
          billing_class TEXT NOT NULL,
          modifiers TEXT NOT NULL,
          drug_json TEXT,
          codes_json TEXT NOT NULL,
          source_page TEXT NOT NULL,
          first_source_row INTEGER NOT NULL,
          source_row_count INTEGER NOT NULL DEFAULT 1,
          deidentified_min REAL,
          deidentified_max REAL,
          negotiated_min REAL,
          negotiated_max REAL,
          negotiated_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (provider_id, variant_key)
        ) WITHOUT ROWID;

        CREATE TABLE price_values (
          provider_id TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          amount REAL NOT NULL,
          label TEXT NOT NULL,
          PRIMARY KEY (provider_id, variant_key, kind, amount, label)
        ) WITHOUT ROWID;

        CREATE TABLE groups (
          group_id TEXT PRIMARY KEY,
          code TEXT NOT NULL,
          code_type TEXT NOT NULL,
          local INTEGER NOT NULL,
          provider_id TEXT,
          shard TEXT NOT NULL,
          name TEXT,
          provider_count INTEGER NOT NULL DEFAULT 0,
          terms_json TEXT
        ) WITHOUT ROWID;

        CREATE TABLE group_links (
          group_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          variant_key TEXT NOT NULL,
          PRIMARY KEY (group_id, provider_id, variant_key)
        ) WITHOUT ROWID;

        CREATE TABLE group_names (
          group_id TEXT NOT NULL,
          description TEXT NOT NULL,
          occurrence_count INTEGER NOT NULL,
          PRIMARY KEY (group_id, description)
        ) WITHOUT ROWID;

        CREATE INDEX group_links_variant ON group_links(provider_id, variant_key);
        """
    )
    return connection


VARIANT_UPSERT = """
INSERT INTO variants (
  provider_id, variant_key, description, setting, billing_class, modifiers,
  drug_json, codes_json, source_page, first_source_row, source_row_count,
  deidentified_min, deidentified_max, negotiated_min, negotiated_max, negotiated_count
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
ON CONFLICT(provider_id, variant_key) DO UPDATE SET
  first_source_row = MIN(first_source_row, excluded.first_source_row),
  source_row_count = source_row_count + 1,
  deidentified_min = CASE
    WHEN variants.deidentified_min IS NULL THEN excluded.deidentified_min
    WHEN excluded.deidentified_min IS NULL THEN variants.deidentified_min
    ELSE MIN(variants.deidentified_min, excluded.deidentified_min)
  END,
  deidentified_max = CASE
    WHEN variants.deidentified_max IS NULL THEN excluded.deidentified_max
    WHEN excluded.deidentified_max IS NULL THEN variants.deidentified_max
    ELSE MAX(variants.deidentified_max, excluded.deidentified_max)
  END,
  negotiated_min = CASE
    WHEN variants.negotiated_min IS NULL THEN excluded.negotiated_min
    WHEN excluded.negotiated_min IS NULL THEN variants.negotiated_min
    ELSE MIN(variants.negotiated_min, excluded.negotiated_min)
  END,
  negotiated_max = CASE
    WHEN variants.negotiated_max IS NULL THEN excluded.negotiated_max
    WHEN excluded.negotiated_max IS NULL THEN variants.negotiated_max
    ELSE MAX(variants.negotiated_max, excluded.negotiated_max)
  END,
  negotiated_count = variants.negotiated_count + excluded.negotiated_count
"""


def item_has_numeric_price(item: dict[str, object]) -> bool:
    for field in ("grossValues", "cashValues", "supplementalValues", "negotiatedValues"):
        values = item.get(field, [])
        if isinstance(values, list) and values:
            return True
    return any(
        parse_number(item.get(field)) is not None
        for field in ("deidentifiedMin", "deidentifiedMax", "negotiatedMin", "negotiatedMax")
    )


def ingest_item(connection: sqlite3.Connection, provider_id: str, item: dict[str, object]) -> None:
    if not item_has_numeric_price(item):
        return
    identity = {
        "description": item["description"],
        "codes": item["codes"],
        "setting": item["setting"],
        "billingClass": item["billingClass"],
        "modifiers": item["modifiers"],
        "drug": item.get("drug"),
        "sourcePage": item.get("sourcePage", ""),
    }
    identity_json = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    variant_key = hashlib.sha256(identity_json.encode("utf-8")).hexdigest()
    negotiated = item.get("negotiatedValues", [])
    negotiated_values = [value for value in negotiated if isinstance(value, (int, float))]
    negotiated_min = min(negotiated_values) if negotiated_values else parse_number(item.get("negotiatedMin"))
    negotiated_max = max(negotiated_values) if negotiated_values else parse_number(item.get("negotiatedMax"))
    negotiated_count = (
        len(negotiated_values)
        if negotiated_values
        else int(parse_number(item.get("negotiatedCount")) or 0)
    )
    connection.execute(
        VARIANT_UPSERT,
        (
            provider_id,
            variant_key,
            item["description"],
            item["setting"],
            item["billingClass"],
            item["modifiers"],
            json.dumps(item["drug"], ensure_ascii=False, separators=(",", ":")) if item.get("drug") else None,
            json.dumps(item["codes"], ensure_ascii=False, separators=(",", ":")),
            clean_text(item.get("sourcePage")),
            item["sourceRow"],
            item.get("deidentifiedMin"),
            item.get("deidentifiedMax"),
            negotiated_min,
            negotiated_max,
            negotiated_count,
        ),
    )
    for kind, field in (
        ("gross", "grossValues"),
        ("cash", "cashValues"),
        ("supplemental", "supplementalValues"),
    ):
        for amount, label in item.get(field, []):
            connection.execute(
                "INSERT OR IGNORE INTO price_values(provider_id, variant_key, kind, amount, label) VALUES (?, ?, ?, ?, ?)",
                (provider_id, variant_key, kind, amount, label or ""),
            )


def ingest_provider(
    connection: sqlite3.Connection,
    provider: dict[str, object],
    path: Path,
) -> dict[str, object]:
    provider_id = clean_text(provider["id"])
    source_format = clean_text(provider.get("format")).lower()
    stats: dict[str, object] = {"sourceRows": 0, "sourceBytes": path.stat().st_size}
    if source_format in {"csv", "zip"}:
        items = iter_csv_items(path, source_format, stats)
    elif source_format == "json":
        items = iter_claraprice_json_items(path, stats)
    elif source_format == "supplemental-json":
        items = iter_supplemental_json_items(path, stats)
    else:
        raise CatalogBuildError(f"Unsupported source format for {provider_id}: {source_format}")
    with connection:
        for item in items:
            ingest_item(connection, provider_id, item)
    row = connection.execute(
        "SELECT COUNT(*) AS variants, SUM(negotiated_count) AS negotiated FROM variants WHERE provider_id = ?",
        (provider_id,),
    ).fetchone()
    stats["normalizedVariants"] = row["variants"]
    stats["negotiatedDollarValues"] = row["negotiated"] or 0
    return stats


def build_groups(
    connection: sqlite3.Connection,
    aliases: dict[tuple[str, str], dict[str, object]],
) -> None:
    connection.executescript("DELETE FROM group_links; DELETE FROM group_names; DELETE FROM groups;")
    variants = connection.execute(
        "SELECT provider_id, variant_key, description, codes_json FROM variants ORDER BY provider_id, variant_key"
    )
    with connection:
        for row in variants:
            codes = json.loads(row["codes_json"])
            identities: list[tuple[str, bool, str | None, str, str]] = []
            if codes:
                for code in codes:
                    code_type = normalize_code_type(code.get("type"))
                    code_value = clean_text(code.get("code"))
                    group_id, local, group_provider = group_identity(row["provider_id"], code_type, code_value)
                    identities.append((group_id, local, group_provider, code_type, code_value))
            else:
                group_id, local, group_provider = uncoded_identity(row["provider_id"], row["variant_key"])
                identities.append((group_id, local, group_provider, "UNCODED", ""))
            for group_id, local, group_provider, code_type, code_value in identities:
                connection.execute(
                    "INSERT OR IGNORE INTO groups(group_id, code, code_type, local, provider_id, shard) VALUES (?, ?, ?, ?, ?, ?)",
                    (group_id, code_value, code_type, int(local), group_provider, shard_for(group_id)),
                )
                connection.execute(
                    "INSERT OR IGNORE INTO group_links(group_id, provider_id, variant_key) VALUES (?, ?, ?)",
                    (group_id, row["provider_id"], row["variant_key"]),
                )
                connection.execute(
                    """
                    INSERT INTO group_names(group_id, description, occurrence_count) VALUES (?, ?, 1)
                    ON CONFLICT(group_id, description) DO UPDATE SET occurrence_count = occurrence_count + 1
                    """,
                    (group_id, row["description"]),
                )
    with connection:
        connection.execute(
            """
            UPDATE groups SET name = (
              SELECT description FROM group_names
              WHERE group_names.group_id = groups.group_id
              ORDER BY occurrence_count DESC, LENGTH(description), description
              LIMIT 1
            )
            """
        )
        connection.execute(
            """
            UPDATE groups SET provider_count = (
              SELECT COUNT(DISTINCT provider_id) FROM group_links
              WHERE group_links.group_id = groups.group_id
            )
            """
        )
        for (code_type, code), alias in aliases.items():
            group_id, local, _ = group_identity("", code_type, code)
            if local:
                continue
            preferred_name = clean_text(alias.get("preferredName"))
            terms = alias.get("terms", [])
            connection.execute(
                "UPDATE groups SET name = COALESCE(NULLIF(?, ''), name), terms_json = ? WHERE group_id = ?",
                (
                    preferred_name,
                    json.dumps(terms, ensure_ascii=False, separators=(",", ":")) if terms else None,
                    group_id,
                ),
            )


@contextlib.contextmanager
def deterministic_gzip_text(path: Path):
    binary = path.open("wb")
    compressed = gzip.GzipFile(filename="", mode="wb", fileobj=binary, mtime=0)
    text = io.TextIOWrapper(compressed, encoding="utf-8", newline="")
    try:
        yield text
    finally:
        text.flush()
        text.detach()
        compressed.close()
        binary.close()


def write_search(connection: sqlite3.Connection, path: Path) -> int:
    with deterministic_gzip_text(path) as output:
        output.write("[")
        first = True
        rows = connection.execute(
            "SELECT group_id, name, code, code_type, provider_count, shard, local, provider_id, terms_json FROM groups ORDER BY name COLLATE NOCASE, code_type, code, group_id"
        )
        for row in rows:
            item: dict[str, object] = {
                "id": row["group_id"],
                "name": row["name"] or row["code"] or "Unlabeled hospital item",
                "code": row["code"],
                "codeType": row["code_type"],
                "providerCount": row["provider_count"],
                "shard": row["shard"],
                "local": bool(row["local"]),
            }
            if row["provider_id"]:
                item["providerId"] = row["provider_id"]
            if row["terms_json"]:
                item["terms"] = json.loads(row["terms_json"])
            if not first:
                output.write(",")
            json.dump(item, output, ensure_ascii=False, separators=(",", ":"))
            first = False
        output.write("]")
    return path.stat().st_size


def _price_payload(values: list[tuple[str, float, str]], row: sqlite3.Row) -> dict[str, object]:
    by_kind: dict[str, list[tuple[float, str]]] = {
        "gross": [],
        "cash": [],
        "supplemental": [],
    }
    for kind, amount, label in values:
        by_kind.setdefault(kind, []).append((amount, label))
    prices: dict[str, object] = {}
    for kind in ("gross", "cash"):
        unique = sorted(set(by_kind.get(kind, [])), key=lambda item: (bool(item[1]), item[1], item[0]))
        if not unique:
            continue
        prices[kind] = json_number(unique[0][0])
        if len(unique) > 1 or any(label for _, label in unique):
            label_default = "Standard discounted cash" if kind == "cash" else "Standard gross charge"
            prices[f"{kind}Values"] = [
                {"amount": json_number(amount), "label": label or label_default}
                for amount, label in unique
            ]
    supplemental = sorted(
        set(by_kind.get("supplemental", [])), key=lambda item: (item[1], item[0])
    )
    if supplemental:
        prices["supplementalValues"] = [
            {"amount": json_number(amount), "label": label or "Supplemental rate"}
            for amount, label in supplemental
        ]
    for source, target in (
        ("deidentified_min", "deidentifiedMin"),
        ("deidentified_max", "deidentifiedMax"),
        ("negotiated_min", "negotiatedMin"),
        ("negotiated_max", "negotiatedMax"),
    ):
        if row[source] is not None:
            prices[target] = json_number(float(row[source]))
    if row["negotiated_count"]:
        prices["negotiatedCount"] = row["negotiated_count"]
    return prices


def _variant_payload(row: sqlite3.Row, price_values: list[tuple[str, float, str]]) -> dict[str, object]:
    variant: dict[str, object] = {
        "providerId": row["provider_id"],
        "description": row["description"],
        "codes": json.loads(row["codes_json"]),
        "prices": _price_payload(price_values, row),
        "sourceRow": row["first_source_row"],
    }
    if row["setting"]:
        variant["setting"] = row["setting"]
    if row["billing_class"]:
        variant["billingClass"] = row["billing_class"]
    if row["modifiers"]:
        variant["modifiers"] = row["modifiers"]
    if row["drug_json"]:
        variant["drug"] = json.loads(row["drug_json"])
    if row["source_page"]:
        variant["sourcePage"] = row["source_page"]
    if row["source_row_count"] > 1:
        variant["sourceRows"] = row["source_row_count"]
    return variant


SHARD_QUERY = """
SELECT
  g.group_id, g.name, g.code, g.code_type, g.local, g.provider_id AS group_provider_id,
  v.provider_id, v.variant_key, v.description, v.setting, v.billing_class, v.modifiers,
  v.drug_json, v.codes_json, v.source_page, v.first_source_row, v.source_row_count,
  v.deidentified_min, v.deidentified_max, v.negotiated_min, v.negotiated_max, v.negotiated_count,
  p.kind AS price_kind, p.amount AS price_amount, p.label AS price_label
FROM groups AS g
JOIN group_links AS l ON l.group_id = g.group_id
JOIN variants AS v ON v.provider_id = l.provider_id AND v.variant_key = l.variant_key
LEFT JOIN price_values AS p ON p.provider_id = v.provider_id AND p.variant_key = v.variant_key
WHERE g.shard = ?
ORDER BY g.group_id, v.provider_id, v.first_source_row, v.variant_key, p.kind, p.label, p.amount
"""


def write_shard(connection: sqlite3.Connection, shard: str, path: Path) -> tuple[int, int]:
    rows = connection.execute(SHARD_QUERY, (shard,))
    group_count = 0
    with deterministic_gzip_text(path) as output:
        output.write("{")
        current_group: str | None = None
        group_meta: sqlite3.Row | None = None
        variants: list[dict[str, object]] = []
        current_variant: tuple[str, str] | None = None
        variant_row: sqlite3.Row | None = None
        price_values: list[tuple[str, float, str]] = []

        def finish_variant() -> None:
            nonlocal variant_row, price_values
            if variant_row is not None:
                variants.append(_variant_payload(variant_row, price_values))
            variant_row = None
            price_values = []

        def finish_group() -> None:
            nonlocal group_count, variants
            if group_meta is None or current_group is None:
                return
            if group_count:
                output.write(",")
            group: dict[str, object] = {
                "id": current_group,
                "name": group_meta["name"] or group_meta["code"] or "Unlabeled hospital item",
                "code": group_meta["code"],
                "codeType": group_meta["code_type"],
                "local": bool(group_meta["local"]),
                "variants": variants,
            }
            if group_meta["group_provider_id"]:
                group["providerId"] = group_meta["group_provider_id"]
            output.write(json.dumps(current_group, ensure_ascii=False))
            output.write(":")
            json.dump(group, output, ensure_ascii=False, separators=(",", ":"))
            group_count += 1
            variants = []

        for row in rows:
            row_group = row["group_id"]
            row_variant = (row["provider_id"], row["variant_key"])
            if current_group is not None and row_group != current_group:
                finish_variant()
                finish_group()
                current_variant = None
            if row_group != current_group:
                current_group = row_group
                group_meta = row
            if current_variant is not None and row_variant != current_variant:
                finish_variant()
            if row_variant != current_variant:
                current_variant = row_variant
                variant_row = row
            if row["price_kind"] is not None:
                price_values.append((row["price_kind"], float(row["price_amount"]), row["price_label"]))
        finish_variant()
        finish_group()
        output.write("}")
    return path.stat().st_size, group_count


def write_catalog(
    connection: sqlite3.Connection,
    output_dir: Path,
    provider_manifest: dict[str, object],
    provider_results: list[dict[str, object]],
    max_shard_bytes: int,
) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    shard_dir = output_dir / "shards"
    shard_dir.mkdir(parents=True, exist_ok=True)
    for stale in shard_dir.glob("*.json.gz"):
        stale.unlink()

    search_path = output_dir / "search.json.gz"
    search_bytes = write_search(connection, search_path)
    shards = [row[0] for row in connection.execute("SELECT DISTINCT shard FROM groups ORDER BY shard")]
    shard_bytes = 0
    max_actual_shard = 0
    shard_groups = 0
    for shard in shards:
        path = shard_dir / f"{shard}.json.gz"
        size, groups = write_shard(connection, shard, path)
        if size > max_shard_bytes:
            raise CatalogBuildError(
                f"Shard {shard} is {size / 1024 / 1024:.2f} MB, above the configured {max_shard_bytes / 1024 / 1024:.2f} MB limit"
            )
        shard_bytes += size
        max_actual_shard = max(max_actual_shard, size)
        shard_groups += groups

    counts = connection.execute(
        """
        SELECT
          (SELECT COUNT(*) FROM variants) AS variants,
          (SELECT COUNT(*) FROM groups) AS search_items,
          (SELECT COUNT(*) FROM groups WHERE local = 0) AS standard_items,
          (SELECT COUNT(*) FROM groups WHERE local = 1) AS local_items,
          (SELECT COUNT(*) FROM group_links) AS group_variants,
          (SELECT COALESCE(SUM(negotiated_count), 0) FROM variants) AS negotiated_values
        """
    ).fetchone()
    statuses = [result["status"] for result in provider_results]
    catalog_manifest: dict[str, object] = {
        "schemaVersion": CATALOG_SCHEMA_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceManifestVersion": provider_manifest.get("manifestVersion"),
        "sourceLastVerified": provider_manifest.get("lastVerified"),
        "coverage": {
            "configuredProviders": len(provider_results),
            "ingestedProviders": statuses.count("ingested"),
            "unavailableProviders": statuses.count("unavailable"),
            "unsupportedProviders": statuses.count("unsupported"),
            "failedProviders": statuses.count("error"),
        },
        "counts": {
            "normalizedVariants": counts["variants"],
            "searchItems": counts["search_items"],
            "standardItems": counts["standard_items"],
            "localItems": counts["local_items"],
            "groupVariantLinks": counts["group_variants"],
            "negotiatedDollarValues": counts["negotiated_values"],
        },
        "priceSemantics": {
            "gross": "Provider-published gross or list charge",
            "cash": "Provider-published discounted cash or self-pay price; cashValues retains each labeled policy when a source publishes more than one",
            "deidentifiedMin": "Source-published deidentified minimum negotiated charge",
            "deidentifiedMax": "Source-published deidentified maximum negotiated charge",
            "negotiatedMin": "Lowest numeric payer-specific negotiated dollar amount in the source row or merged tall rows",
            "negotiatedMax": "Highest numeric payer-specific negotiated dollar amount in the source row or merged tall rows",
            "negotiatedCount": "Count of numeric payer-specific negotiated dollar values; payer and plan names are intentionally excluded",
        },
        "providers": provider_results,
        "artifacts": {
            "search": {"path": "search.json.gz", "bytes": search_bytes},
            "shards": {
                "directory": "shards",
                "count": len(shards),
                "groups": shard_groups,
                "bytes": shard_bytes,
                "largestBytes": max_actual_shard,
                "maximumAllowedBytes": max_shard_bytes,
            },
        },
    }
    manifest_path = output_dir / "manifest.json"
    temp_path = manifest_path.with_suffix(".json.tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(catalog_manifest, output, ensure_ascii=False, indent=2)
        output.write("\n")
    os.replace(temp_path, manifest_path)
    return catalog_manifest


def public_provider_result(provider: dict[str, object], status: str, stats: dict[str, object] | None = None, error: str | None = None) -> dict[str, object]:
    result: dict[str, object] = {
        "id": provider.get("id"),
        "name": provider.get("name"),
        "town": provider.get("town"),
        "state": provider.get("state"),
        "scopeClass": provider.get("scopeClass"),
        "coverageScope": provider.get("coverageScope"),
        "required": bool(provider.get("required")),
        "status": status,
        "availability": provider.get("availability"),
        "pricePublicationType": provider.get("pricePublicationType"),
        "source": {
            "officialPageUrl": provider.get("officialPageUrl"),
            "discoveryUrl": provider.get("discoveryUrl"),
            "mrfUrl": provider.get("mrfUrl"),
            "catalogUrl": provider.get("catalogUrl"),
            "supplementalCatalog": provider.get("supplementalCatalog"),
            "format": provider.get("format"),
            "schemaVersion": provider.get("schemaVersion"),
            "dataDate": provider.get("dataDate"),
        },
    }
    if provider.get("availabilityNote"):
        result["availabilityNote"] = provider["availabilityNote"]
    if stats is not None:
        result["stats"] = stats
    if error:
        result["error"] = error
    return result


def parse_overrides(values: list[str]) -> dict[str, Path]:
    overrides: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise CatalogBuildError(f"Input override must use PROVIDER_ID=PATH: {value}")
        provider_id, raw_path = value.split("=", 1)
        path = Path(raw_path).expanduser().resolve()
        if not path.is_file():
            raise CatalogBuildError(f"Input override does not exist: {path}")
        overrides[provider_id] = path
    return overrides


def run_build(args: argparse.Namespace) -> dict[str, object]:
    provider_manifest, providers = load_providers(args.providers)
    aliases = load_aliases(args.aliases)
    selected = set(args.provider or [])
    if selected:
        available_ids = {clean_text(provider["id"]) for provider in providers}
        missing = selected - available_ids
        if missing:
            raise CatalogBuildError(f"Unknown provider id(s): {', '.join(sorted(missing))}")
        providers = [provider for provider in providers if clean_text(provider["id"]) in selected]
    overrides = parse_overrides(args.input)
    unknown_overrides = set(overrides) - {clean_text(provider["id"]) for provider in providers}
    if unknown_overrides:
        raise CatalogBuildError(f"Input override has no selected provider: {', '.join(sorted(unknown_overrides))}")

    connection = connect_database(args.work_db)
    results: list[dict[str, object]] = []
    failures: list[str] = []
    try:
        for provider_number, provider in enumerate(providers, start=1):
            provider_id = clean_text(provider["id"])
            print(
                f"[{provider_number}/{len(providers)}] {provider_id}: resolving source",
                file=sys.stderr,
                flush=True,
            )
            source_format = clean_text(provider.get("format")).lower()
            url = clean_text(provider.get("mrfUrl"))
            supplemental = supplemental_spec(provider, args.providers.parent.resolve())
            if provider_id in overrides:
                source_path = overrides[provider_id]
                if supplemental is not None or source_format not in SUPPORTED_FORMATS:
                    source_format = "supplemental-json"
                    provider = dict(provider)
                    provider["format"] = source_format
            elif supplemental is not None:
                provider = dict(provider)
                provider["format"] = "supplemental-json"
                source_format = "supplemental-json"
                supplemental_kind, supplemental_value = supplemental
                if supplemental_kind == "path":
                    source_path = Path(supplemental_value)
                    if not source_path.is_file():
                        message = f"Supplemental catalog does not exist: {source_path}"
                        results.append(public_provider_result(provider, "error", error=message))
                        failures.append(f"{provider_id}: {message}")
                        continue
                elif args.offline:
                    source_path = supplemental_cache_path(
                        args.cache_dir, provider, str(supplemental_value)
                    )
                    if not source_path.is_file():
                        message = "Offline supplemental cache is missing"
                        results.append(public_provider_result(provider, "error", error=message))
                        failures.append(f"{provider_id}: {message}")
                        continue
                else:
                    try:
                        source_path = download_source(
                            str(supplemental_value),
                            supplemental_cache_path(
                                args.cache_dir, provider, str(supplemental_value)
                            ),
                            args.refresh,
                        )
                    except CatalogBuildError as error:
                        results.append(public_provider_result(provider, "error", error=str(error)))
                        failures.append(f"{provider_id}: {error}")
                        continue
            elif not url:
                results.append(public_provider_result(provider, "unavailable"))
                continue
            elif source_format not in SUPPORTED_FORMATS:
                results.append(public_provider_result(provider, "unsupported"))
                continue
            elif args.offline:
                source_path = cache_path_for(args.cache_dir, provider)
                if not source_path.is_file():
                    message = "Offline cache is missing"
                    results.append(public_provider_result(provider, "error", error=message))
                    failures.append(f"{provider_id}: {message}")
                    continue
            else:
                try:
                    source_path = download_source(url, cache_path_for(args.cache_dir, provider), args.refresh)
                except CatalogBuildError as error:
                    results.append(public_provider_result(provider, "error", error=str(error)))
                    failures.append(f"{provider_id}: {error}")
                    continue
            try:
                stats = ingest_provider(connection, provider, source_path)
                results.append(public_provider_result(provider, "ingested", stats=stats))
                print(
                    f"[{provider_number}/{len(providers)}] {provider_id}: "
                    f"ingested {stats['sourceRows']} source rows into "
                    f"{stats['normalizedVariants']} variants",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception as error:
                message = str(error)
                results.append(public_provider_result(provider, "error", error=message))
                failures.append(f"{provider_id}: {message}")

        build_groups(connection, aliases)
        manifest = write_catalog(
            connection,
            args.output,
            provider_manifest,
            results,
            int(args.max_shard_mb * 1024 * 1024),
        )
    finally:
        connection.close()
    if failures and not args.allow_source_errors:
        raise CatalogBuildError(
            "Catalog artifacts were written, but ingest failed for: " + "; ".join(failures)
        )
    return manifest


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--providers", type=Path, default=Path("config/providers.json"))
    parser.add_argument("--aliases", type=Path, default=Path("config/procedure-aliases.json"))
    parser.add_argument("--output", type=Path, default=Path("catalog"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/catalog/sources"))
    parser.add_argument("--work-db", type=Path, default=Path(".cache/catalog/catalog.sqlite"))
    parser.add_argument("--provider", action="append", help="Build only one provider; repeat for more")
    parser.add_argument(
        "--input",
        action="append",
        default=[],
        metavar="PROVIDER_ID=PATH",
        help="Use a verified local source instead of downloading it; repeat for more",
    )
    parser.add_argument("--offline", action="store_true", help="Use local overrides and cached files only")
    parser.add_argument("--refresh", action="store_true", help="Refresh cached source downloads")
    parser.add_argument("--allow-source-errors", action="store_true", help="Exit successfully after publishing explicit source errors")
    parser.add_argument("--max-shard-mb", type=float, default=8.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        manifest = run_build(args)
    except CatalogBuildError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "output": str(args.output),
                "coverage": manifest["coverage"],
                "counts": manifest["counts"],
                "artifacts": manifest["artifacts"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
