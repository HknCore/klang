"""How many popular songs may play in embedded YouTube players?

Informational check for the build pipeline (prints GitHub annotations).
Run with:  python tests/diag_embed.py
"""
from ytmusicapi import YTMusic

QUERIES = [
    "Billie Eilish birds of a feather", "Taylor Swift Fortnight", "The Weeknd Blinding Lights",
    "Dua Lipa Houdini", "Tarkan Kuzu Kuzu", "Sezen Aksu Gidiyorum", "Ed Sheeran Shape of You",
    "Rammstein Du hast", "Bad Bunny Monaco", "Adele Hello", "Daft Punk Get Lucky", "Coldplay Yellow",
]

yt = YTMusic(language="en")
total = blocked = 0
lines = []
for q in QUERIES:
    try:
        song = (yt.search(q, filter="songs", limit=1) or [None])[0]
        if not song:
            continue
        status = yt.get_song(song["videoId"]).get("playabilityStatus", {})
        ok = bool(status.get("playableInEmbed"))
        total += 1
        blocked += not ok
        lines.append(f"{'ok     ' if ok else 'BLOCKED'} {song['title']} ({song['videoId']}) {status.get('status', '')}")
    except Exception as e:
        lines.append(f"error   {q}: {e!r}")

print("\n".join(lines))
for line in lines[:6]:
    print(f"::notice title=Song status::{line}")
print(f"::notice title=Embedded player::{blocked} of {total} popular songs are blocked in embedded players")
