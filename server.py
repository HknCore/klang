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
AUTH_FILE = DATA_DIR / "youtube-account.json"
_auth = {"headers": None, "version": 0}
_auth_lock = threading.Lock()


def load_auth():
    try:
        _auth["headers"] = json.loads(AUTH_FILE.read_text("utf-8"))
    except Exception:
        _auth["headers"] = None


def yt(anonymous=False):
    """One YTMusic client per thread (the library is not thread-safe).
    Signed in, it uses your YouTube account: personal results and your library."""
    from ytmusicapi import YTMusic

    use_auth = bool(_auth["headers"]) and not anonymous
    key = (use_auth, _auth["version"] if use_auth else 0)
    cache = getattr(_yt_local, "clients", None)
    if cache is None:
        cache = _yt_local.clients = {}
    inst = cache.get(key)
    if inst is None:
        auth = dict(_auth["headers"]) if use_auth else None
        inst = YTMusic(auth=auth, language="en", location="CH")
        for old in [k for k in cache if k[0] and k != key]:  # drop clients of a previous sign-in
            cache.pop(old)
        cache[key] = inst
    return inst


def with_yt(fn):
    """Run fn with your account; if that fails (e.g. the sign-in expired), try without it."""
    try:
        return fn(yt())
    except Exception:
        if not _auth["headers"]:
            raise
        return fn(yt(anonymous=True))


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
            return with_yt(lambda c: c.search(query, filter=flt, limit=25))
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
    a = with_yt(lambda c: c.get_album(browse_id))
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
    a = with_yt(lambda c: c.get_artist(browse_id))
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
    w = with_yt(lambda c: c.get_watch_playlist(videoId=video_id, radio=True, limit=30))
    tracks = [t for t in map(norm_track, w.get("tracks", [])) if t]
    return [t for t in tracks if t["videoId"] != video_id]


def get_alternatives(title, artists):
    """Fallback videos when a song may not be embedded (player error 101/150)."""
    res = with_yt(lambda c: c.search(f"{artists} {title}", filter="videos", limit=8))
    return [t for t in map(norm_track, res) if t]


def get_suggestions(query):
    try:
        return yt(anonymous=True).get_search_suggestions(query)[:7]
    except Exception:
        return []


# --- YouTube account --------------------------------------------------------
# Klang signs in the same way a browser does: with the cookies of a signed-in
# YouTube Music session. They are stored only in DATA_DIR/youtube-account.json.

COOKIE_DOMAINS = (".youtube.com", "youtube.com", "music.youtube.com", "www.youtube.com")


def auth_headers_from_cookie(cookie, authuser="0"):
    from ytmusicapi.helpers import initialize_headers

    headers = dict(initialize_headers())
    headers.update({
        "cookie": cookie.strip(),
        "x-goog-authuser": str(authuser or "0"),
        "origin": "https://music.youtube.com",
        "x-origin": "https://music.youtube.com",
        "authorization": "SAPISIDHASH 0_0",  # marks browser auth; recomputed on every request
    })
    return headers


def parse_pasted_headers(text):
    """Accepts request headers copied from a browser: raw headers, "Copy as fetch" or "Copy as cURL"."""
    text = (text or "").strip()
    patterns = [
        r'"cookie"\s*:\s*"((?:[^"\\]|\\.)+)"',          # Copy as fetch / JSON
        r"(?im)^\s*cookie\s*:\s*(.+?)\s*$",              # raw headers (Firefox, Chrome)
        r"-H\s+[\'\"]cookie:\s*([^\'\"]+)[\'\"]",       # Copy as cURL (bash)
        r"(?:-b|--cookie)\s+[\'\"]([^\'\"]+)[\'\"]",       # Copy as cURL (newer Chrome)
        r"(?im)^\s*cookie\s*\n\s*(.+?)\s*$",            # Chrome "copy request headers" pairs
    ]
    cookie = None
    for pat in patterns:
        m = re.search(pat, text)
        if m and "SAPISID" in m.group(1):
            cookie = m.group(1).replace('\\"', '"')
            break
    if not cookie and "=" in text and ";" in text and "SAPISID" in text and "\n" not in text:
        cookie = text  # just the cookie value
    if not cookie:
        raise ValueError("No YouTube cookie found. Copy the request headers of a music.youtube.com request (see the steps).")
    if "__Secure-3PAPISID=" not in cookie:
        raise ValueError("The cookie is missing __Secure-3PAPISID. Make sure you're signed in on music.youtube.com.")
    m = re.search(r'x-goog-authuser[\'"]?\s*[:,]?\s*[\'"]?\s*(\d+)', text, re.I)
    return auth_headers_from_cookie(cookie, m.group(1) if m else "0")


