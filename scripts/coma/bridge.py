"""Local JSON bridge to Valentine COMA. Reads only a bounded schema-only request on stdin."""
from __future__ import annotations

import json
import math
import sys


def _fail(code: str) -> None:
    sys.stdout.write(json.dumps({"schemaVersion": 1, "error": code}, separators=(",", ":")))
    raise SystemExit(0)


def main() -> None:
    if sys.version_info[:2] != (3, 12):
        _fail("PYTHON_VERSION_MISMATCH")
    raw = sys.stdin.buffer.read(2_000_001)
    if len(raw) > 2_000_000:
        _fail("INPUT_TOO_LARGE")
    try:
        request = json.loads(raw)
    except Exception:
        _fail("INPUT_JSON_INVALID")
    if not isinstance(request, dict) or request.get("schemaVersion") != 1:
        _fail("INPUT_SCHEMA_INVALID")
    tables = request.get("tables")
    pairs = request.get("pairs")
    if not isinstance(tables, list) or not isinstance(pairs, list) or len(tables) > 100 or len(pairs) > 1000:
        _fail("INPUT_BOUNDS_INVALID")

    try:
        from importlib.metadata import version
        import pandas as pd
        from valentine import valentine_match
        from valentine.algorithms import Coma
    except Exception:
        _fail("VALENTINE_IMPORT_FAILED")

    try:
        installed_version = version("valentine")
    except Exception:
        _fail("VALENTINE_VERSION_UNAVAILABLE")
    if installed_version != "1.1.0":
        _fail("VALENTINE_VERSION_MISMATCH")

    frames: dict[str, object] = {}
    for item in tables:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("columns"), list):
            _fail("TABLE_SCHEMA_INVALID")
        name = item["name"]
        columns = item["columns"]
        if not name or len(columns) > 1000 or any(not isinstance(column, dict) or not isinstance(column.get("name"), str) or not column["name"] or not isinstance(column.get("type"), str) for column in columns):
            _fail("TABLE_COLUMNS_INVALID")
        names = [column["name"] for column in columns]
        if name in frames or len(set(names)) != len(names):
            _fail("TABLE_DUPLICATE_INVALID")
        # Preserve only allowlisted names and declared dtypes; no row values enter COMA.
        def pandas_dtype(declared: str) -> str:
            value = declared.lower()
            if "bool" in value:
                return "boolean"
            if any(token in value for token in ("int", "serial")):
                return "Int64"
            if any(token in value for token in ("float", "double", "decimal", "numeric", "real")):
                return "Float64"
            if any(token in value for token in ("char", "text", "string", "date", "time")):
                return "string"
            return "object"
        frames[name] = pd.DataFrame({column["name"]: pd.Series(dtype=pandas_dtype(column["type"])) for column in columns})

    output = []
    matcher_configuration = {"max_n": 0, "use_instances": False, "use_schema": True, "delta": 0.15, "threshold": 0.0, "instance_weight": 1.0}
    matcher = Coma(**matcher_configuration)
    for pair in pairs:
        if not isinstance(pair, dict) or pair.get("source") not in frames or pair.get("target") not in frames:
            _fail("PAIR_SCOPE_INVALID")
        try:
            source, target = pair["source"], pair["target"]
            matches = valentine_match([frames[source], frames[target]], matcher, df_names=[source, target], instance_sample_size=0)
        except Exception:
            _fail("VALENTINE_MATCH_FAILED")
        records = []
        try:
            items = matches.items() if hasattr(matches, "items") else matches
            for mapping, score in items:
                if hasattr(mapping, "source_column") and hasattr(mapping, "target_column"):
                    left_name, right_name = mapping.source_column, mapping.target_column
                elif isinstance(mapping, tuple) and len(mapping) == 2:
                    left, right = mapping
                    left_name = left[1] if isinstance(left, tuple) and len(left) > 1 else left
                    right_name = right[1] if isinstance(right, tuple) and len(right) > 1 else right
                else:
                    continue
                if isinstance(left_name, str) and isinstance(right_name, str):
                    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
                        _fail("VALENTINE_SCORE_INVALID")
                    records.append({"sourceColumn": left_name, "targetColumn": right_name, "rawScore": score})
        except Exception:
            _fail("VALENTINE_RESULT_INVALID")
        output.append({"source": pair["source"], "target": pair["target"], "matches": records})

    sys.stdout.write(json.dumps({"schemaVersion": 1, "provider": "valentine.Coma", "version": "1.1.0", "configuration": matcher_configuration, "matches": output},
                                ensure_ascii=False, separators=(",", ":"), default=str))


if __name__ == "__main__":
    main()
