<div align="center">

<img src="docs/logo.svg" width="88" alt="Klang logo">

# Klang

**YouTube Music, minus the clutter.**<br>
A fast, good-looking music player for Windows with a search that actually finds the song you meant.

<p>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-a58bff?style=flat-square&labelColor=1d1e23" alt="Windows 10 and 11">
  <img src="https://img.shields.io/badge/App%20size-under%201%20MB-a58bff?style=flat-square&labelColor=1d1e23" alt="App size under 1 MB">
  <img src="https://img.shields.io/badge/Account-not%20required-a58bff?style=flat-square&labelColor=1d1e23" alt="No account required">
  <img src="https://img.shields.io/badge/License-MIT-a58bff?style=flat-square&labelColor=1d1e23" alt="MIT license">
</p>

<a href="https://github.com/HknCore/klang/releases/latest"><b>⬇ Download for Windows</b></a>
&nbsp;·&nbsp;
<a href="#-features">Features</a>
&nbsp;·&nbsp;
<a href="#-questions">Questions</a>

<br><br>

<img src="docs/hero.png" alt="Klang playing a playlist called Late night drives" width="100%">

</div>

<br>

## Why Klang?

You know the feeling. You search for a song and get the live version, a cover, a sped-up edit, a lyric video and a fan upload, in that order. The official web player eats memory, stutters, and buries the song under everything else.

Klang fixes the part you touch every day. It keeps the huge YouTube Music catalog, and wraps it in a quick, quiet player that respects your time and your PC.

<br>

<table>
<tr>
<td width="50%" valign="top">

<img src="docs/icons/search.svg" width="44" alt="">

### Search that knows what a song is
Results are split into **Songs**, **Albums**, **Artists** and **Videos**. Duplicates are merged, exact matches rise to the top, and covers, live cuts, remixes, sped-up and nightcore edits stay hidden until you ask for them.

</td>
<td width="50%" valign="top">

<img src="docs/icons/feather.svg" width="44" alt="">

### Light on your PC
No bundled browser, no Electron. Klang runs a tiny local helper and draws its window with the Edge engine Windows already has. The app itself is under 1 MB.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="docs/icons/heart.svg" width="44" alt="">

### Your library, on your machine
Like songs, build playlists, drag and drop to reorder. Everything is saved in one small file on your computer. No sign-up, no sync, no tracking.

</td>
<td width="50%" valign="top">

<img src="docs/icons/radio.svg" width="44" alt="">

### Music that keeps going
When your queue runs out, Klang can continue with similar songs. Start a radio from any track, or line up what plays next with a right-click.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="docs/icons/sparkle.svg" width="44" alt="">

### Made to feel good
Graphite and lavender, smooth transitions, a breathing ring around the cover while music plays, and a short intro that sets the mood.

</td>
<td width="50%" valign="top">

<img src="docs/icons/keyboard.svg" width="44" alt="">

### Built for the keyboard
<kbd>Ctrl</kbd>+<kbd>K</kbd> to search, <kbd>Space</kbd> to play, <kbd>Ctrl</kbd>+<kbd>→</kbd> to skip. Mouse back and forward buttons work too.

</td>
</tr>
</table>

<br>

## ✦ A closer look

<h3 align="center">Search, sorted</h3>
<p align="center">Type a name and get a clear top result, the real songs, then artists and albums.<br>Suggestions appear as you type.</p>

<img src="docs/screens/03-suggest.png" alt="Search with live suggestions and results split into songs, albums, artists and videos" width="100%">

<br><br>

<h3 align="center">No more “Sped Up (Nightcore Remix)”</h3>
<p align="center">Variants are hidden by default. One click shows them again, clearly labeled.</p>

<img src="docs/screens/05b-variants.png" alt="Song results with a live version marked as a variant" width="100%">

<br><br>

<h3 align="center">Albums and artists that look the part</h3>
<p align="center">Every page picks up the colors of its cover art.</p>

<table>
<tr>
<td width="50%"><img src="docs/screens/08-album.png" alt="Album page"></td>
<td width="50%"><img src="docs/screens/09-artist.png" alt="Artist page"></td>
</tr>
</table>

<br>

<h3 align="center">Everything one right-click away</h3>
<p align="center">Play next, add to queue, start a radio, add to a playlist, jump to the album or artist.</p>

<img src="docs/screens/06-menu.png" alt="Right-click menu on a song" width="100%">

<br><br>

<h3 align="center">Now playing, alive</h3>

<p align="center">
  <img src="docs/now-playing.gif" alt="Animated ring around the cover of the current song" width="330">
</p>

<p align="center">The cover turns into a record and a ring of bars dances around it while music plays.</p>

<br>

<h3 align="center">Hello, Klang</h3>

<p align="center">
  <img src="docs/splash.gif" alt="Klang's intro animation" width="720">
</p>

<br>

## ⬇ Get started in a minute