def sign_in_with(headers):
    """Check the credentials against YouTube Music, then store them."""
    from ytmusicapi import YTMusic

    info = YTMusic(auth=dict(headers), language="en", location="CH").get_account_info()
    if not info or not info.get("accountName"):
        raise ValueError("YouTube didn't accept this sign-in. Try signing in again.")
    with _auth_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        AUTH_FILE.write_text(json.dumps(headers), "utf-8")
        _auth["headers"] = headers
        _auth["version"] += 1
    clear_cache()
    return account_summary(info)


def sign_out():
    with _auth_lock:
        AUTH_FILE.unlink(missing_ok=True)
        _auth["headers"] = None
        _auth["version"] += 1
    clear_cache()


def account_summary(info):
    return {
        "signedIn": True,
        "name": info.get("accountName") or "",
        "handle": info.get("channelHandle") or "",
        "photo": info.get("accountPhotoUrl") or "",
    }


def get_account():
    if not _auth["headers"]:
        return {"signedIn": False}
    return account_summary(yt().get_account_info())


def norm_playlist(p):
    pid = p.get("playlistId") or p.get("id")
    if not pid:
        return None
    count = p.get("count") or p.get("trackCount") or ""
    return {"id": pid, "title": p.get("title") or "", "count": str(count), "thumb": big_thumb(p.get("thumbnails"))}


def get_yt_playlists():
    out = []
    for p in yt().get_library_playlists(limit=None):
        n = norm_playlist(p)
        if n and n["id"] not in ("LM", "SE"):  # liked music and episodes have their own places
            out.append(n)
    return out


def playlist_payload(pl, pid):
    thumb = big_thumb(pl.get("thumbnails"))
    tracks = [t for t in map(norm_track, pl.get("tracks") or []) if t]
    for raw, t in zip([x for x in pl.get("tracks") or [] if x.get("videoId")], tracks):
        t["setVideoId"] = raw.get("setVideoId")
    author = pl.get("author")
    if isinstance(author, dict):
        author = author.get("name")
    return {"id": pid, "title": pl.get("title") or "", "author": author or "", "thumb": thumb,
            "count": pl.get("trackCount") or len(tracks), "tracks": tracks}


def get_yt_playlist(pid):
    return playlist_payload(yt().get_playlist(pid, limit=None), pid)


def get_yt_liked():
    return playlist_payload(yt().get_liked_songs(limit=5000), "LM")


def rate(video_id, like):
    from ytmusicapi.models.content.enums import LikeStatus

    yt().rate_song(video_id, LikeStatus.LIKE if like else LikeStatus.INDIFFERENT)
    clear_cache(("yl",))


def add_to_yt_playlist(pid, video_ids):
    res = yt().add_playlist_items(pid, video_ids, duplicates=False)
    clear_cache(("yp", "yl"))
    return res


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


_mock_account = {"signedIn": False}
_mock_liked = set()


def mock_login():
    _login.update(state="open", error="")

    def finish():
        time.sleep(2.5)
        _mock_account.update(signedIn=True, name="Alex Rivera", handle="@alexrivera", photo=_mock_thumb("alex"))
        _mock_liked.update({"mock0000000", "mock0000002", "mock0000005"})
        _login.update(state="done")

    threading.Thread(target=finish, daemon=True).start()


def mock_yt_playlists():
    names = [("Road trip", 24), ("Rainy Sunday", 17), ("Gym", 31), ("Discover Weekly finds", 12), ("Focus flow", 40)]
    return [{"id": f"PLmock{i}", "title": n, "count": str(c), "thumb": _mock_thumb(n)} for i, (n, c) in enumerate(names)]


def mock_yt_playlist(pid):
    pl = next((p for p in mock_yt_playlists() if p["id"] == pid), None) or {"id": pid, "title": "Playlist", "thumb": ""}
    order = _MOCK_SONGS[int(pid[-1]) % 3:] + _MOCK_SONGS[:int(pid[-1]) % 3] if pid[-1].isdigit() else _MOCK_SONGS
    tracks = [_mock_track(_MOCK_SONGS.index(t), t) for t in order if "(" not in t[0]]
    return {"id": pid, "title": pl["title"], "author": "Alex Rivera", "thumb": pl["thumb"], "count": len(tracks), "tracks": tracks}


