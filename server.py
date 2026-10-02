"""
Klang – a lightweight YouTube Music player for Windows.

Runs a tiny local server (bound to 127.0.0.1 only) that cleans up YouTube Music
search results and opens the interface in a chromeless Edge app window.
Playback uses the official embedded YouTube player.

Usage:  python server.py              (normal)
        python server.py --mock       (demo mode, no internet needed)
        python server.py --no-window  (server only)
        Klang.exe [same options]      (packaged build)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8777

# Packaged as Klang.exe (PyInstaller): the UI is unpacked to a temp folder and
# the library lives in %APPDATA%\Klang, because the exe's folder may be read-only.
FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    DATA_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "Klang"
else:
    ROOT = Path(__file__).resolve().parent
    DATA_DIR = ROOT / "data"
UI_DIR = (ROOT / "ui").resolve()
LIBRARY_FILE = DATA_DIR / "library.json"

# A windowed exe has no console: send output to a log file instead of crashing on print().
if sys.stdout is None or sys.stderr is None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _log = open(DATA_DIR / "klang.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

MOCK = "--mock" in sys.argv
NO_WINDOW = "--no-window" in sys.argv
NO_AUTOEXIT = "--no-autoexit" in sys.argv or NO_WINDOW

# ----------------------------------------------------------------------------
# YouTube Music
# ----------------------------------------------------------------------------

_yt_local = threading.local()


def yt():
    """One YTMusic client per thread (the library is not thread-safe)."""
    inst = getattr(_yt_local, "inst", None)
    if inst is None:
        from ytmusicapi import YTMusic

        inst = YTMusic(language="en", location="CH")
        _yt_local.inst = inst
    return inst


def big_thumb(thumbs, size=544):
    """Pick the largest thumbnail and upscale Google-hosted images to `size`."""
    if not thumbs:
        return ""
    if isinstance(thumbs, dict):
        thumbs = thumbs.get("thumbnails") or []
    if not thumbs:
        return ""
    url = sorted(thumbs, key=lambda t: t.get("width", 0))[-1].get("url", "")
    url = re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url)
    url = re.sub(r"=s\d+", f"=s{size}", url)
    return url


def secs(text):
    if not text:
        return 0
    try:
        parts = [int(p) for p in str(text).split(":")]
    except ValueError:
        return 0
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def fmt(sec):
    sec = int(sec or 0)
    if sec <= 0:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def norm_track(r, album=None, fallback_thumb=""):
    """Normalize a song/video from any ytmusicapi response into one shape."""
    vid = r.get("videoId")
    if not vid:
        return None
    artists = [a for a in (r.get("artists") or []) if a and a.get("name")]
    # Drop "1.2M views" style entries that sneak into the artist list
    artists = [a for a in artists if not re.search(r"Aufrufe|views|Wiedergaben|plays", a["name"], re.I)]
    alb = r.get("album") or album or {}
    if isinstance(alb, str):
        alb = {"name": alb, "id": None}
    seconds = r.get("duration_seconds") or secs(r.get("duration") or r.get("length"))
    thumb = big_thumb(r.get("thumbnails") or r.get("thumbnail")) or fallback_thumb
    return {
        "videoId": vid,
        "title": r.get("title") or "",
        "artists": ", ".join(a["name"] for a in artists),
        "artistId": next((a.get("id") for a in artists if a.get("id")), None),
        "album": alb.get("name") or "",
        "albumId": alb.get("id"),
        "seconds": seconds,
        "duration": fmt(seconds),
        "thumb": thumb,
        "explicit": bool(r.get("isExplicit")),
        "kind": "video" if (r.get("resultType") == "video" or r.get("videoType") == "MUSIC_VIDEO_TYPE_UGC") else "song",
    }


def norm_album(r):
    if not r.get("browseId"):
        return None
    artists = r.get("artists") or []
    return {
        "id": r["browseId"],
        "title": r.get("title") or "",
        "artists": ", ".join(a.get("name", "") for a in artists if a.get("name")),
        "year": r.get("year") or "",
        "type": r.get("type") or "Album",
        "thumb": big_thumb(r.get("thumbnails")),
    }


def norm_artist(r):
    if not r.get("browseId"):
        return None
    return {
        "id": r["browseId"],
        "name": r.get("artist") or r.get("title") or r.get("name") or "",
        "thumb": big_thumb(r.get("thumbnails")),
    }


# --- Better search ----------------------------------------------------------

VARIANT_RE = re.compile(
    r"\b(live|cover|remix|rmx|sped[\s-]?up|slowed|reverb|nightcore|karaoke|instrumental|"
    r"8d|tribute|mashup|bass boosted|lofi|lo-fi)\b",
    re.I,
)


def simplify(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[\(\[].*?[\)\]]", " ", text.lower())
    text = re.sub(r"\b(feat|ft|featuring)\b.*", " ", text)
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def is_variant(track, query):
    hay = f"{track['title']} {track['album']}"
    for m in VARIANT_RE.finditer(hay):
        if m.group(0).lower() not in query.lower():
            return True
    return False


def relevance(track, query):
    q = set(simplify(query).split())
    if not q:
        return 0
    title = set(simplify(track["title"]).split())
    artist = set(simplify(track["artists"]).split())
    hit = len(q & (title | artist)) / len(q)
    exact = 1.0 if simplify(track["title"]) and simplify(track["title"]) in simplify(query) else 0
    return hit + 0.5 * exact


def clean_songs(tracks, query, hide_variants=True):
    """Remove duplicates, hide/demote variants, sort by how well the result matches."""
    seen, main, variants = set(), [], []
    for i, t in enumerate(tracks):
        key = (simplify(t["title"]), simplify(t["artists"].split(",")[0]))
        if key in seen:
            continue
        seen.add(key)
        t["_rank"] = relevance(t, query) - i * 0.01  # YouTube order as tie-breaker
        (variants if is_variant(t, query) else main).append(t)
    main.sort(key=lambda t: -t["_rank"])
    for t in main + variants:
        t.pop("_rank", None)
        t["variant"] = t in variants
    return main if hide_variants else main + variants


def search_all(query, hide_variants=True):
    failed = []

    def run(flt):
        try:
            return yt().search(query, filter=flt, limit=25)
        except Exception as e:  # one failing category must not break the search
            print(f"[search:{flt}] {e}", file=sys.stderr)
            failed.append(e)
            return []

    with ThreadPoolExecutor(4) as pool:
        songs, albums, artists, videos = pool.map(run, ["songs", "albums", "artists", "videos"])
    if len(failed) == 4:
        raise failed[0]  # nothing worked: report a connection problem instead of "no results"

    songs = clean_songs([t for t in map(norm_track, songs) if t], query, hide_variants)
    vids = [t for t in map(norm_track, videos) if t]
    for v in vids:
        v["kind"] = "video"
    vids = clean_songs(vids, query, hide_variants=False)
    albums = [a for a in map(norm_album, albums) if a]
    artists = [a for a in map(norm_artist, artists) if a]

    # Top result: the artist if the name matches exactly, otherwise the best song
    top = None
    if artists and simplify(artists[0]["name"]) == simplify(query):
        top = {"type": "artist", **artists[0]}
    elif songs:
        top = {"type": "song", **songs[0]}
    return {"query": query, "top": top, "songs": songs, "albums": albums, "artists": artists, "videos": vids}


def get_album(browse_id):
    a = yt().get_album(browse_id)
    thumb = big_thumb(a.get("thumbnails"))
    alb = {"name": a.get("title"), "id": browse_id}
    tracks = [t for t in (norm_track(x, alb, thumb) for x in a.get("tracks", [])) if t]
    for t in tracks:
        t["thumb"] = thumb or t["thumb"]
    return {
        "id": browse_id,
        "title": a.get("title"),
        "artists": ", ".join(x.get("name", "") for x in a.get("artists") or []),
        "artistId": next((x.get("id") for x in a.get("artists") or [] if x.get("id")), None),
        "year": a.get("year") or "",
        "type": a.get("type") or "Album",
        "thumb": thumb,
        "duration": a.get("duration") or "",
        "tracks": tracks,
    }


def get_artist(browse_id):
    a = yt().get_artist(browse_id)
    songs = [t for t in map(norm_track, (a.get("songs") or {}).get("results", [])) if t]
    albums = [x for x in map(norm_album, (a.get("albums") or {}).get("results", [])) if x]
    singles = [x for x in map(norm_album, (a.get("singles") or {}).get("results", [])) if x]
    return {
        "id": browse_id,
        "name": a.get("name"),
        "thumb": big_thumb(a.get("thumbnails"), 1080),
        "subscribers": a.get("subscribers") or "",
        "description": (a.get("description") or "")[:400],
        "songs": songs,
        "albums": albums,
        "singles": singles,
    }


def get_radio(video_id):
    w = yt().get_watch_playlist(videoId=video_id, radio=True, limit=30)
    tracks = [t for t in map(norm_track, w.get("tracks", [])) if t]
    return [t for t in tracks if t["videoId"] != video_id]


def get_alternatives(title, artists):
    """Fallback videos when a song may not be embedded (player error 101/150)."""
    res = yt().search(f"{artists} {title}", filter="videos", limit=8)
    return [t for t in map(norm_track, res) if t]


def get_suggestions(query):
    try:
        return yt().get_search_suggestions(query)[:7]
    except Exception:
        return []


# ----------------------------------------------------------------------------
# Demo mode (offline) – realistic sample data for the interface
# ----------------------------------------------------------------------------

_PALETTES = [
    ("#a58bff", "#2c2550", "#ff9ec7"), ("#6fd0c4", "#1c3038", "#a58bff"), ("#f2b880", "#3d2636", "#a58bff"),
    ("#8fa3ff", "#1b2140", "#c2b0ff"), ("#e7e3f5", "#2a2933", "#7253e0"), ("#ff8f8f", "#2d1f33", "#ffd29e"),
]


def _mock_thumb(seed):
    """Generative cover art for demo mode (stable for a given seed)."""
    import hashlib
    from urllib.parse import quote

    hv = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    hi, base, alt = _PALETTES[hv % len(_PALETTES)]
    style = (hv >> 8) % 3
    x, y = 25 + (hv >> 12) % 50, 25 + (hv >> 20) % 45
    if style == 0:  # sun over horizon bands
        body = (f"<circle cx='{x}' cy='{y}' r='26' fill='{hi}'/>"
                + "".join(f"<rect y='{62 + i * 8}' width='100' height='{5 - i}' fill='{base}'/>" for i in range(5)))
    elif style == 1:  # concentric rings
        body = "".join(f"<circle cx='{x}' cy='{y}' r='{8 + i * 9}' fill='none' stroke='{hi}' stroke-opacity='{1 - i * .14:.2f}' stroke-width='3'/>" for i in range(7))
    else:  # soft blobs
        body = (f"<circle cx='{x}' cy='{y}' r='38' fill='{hi}' opacity='.9' filter='url(#b)'/>"
                f"<circle cx='{100 - x}' cy='{100 - y}' r='30' fill='{alt}' opacity='.8' filter='url(#b)'/>")
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='xMidYMid slice'>"
        "<defs><filter id='b' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='9'/></filter>"
        f"<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='{base}'/><stop offset='1' stop-color='#17171c'/></linearGradient></defs>"
        f"<rect width='100' height='100' fill='url(#g)'/>{body}</svg>"
    )
    return "data:image/svg+xml;utf8," + quote(svg)


_MOCK_SONGS = [
    ("Night Drive", "Lena Moor", "Neon Hours", 214), ("Glass", "Cold & Clear", "Glass", 187),
    ("Violet", "Lena Moor", "Neon Hours", 241), ("Courtyard Echo", "Milo Brandt", "Backyard", 199),
    ("Far Away (Live)", "Lena Moor", "Live in Zurich", 262), ("City of Light", "Ava Kern", "City", 233),
    ("Night Drive (Sped Up)", "nightcore fan", "", 171), ("Slowly", "Milo Brandt", "Backyard", 256),
    ("Ash & Gold", "Cold & Clear", "Glass", 205), ("Quiet", "Ava Kern", "City", 178),
    ("Afterglow", "Lena Moor", "Neon Hours", 228), ("Paper Moon", "Ava Kern", "City", 196),
]


def _mock_track(i, t):
    title, artist, album, sec = t
    return {
        "videoId": f"mock{i:07d}", "title": title, "artists": artist, "artistId": f"UC{artist}",
        "album": album, "albumId": f"MPRE{album}" if album else None, "seconds": sec,
        "duration": fmt(sec), "thumb": _mock_thumb(album or title), "explicit": i == 3, "kind": "song",
    }


def mock_search(query, hide_variants=True):
    time.sleep(0.25)
    songs = [_mock_track(i, t) for i, t in enumerate(_MOCK_SONGS)]
    songs = clean_songs(songs, query, hide_variants)
    artists = [{"id": f"UC{n}", "name": n, "thumb": _mock_thumb(n)} for n in ["Lena Moor", "Cold & Clear", "Ava Kern"]]
    albums = [
        {"id": f"MPRE{a}", "title": a, "artists": ar, "year": y, "type": "Album", "thumb": _mock_thumb(a)}
        for a, ar, y in [("Neon Hours", "Lena Moor", "2025"), ("Glass", "Cold & Clear", "2024"), ("City", "Ava Kern", "2026")]
    ]
    vids = [dict(s, kind="video", videoId=s["videoId"].replace("mock", "vide")) for s in songs[:4]]
    top = {"type": "artist", **artists[0]} if "lena" in query.lower() else {"type": "song", **songs[0]}
    return {"query": query, "top": top, "songs": songs, "albums": albums, "artists": artists, "videos": vids}


def mock_album(bid):
    name = bid.replace("MPRE", "")
    tracks = [_mock_track(i, t) for i, t in enumerate(_MOCK_SONGS) if t[2] == name] or [_mock_track(0, _MOCK_SONGS[0])]
    return {"id": bid, "title": name, "artists": tracks[0]["artists"], "artistId": tracks[0]["artistId"],
            "year": "2025", "type": "Album", "thumb": _mock_thumb(name), "duration": "38 min", "tracks": tracks}


def mock_artist(aid):
    name = aid.replace("UC", "")
    songs = [_mock_track(i, t) for i, t in enumerate(_MOCK_SONGS) if t[1] == name]
    return {"id": aid, "name": name, "thumb": _mock_thumb(name + "x"), "subscribers": "184K",
            "description": "", "songs": songs, "albums": mock_search(name)["albums"][:2], "singles": []}


# ----------------------------------------------------------------------------
# Library: your playlists + liked songs (stored locally as JSON)
# ----------------------------------------------------------------------------

_lib_lock = threading.Lock()


def load_library():
    if LIBRARY_FILE.exists():
        try:
            return json.loads(LIBRARY_FILE.read_text("utf-8"))
        except Exception:
            backup = LIBRARY_FILE.with_suffix(f".corrupt-{int(time.time())}.json")
            shutil.copy(LIBRARY_FILE, backup)
            print(f"library.json was corrupted, backup saved as {backup}", file=sys.stderr)
    return {"version": 1, "liked": [], "playlists": [], "recent": []}


def save_library(lib):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LIBRARY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(lib, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, LIBRARY_FILE)


def slim(t):
    keys = ("videoId", "title", "artists", "artistId", "album", "albumId", "seconds", "duration", "thumb", "explicit", "kind")
    return {k: t.get(k) for k in keys}


def lib_action(fn):
    with _lib_lock:
        lib = load_library()
        result = fn(lib)
        save_library(lib)
        return result


def find_playlist(lib, pid):
    for p in lib["playlists"]:
        if p["id"] == pid:
            return p
    raise KeyError("Playlist not found")


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------

_last_ping = time.time()
_cache: dict = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now, value)
        if len(_cache) > 400:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)
    return value


MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Klang"

    def log_message(self, *a):
        pass

    # --- responses ---
    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, code, msg):
        self.send_json({"error": msg}, code)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (UI_DIR / rel).resolve()
        if UI_DIR not in f.parents or not f.is_file():
            return self.send_error_json(404, "Not found")
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # --- Routing ---
    def do_GET(self):
        global _last_ping
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        try:
            if not p.startswith("/api/"):
                return self.static(p)
            if p == "/api/ping":
                _last_ping = time.time()
                return self.send_json({"ok": True, "mock": MOCK})
            if p == "/api/search":
                query = q.get("q", "").strip()
                if not query:
                    return self.send_json({"query": "", "top": None, "songs": [], "albums": [], "artists": [], "videos": []})
                hide = q.get("variants", "hide") == "hide"
                fn = mock_search if MOCK else search_all
                return self.send_json(cached(("s", query.lower(), hide), 600, lambda: fn(query, hide)))
            if p == "/api/suggest":
                query = q.get("q", "").strip()
                if MOCK:
                    return self.send_json([s for s in ["lena moor", "lena moor night drive", "lena moor neon hours", "glass cold & clear"] if query.lower() in s])
                return self.send_json(cached(("g", query.lower()), 600, lambda: get_suggestions(query)) if query else [])
            if p == "/api/album":
                fn = mock_album if MOCK else get_album
                return self.send_json(cached(("a", q["id"]), 3600, lambda: fn(q["id"])))
            if p == "/api/artist":
                fn = mock_artist if MOCK else get_artist
                return self.send_json(cached(("r", q["id"]), 3600, lambda: fn(q["id"])))
            if p == "/api/radio":
                if MOCK:
                    return self.send_json([_mock_track(i + 20, t) for i, t in enumerate(_MOCK_SONGS[::-1])])
                return self.send_json(cached(("w", q["id"]), 600, lambda: get_radio(q["id"])))
            if p == "/api/alternatives":
                if MOCK:
                    return self.send_json([])
                return self.send_json(get_alternatives(q.get("title", ""), q.get("artists", "")))
            if p == "/api/library":
                with _lib_lock:
                    return self.send_json(load_library())
            return self.send_error_json(404, "Unknown path")
        except KeyError as e:
            return self.send_error_json(400, f"Missing parameter: {e}")
        except Exception as e:
            print(f"[GET {p}] {e!r}", file=sys.stderr)
            return self.send_error_json(502, "YouTube Music did not respond. Check your internet connection.")

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            data = self.body()
            if p == "/api/like":
                t = slim(data["track"])

                def toggle(lib):
                    ids = [x["videoId"] for x in lib["liked"]]
                    if t["videoId"] in ids:
                        lib["liked"] = [x for x in lib["liked"] if x["videoId"] != t["videoId"]]
                        return {"liked": False}
                    lib["liked"].insert(0, t)
                    return {"liked": True}

                return self.send_json(lib_action(toggle))
            if p == "/api/recent":
                t = slim(data["track"])

                def add(lib):
                    lib["recent"] = [t] + [x for x in lib.get("recent", []) if x["videoId"] != t["videoId"]][:49]

                lib_action(add)
                return self.send_json({"ok": True})
            if p == "/api/playlists":
                name = (data.get("name") or "").strip() or "New playlist"
                pl = {"id": uuid.uuid4().hex[:10], "name": name[:80], "created": int(time.time()), "tracks": []}
                for t in data.get("tracks") or []:
                    pl["tracks"].append(slim(t))
                lib_action(lambda lib: lib["playlists"].append(pl))
                return self.send_json(pl)
            m = re.fullmatch(r"/api/playlists/(\w+)/tracks", p)
            if m:
                tracks = [slim(t) for t in data.get("tracks", [])]

                def add_tracks(lib):
                    pl = find_playlist(lib, m.group(1))
                    have = {t["videoId"] for t in pl["tracks"]}
                    new = [t for t in tracks if t["videoId"] not in have]
                    pl["tracks"].extend(new)
                    return {"added": len(new), "skipped": len(tracks) - len(new)}

                return self.send_json(lib_action(add_tracks))
            m = re.fullmatch(r"/api/playlists/(\w+)/reorder", p)
            if m:
                def reorder(lib):
                    pl = find_playlist(lib, m.group(1))
                    order = data["order"]
                    by_id = {t["videoId"]: t for t in pl["tracks"]}
                    pl["tracks"] = [by_id[v] for v in order if v in by_id] + [
                        t for t in pl["tracks"] if t["videoId"] not in order]

                lib_action(reorder)
                return self.send_json({"ok": True})
            return self.send_error_json(404, "Unknown path")
        except KeyError as e:
            return self.send_error_json(400, str(e))
        except Exception as e:
            print(f"[POST {p}] {e!r}", file=sys.stderr)
            return self.send_error_json(500, "Could not save your library.")

    def do_PATCH(self):
        m = re.fullmatch(r"/api/playlists/(\w+)", urlparse(self.path).path)
        if not m:
            return self.send_error_json(404, "Unknown path")
        data = self.body()

        def rename(lib):
            pl = find_playlist(lib, m.group(1))
            pl["name"] = (data.get("name") or pl["name"]).strip()[:80]
            return pl

        try:
            return self.send_json(lib_action(rename))
        except KeyError as e:
            return self.send_error_json(404, str(e))

    def do_DELETE(self):
        p = urlparse(self.path).path
        try:
            m = re.fullmatch(r"/api/playlists/(\w+)", p)
            if m:
                def delete(lib):
                    find_playlist(lib, m.group(1))
                    lib["playlists"] = [x for x in lib["playlists"] if x["id"] != m.group(1)]

                lib_action(delete)
                return self.send_json({"ok": True})
            m = re.fullmatch(r"/api/playlists/(\w+)/tracks/([\w-]+)", p)
            if m:
                def remove(lib):
                    pl = find_playlist(lib, m.group(1))
                    pl["tracks"] = [t for t in pl["tracks"] if t["videoId"] != m.group(2)]

                lib_action(remove)
                return self.send_json({"ok": True})
            return self.send_error_json(404, "Unknown path")
        except KeyError as e:
            return self.send_error_json(404, str(e))


# ----------------------------------------------------------------------------
# Startup
# ----------------------------------------------------------------------------

def find_edge():
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return shutil.which("msedge") or shutil.which("microsoft-edge")


def open_window(url):
    edge = find_edge()
    if edge:
        # App mode: its own window without an address bar. Uses your Edge profile,
        # so if you're signed in to YouTube Premium there, you get no ads.
        subprocess.Popen([edge, f"--app={url}", "--window-size=1320,840"], close_fds=True)
    else:
        webbrowser.open(url)


def port_in_use():
    with socket.socket() as s:
        return s.connect_ex((HOST, PORT)) == 0


def watchdog(server):
    """Shut the server down once the window has been closed for 25 seconds."""
    while True:
        time.sleep(5)
        if time.time() - _last_ping > 25:
            print("Window closed – Klang is shutting down.")
            server.shutdown()
            return


def main():
    url = f"http://{HOST}:{PORT}/"
    if port_in_use():
        # Already running: just open another window
        if not NO_WINDOW:
            open_window(url)
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"Klang is running at {url}" + ("  (demo mode)" if MOCK else ""))
    if not NO_AUTOEXIT:
        threading.Thread(target=watchdog, args=(server,), daemon=True).start()
    if not NO_WINDOW:
        threading.Timer(0.3, open_window, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
