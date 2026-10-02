"""Security checks for Klang. Run with:  python tests/test_security.py

On Windows this also verifies that the stored YouTube sign-in is encrypted with DPAPI.
"""
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.argv = [sys.argv[0], "--mock", "--no-window"]

import server  # noqa: E402

failures = []


def check(name, ok):
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def use_temp_data_dir():
    tmp = Path(tempfile.mkdtemp(prefix="klang-test-"))
    server.DATA_DIR = tmp
    server.AUTH_FILE = tmp / "youtube-account.dat"
    server.LEGACY_AUTH_FILE = tmp / "youtube-account.json"
    return tmp


def test_stored_sign_in():
    use_temp_data_dir()
    cookie = "SID=secret-sid-value; __Secure-3PAPISID=secret-papisid; SAPISID=secret-papisid"
    headers = server.auth_headers_from_cookie(cookie)

    # Old unencrypted file from 1.1.0 is moved into the protected file and wiped
    server.LEGACY_AUTH_FILE.write_text(json.dumps(headers), "utf-8")
    server.load_auth()
    check("old sign-in is migrated", server._auth["headers"] == headers)
    check("old unencrypted file is deleted", not server.LEGACY_AUTH_FILE.exists())

    raw = server.AUTH_FILE.read_bytes()
    check("cookie is not readable in the stored file", b"secret" not in raw and b"SID=" not in raw)
    if os.name == "nt":
        check("stored file uses Windows DPAPI", raw.startswith(server.DPAPI_MAGIC))

    server.load_auth()
    check("stored sign-in can be read back", server._auth["headers"] == headers)

    # A file that can't be decrypted (other PC / other Windows user) is discarded
    server.AUTH_FILE.write_bytes(server.DPAPI_MAGIC + b"bm90LXZhbGlk")
    server.load_auth()
    check("undecryptable sign-in is discarded", server._auth["headers"] is None and not server.AUTH_FILE.exists())


def request(path, method="GET", headers=None, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{server.PORT}{path}", method=method,
                                 data=body.encode() if body else None, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_local_service():
    use_temp_data_dir()
    httpd = server.ThreadingHTTPServer((server.HOST, server.PORT), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        status, page = request("/")
        token = server.API_TOKEN
        check("page is served", status == 200 and token in page)
        check("placeholder is replaced", "__KLANG_TOKEN__" not in page)

        T = {"X-Klang-Token": token}
        check("API with token works", request("/api/library", headers=T)[0] == 200)
        check("API without token is rejected", request("/api/library")[0] == 403)
        check("API with wrong token is rejected", request("/api/library", headers={"X-Klang-Token": "x"})[0] == 403)
        check("POST without token is rejected",
              request("/api/playlists", "POST", {"Content-Type": "text/plain"}, '{"name":"evil"}')[0] == 403)
        check("DNS rebinding (foreign Host) is rejected",
              request("/api/library", headers={**T, "Host": f"evil.example:{server.PORT}"})[0] == 403)
        check("other website (Origin) is rejected",
              request("/api/account/logout", "POST", {**T, "Origin": "https://evil.example"}, "{}")[0] == 403)
        check("other website (Sec-Fetch-Site) is rejected",
              request("/api/library", headers={**T, "Sec-Fetch-Site": "cross-site"})[0] == 403)
        check("Klang's own window is allowed",
              request("/api/library", headers={**T, "Origin": f"http://127.0.0.1:{server.PORT}",
                                               "Sec-Fetch-Site": "same-origin"})[0] == 200)
        check("account endpoint never returns the cookie",
              "cookie" not in request("/api/account", headers=T)[1].lower())
    finally:
        httpd.shutdown()


test_stored_sign_in()
test_local_service()
print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("All security checks passed")