def mock_yt_liked():
    tracks = [_mock_track(i, t) for i, t in enumerate(_MOCK_SONGS) if f"mock{i:07d}" in _mock_liked]
    return {"id": "LM", "title": "Liked music", "author": "Alex Rivera", "thumb": "", "count": len(tracks), "tracks": tracks}


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


def clear_cache(prefixes=None):
    with _cache_lock:
        for k in list(_cache):
            if prefixes is None or (isinstance(k, tuple) and k[0] in prefixes):
                _cache.pop(k, None)


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
            if p == "/api/account":
                if MOCK:
                    return self.send_json({**_mock_account, "login": _login["state"], "loginError": "", "canWindow": True})
                try:
                    acct = cached(("acct", _auth["version"]), 300, get_account)
                except Exception as e:
                    print(f"[account] {e!r}")
                    acct = {"signedIn": bool(_auth["headers"]), "name": "", "photo": "", "problem": True}
                return self.send_json({**acct, "login": _login["state"], "loginError": _login["error"],
                                       "canWindow": _native["window"] is not None})
            if p == "/api/yt/playlists":
                if MOCK:
                    return self.send_json(mock_yt_playlists() if _mock_account["signedIn"] else [])
                if not _auth["headers"]:
                    return self.send_json([])
                return self.send_json(cached(("yp", _auth["version"]), 120, get_yt_playlists))
            if p == "/api/yt/playlist":
                if MOCK:
                    return self.send_json(mock_yt_playlist(q["id"]))
                return self.send_json(cached(("yp", _auth["version"], q["id"]), 120, lambda: get_yt_playlist(q["id"])))
            if p == "/api/yt/liked":
                if MOCK:
                    return self.send_json(mock_yt_liked())
                if not _auth["headers"]:
                    return self.send_json({"tracks": []})
                return self.send_json(cached(("yl", _auth["version"]), 120, get_yt_liked))
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
            if p == "/api/account/login":
                if MOCK:
                    mock_login()
                    return self.send_json({"mode": "window"})
                if _native["window"] is None:
                    return self.send_json({"mode": "paste"})
                open_login_window()
                return self.send_json({"mode": "window"})
            if p == "/api/account/paste":
                if MOCK:
                    raise ValueError("Pasting isn't available in demo mode.")
                return self.send_json(sign_in_with(parse_pasted_headers(data.get("text", ""))))
            if p == "/api/account/logout":
                if MOCK:
                    _mock_account.clear(); _mock_account["signedIn"] = False
                else:
                    sign_out()
                    if _native["window"] is not None:
                        try:
                            _native["window"].clear_cookies()  # also sign the player out
                        except Exception as e:
                            print(f"[sign-out] {e!r}")
                _login.update(state="idle", error="")
                return self.send_json({"ok": True})
            if p == "/api/yt/rate":
                if MOCK:
                    (_mock_liked.add if data.get("like") else _mock_liked.discard)(data["videoId"])
                else:
                    rate(data["videoId"], bool(data.get("like")))
                return self.send_json({"ok": True})
            if p == "/api/yt/rate-many":
                ids = [v for v in data.get("videoIds", []) if isinstance(v, str)][:500]
                done = 0
                for vid in ids:
                    if MOCK:
                        _mock_liked.add(vid)
                    else:
                        rate(vid, True)
                    done += 1
                return self.send_json({"liked": done})
            if p == "/api/yt/playlist/add":
                if not MOCK:
                    add_to_yt_playlist(data["id"], data["videoIds"])
                return self.send_json({"ok": True})
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
        except ValueError as e:
            return self.send_error_json(400, str(e))
        except Exception as e:
            print(f"[POST {p}] {e!r}", file=sys.stderr)
            msg = "Could not save your library." if p in ("/api/like", "/api/recent") or p.startswith("/api/playlists") \
                else "YouTube Music didn't accept that. Check your internet connection or sign in again."
            return self.send_error_json(502 if p.startswith(("/api/yt", "/api/account")) else 500, msg)

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

try:
    import pyi_splash  # only present in Klang.exe: the start screen shown while it unpacks
except ImportError:
    pyi_splash = None


def close_splash():
    if pyi_splash:
        try:
            pyi_splash.close()
        except Exception:
            pass


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