> **You need:** Windows 10 or 11 and [Python 3.9 or newer](https://www.python.org/downloads/).<br>
> Don't have Python? Open a terminal and run `winget install Python.Python.3.12`.

<table>
<tr>
<td align="center" width="33%">
<h3>1</h3>
<b>Download</b><br>
Get <code>Klang-…-windows.zip</code> from the<br><a href="https://github.com/HknCore/klang/releases/latest">latest release</a> and unzip it anywhere.
</td>
<td align="center" width="33%">
<h3>2</h3>
<b>Double-click <code>Klang.bat</code></b><br>
The first start sets things up for about a minute. After that, Klang opens in a second or two.
</td>
<td align="center" width="33%">
<h3>3</h3>
<b>Search and play</b><br>
Press <kbd>Ctrl</kbd>+<kbd>K</kbd>, type a song, press <kbd>Enter</kbd>. That's it.
</td>
</tr>
</table>

**Want it on your desktop?** Double-click `Create shortcut.bat` once. Klang gets its own icon.

**Something stopped working after a YouTube change?** Double-click `Update.bat`.

<br>

## ⌨ Shortcuts

| Do this | Press |
| --- | --- |
| Search from anywhere | <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd> |
| Play or pause | <kbd>Space</kbd> |
| Next or previous song | <kbd>Ctrl</kbd>+<kbd>→</kbd> / <kbd>Ctrl</kbd>+<kbd>←</kbd> |
| Jump 5 seconds | <kbd>→</kbd> / <kbd>←</kbd> |
| Like the current song | <kbd>L</kbd> |
| Shuffle on or off | <kbd>S</kbd> |
| Mute | <kbd>M</kbd> |
| Back or forward | <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd>, or your mouse side buttons |

<br>

## ? Questions

<details>
<summary><b>Do I need a YouTube or Google account?</b></summary>
<br>
No. Search and playback work without signing in. Your likes and playlists live on your computer.
</details>

<details>
<summary><b>Are there ads?</b></summary>
<br>
Klang plays music through YouTube's official embedded player, so YouTube decides about ads, just like on youtube.com. Klang opens in Microsoft Edge's app mode and uses your Edge profile, so if you're signed in to YouTube Premium in Edge, you get Premium there too.
</details>

<details>
<summary><b>Why does Klang sometimes skip a song?</b></summary>
<br>
Some labels don't allow their uploads to play outside of YouTube. When that happens, Klang quietly looks for another official upload of the same song with the same length and plays that instead. If there isn't one, it moves on to the next song and tells you.
</details>

<details>
<summary><b>Can I import my Spotify playlists?</b></summary>
<br>
Not yet. It's the next big thing on the list (see below).
</details>

<details>
<summary><b>Where is my data stored?</b></summary>
<br>
In <code>data/library.json</code> next to <code>Klang.bat</code>. Back it up or copy it to another PC to take your library with you.
</details>

<details>
<summary><b>Can I try it without internet?</b></summary>
<br>
Yes. Run <code>python server.py --mock</code> to open a demo with sample music. That's how the screenshots on this page were made.
</details>

<br>

## 🔒 Private by design

<img src="docs/icons/lock.svg" width="44" align="left" alt="">

Klang only listens on your own computer (`127.0.0.1`), never on your network. It collects nothing and phones home to no one. The only outside connections are to YouTube Music, to fetch search results and play music. When you close the window, Klang shuts itself down.

<br clear="left">

<br>

## 🗺 What's next

- [ ] Import playlists from Spotify
- [ ] Sign in to see your YouTube Music library and playlists
- [ ] Mini player that stays on top
- [ ] Tray icon and media keys when the window is in the background
- [ ] One-file installer, no Python needed

Ideas and bug reports are welcome in the issues.

<br>

## 🛠 How it works

```
 Klang.bat ──▶ server.py (local helper, 127.0.0.1:8777)
                  │  cleans up search results via ytmusicapi
                  │  stores likes and playlists in data/library.json
                  ▼
              Edge app window ──▶ ui/  (plain HTML, CSS, JavaScript)
                                   └─ plays through the official YouTube embed
```

No build step, no frameworks. The interface is three files in `ui/`, the helper is a single Python file. Run `python server.py --no-window` to start just the helper and open `http://127.0.0.1:8777` in any browser.

<br>

## 💜 Credits

- [ytmusicapi](https://github.com/sigma67/ytmusicapi) for talking to YouTube Music
- [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) and [Onest](https://github.com/simpals/onest) typefaces, under the SIL Open Font License

Klang is an independent project and is not affiliated with, endorsed by or connected to YouTube or Google. YouTube and YouTube Music are trademarks of Google LLC.

Released under the [MIT License](LICENSE).

<div align="center">
<br>
<img src="docs/logo.svg" width="36" alt="">
<br>
<sub><i>klang</i> is German for “sound”.</sub>
</div>
