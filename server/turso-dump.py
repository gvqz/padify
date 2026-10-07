#!/usr/bin/env python3
"""Dump a Turso (libSQL) database as SQL text — `sqlite3 .dump`'s shape.

The turso CLI's shell requires an interactive platform login, which does
not fit a scheduled backup task armed with only a database token. This
script speaks the same HTTP pipeline API as server/db.ts (stdlib only):
URL + token in, schema and INSERT statements out on stdout.

Usage:
  python3 turso-dump.py [url] [token]
  # or TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment
"""
import base64
import json
import os
import sys
import urllib.request


def pipeline(endpoint: str, token: str, statements: list) -> list:
    body = json.dumps(
        {
            "requests": [{"type": "execute", "stmt": {"sql": s}} for s in statements]
            + [{"type": "close"}]
        }
    ).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(300).decode(errors="replace")
        raise SystemExit(f"turso-dump: HTTP {error.code}: {detail}")
    out = []
    for result in payload.get("results", []):
        if result.get("type") == "error":
            message = result.get("error", {}).get("message", "unknown error")
            raise SystemExit(f"turso-dump: query failed: {message}")
        out.append(result.get("response", {}).get("result") or {"cols": [], "rows": []})
    return out


def cell_value(value):
    """Hrana cell → plain Python value (str/int/float/None); plain cells pass through."""
    if isinstance(value, dict):
        kind = value.get("type")
        if kind in ("integer", "float", "text"):
            return value.get("value")
        if kind == "blob":
            return value.get("base64")
        return None
    return value


def literal(value) -> str:
    """Render one pipeline cell as a SQL literal (SQLite quoting rules).

    The /v2/pipeline API delivers Hrana cells: {"type": ..., "value": ...}
    with numbers serialised as strings. Plain JSON scalars (what a local
    mock emits) are still accepted.
    """
    if isinstance(value, dict):
        kind = value.get("type")
        if kind == "null":
            return "NULL"
        if kind == "integer" or kind == "float":
            # value arrives as a string ("42"); print it verbatim so the
            # dump keeps SQLite's own textual rendering of the number.
            raw = value.get("value")
            if raw is None:
                return "NULL"
            return str(raw)
        if kind == "blob":
            if "base64" in value:
                return "X'" + base64.b64decode(value["base64"]).hex() + "'"
            return "NULL"
        if kind == "text":
            value = value.get("value")
        else:
            value = None
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def endpoint_for(url: str) -> str:
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://") :]
    if not url.startswith(("http://", "https://")):
        raise SystemExit(f"turso-dump: not a libsql/http URL: {url!r}")
    return url if url.endswith("/v2/pipeline") else url.rstrip("/") + "/v2/pipeline"


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TURSO_DATABASE_URL", "")
    token = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("TURSO_AUTH_TOKEN", "")
    if not url or not token:
        print(__doc__)
        return 2
    endpoint = endpoint_for(url)

    schema = pipeline(
        endpoint,
        token,
        ["SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"],
    )[0]

    print("PRAGMA foreign_keys=OFF;")
    print("BEGIN TRANSACTION;")
    for row in schema["rows"]:
        name, create_sql = cell_value(row[0]), cell_value(row[1])
        print(str(create_sql) + ";")
        if not str(create_sql).lower().startswith("create table"):
            continue
        quoted = '"' + str(name).replace('"', '""') + '"'
        table = pipeline(endpoint, token, [f"SELECT * FROM {quoted}"])[0]
        columns = [column["name"] for column in table.get("cols", [])]
        if not columns:
            continue
        column_list = ", ".join('"' + c.replace('"', '""') + '"' for c in columns)
        for cells in table["rows"]:
            values = ", ".join(literal(cell) for cell in cells)
            print(f"INSERT INTO {quoted} ({column_list}) VALUES ({values});")
    print("COMMIT;")
    return 0


if __name__ == "__main__":
    sys.exit(main())