def open_browser_window(url):
    """Fallback when no native window is possible: an Edge app window, else the default browser."""
    edge = find_edge()
    if edge:
        subprocess.Popen([edge, f"--app={url}", "--window-size=1320,840"], close_fds=True)
    else:
        webbrowser.open(url)
    threading.Timer(1.5, close_splash).start()


def style_title_bar(window):
    """Windows 11: paint the title bar in Klang's graphite so it blends with the app."""
    try:
        import ctypes

        hwnd = window.native.Handle.ToInt32()
        dwm = ctypes.windll.dwmapi
        for attr, value in ((20, 1), (35, 0x00231E1D), (36, 0x00F2EBEC)):  # dark mode, caption, text
            v = ctypes.c_int(value)
            dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), 4)
    except Exception as e:  # older Windows versions simply keep the default title bar
        print(f"[title bar] {e}")


_native = {"window": None}
_login = {"state": "idle", "error": ""}  # idle | open | done | closed | failed

GOOGLE_SIGN_IN = (
    "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue="
    "https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D"
    "https%253A%252F%252Fmusic.youtube.com%252F"
)


def open_login_window():
    """Show Google's own sign-in page in a Klang window, then take over the YouTube session."""
    import webview

    _login.update(state="open", error="")
    win = webview.create_window("Sign in to YouTube – Klang", GOOGLE_SIGN_IN, width=520, height=760,
                                min_size=(420, 600), background_color="#1d1e23")
    closed = threading.Event()
    win.events.closed += closed.set
    win.events.shown += lambda: style_title_bar(win)

    def watch():
        tried = None
        while not closed.is_set():
            time.sleep(1.2)
            try:
                current = win.get_current_url() or ""
                if ".youtube.com" not in current:
                    continue
                jar = {}
                for c in win.get_cookies() or []:
                    for name, morsel in c.items():
                        domain = (morsel["domain"] or "").lower()
                        if not domain or domain.endswith("youtube.com"):
                            jar[name] = morsel.value
                if "__Secure-3PAPISID" not in jar:
                    continue
                cookie = "; ".join(f"{k}={v}" for k, v in jar.items())
                if cookie == tried:
                    continue
                tried = cookie
                sign_in_with(auth_headers_from_cookie(cookie))
                _login.update(state="done")
                win.destroy()
                return
            except Exception as e:
                print(f"[sign-in] {e!r}")
                _login.update(error=str(e))
        if _login["state"] == "open":
            _login.update(state="closed")

    threading.Thread(target=watch, daemon=True).start()


def run_native_window(url):
    """Open Klang in its own app window (WebView2). Returns False if that isn't possible."""
    try:
        import webview
    except Exception as e:
        print(f"[window] pywebview unavailable: {e}")
        return False
    try:
        window = webview.create_window(
            "Klang", url, width=1320, height=840, min_size=(900, 620),
            background_color="#1d1e23", text_select=False,
        )

        def on_shown():
            close_splash()
            style_title_bar(window)

        window.events.shown += on_shown
        _native["window"] = window
        webview.start(
            gui="edgechromium" if os.name == "nt" else None,
            private_mode=False,  # keep settings and queue between sessions
            storage_path=str(DATA_DIR / "webview"),
        )
        return True
    except Exception as e:
        print(f"[window] native window failed: {e}")
        return False


def port_in_use():
    with socket.socket() as s:
        return s.connect_ex((HOST, PORT)) == 0


def watchdog(server):
    """Browser fallback only: shut down once the window has been closed for 25 seconds."""
    while True:
        time.sleep(5)
        if time.time() - _last_ping > 25:
            print("Window closed – Klang is shutting down.")
            server.shutdown()
            return


def main():
    url = f"http://{HOST}:{PORT}/"
    if port_in_use():
        # Already running: just open another window onto the same library
        if not NO_WINDOW and not run_native_window(url):
            open_browser_window(url)
        close_splash()
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    load_auth()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"Klang is running at {url}" + ("  (demo mode)" if MOCK else ""))

    if NO_WINDOW:
        close_splash()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return

    threading.Thread(target=server.serve_forever, daemon=True).start()
    if run_native_window(url):
        server.shutdown()  # the window was closed: quit
        return

    # No native window available: use the browser and quit when it goes quiet
    open_browser_window(url)
    if not NO_AUTOEXIT:
        watchdog(server)
    else:
        threading.Event().wait()


if __name__ == "__main__":
    main()
