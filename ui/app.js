/* ==========================================================================
   Klang – app logic
   Plain JavaScript, no build step. Talks to the local server (server.py)
   and plays music through the official embedded YouTube player.
   ========================================================================== */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };
// Animations are on by default (even when Windows has "Animation effects" turned off);
// they can be switched off in the settings menu.
const calm = () => state.settings.animations === false;

/* ---------------------------------------------------------------- API --- */
// Secret for this session, put into the page by the local service (see server.py)
const API_TOKEN = document.querySelector('meta[name="klang-token"]')?.content || "";

const api = {
  async get(path) {
    const r = await fetch(path, { headers: { "X-Klang-Token": API_TOKEN } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  },
  async send(method, path, body) {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-Klang-Token": API_TOKEN }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  },
};

/* -------------------------------------------------------------- State --- */
const STORE_KEY = "klang:v1";
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } })();

const state = {
  mock: false,
  lib: { liked: [], playlists: [], recent: [] },
  settings: Object.assign({ volume: 70, muted: false, shuffle: false, repeat: "off", autoRadio: true, panel: true, variants: false }, saved.settings),
  queue: saved.queue || [],        // tracks
  index: saved.index ?? -1,        // current position in queue
  context: saved.context || null,  // { label, route } of where playback started
  playing: false,
  route: null,
  history: [],
  hpos: -1,
  searchTab: "all",
};

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, queue: state.queue.slice(0, 300), index: state.index, context: state.context }));
  } catch { /* storage unavailable – ignore */ }
}

const current = () => state.queue[state.index] || null;
const isLikedHere = (vid) => state.lib.liked.some((t) => t.videoId === vid);
const isLiked = (vid) => isLikedHere(vid) || account.liked.has(vid);

/* -------------------------------------------------------------- Rings --- */
/* A ring of radial bars. Used in the splash, the logo and around the cover. */
const rings = [];
function buildRing(svg) {
  const n = +svg.dataset.bars, r = +svg.dataset.r, len = +svg.dataset.len;
  const bars = [];
  let out = "";
  for (let i = 0; i < n; i++) {
    const s = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.43));
    out += `<g transform="rotate(${(i * 360) / n})"><line x1="0" y1="${-r}" x2="0" y2="${-r - len * s}" style="--i:${i};--s:${s.toFixed(3)}"/></g>`;
    bars.push({ s, phase: Math.random() * 6.28, speed: 1.6 + Math.random() * 2.4 });
  }
  svg.innerHTML = out;
  const ring = { svg, r, len, bars, lines: $$("line", svg), level: 0 };
  rings.push(ring);
  return ring;
}

let ringT = 0;
function animateRings(ts) {
  const t = ts / 1000;
  const dt = Math.min(0.05, t - ringT || 0.016);
  ringT = t;
  for (const ring of rings) {
    if (ring.svg.classList.contains("splash-ring")) continue;
    const target = state.playing && !calm() ? 1 : 0;
    ring.level = calm() ? target : ring.level + (target - ring.level) * Math.min(1, dt * 4);
    if (ring.level < 0.002 && ring._still) continue;
    ring._still = ring.level < 0.002;
    ring.lines.forEach((line, i) => {
      const b = ring.bars[i];
      const live = 0.25 + 0.75 * Math.abs(Math.sin(t * b.speed + b.phase)) * (0.65 + 0.35 * Math.sin(t * 0.9 + i * 0.5));
      const s = b.s * (1 - ring.level) + live * ring.level;
      line.setAttribute("y2", (-ring.r - ring.len * s).toFixed(2));
    });
  }
  requestAnimationFrame(animateRings);
}

/* ------------------------------------------------------------- Splash --- */
async function boot() {
  $$(".ring").forEach(buildRing);
  document.body.classList.toggle("calm", calm());
  requestAnimationFrame(animateRings);
  document.body.classList.add("booting");
  const started = performance.now();
  const status = $(".splash-status");

  // Wait for the server (it may still be starting up)
  for (let attempt = 0; ; attempt++) {
    try {
      const ping = await api.get("/api/ping");
      state.mock = !!ping.mock;
      break;
    } catch {
      if (attempt === 6) { status.textContent = "Can't reach the Klang server. Start it again with Klang.bat."; status.classList.add("error"); }
      await sleep(700);
    }
  }
  status.textContent = state.mock ? "Demo mode" : "Ready";
  await Promise.all([loadLibrary(), document.fonts?.ready, sleep(Math.max(0, 1900 - (performance.now() - started)))]);

  initUI();
  restoreSession();
  loadAccount({ quiet: false });
  navigate({ name: "home" });

  const splash = $("#splash");
  splash.classList.add("leaving");
  document.body.classList.remove("booting");
  $("#app").inert = false;
  setTimeout(() => splash.remove(), 1100);
  setInterval(() => api.get("/api/ping").catch(() => {}), 5000);
}

async function loadLibrary() {
  try {
    state.lib = await api.get("/api/library");
  } catch (e) {
    toast("Your library couldn't be loaded. " + e.message, true);
  }
}

/* -------------------------------------------------------------- Toast --- */
function toast(msg, err = false) {
  const last = $("#toasts").lastElementChild;
  if (last && !last.classList.contains("out") && last.textContent === msg) {
    clearTimeout(last._t);
    last.animate([{ transform: "scale(1.06)" }, { transform: "none" }], { duration: 300, easing: "ease-out" });
    last._t = setTimeout(() => { last.classList.add("out"); setTimeout(() => last.remove(), 320); }, 2600);
    return;
  }
  const el = h(`<div class="toast${err ? " err" : ""}"><i></i><span>${esc(msg)}</span></div>`);
  $("#toasts").append(el);
  el._t = setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, err ? 4200 : 2600);
}

/* ------------------------------------------------------------- Dialog --- */
function ask(title, { value = "", ok = "Save", input = true } = {}) {
  const dlg = $("#dlg");
  $("#dlgTitle").textContent = title;
  $("#dlgOk").textContent = ok;
  const inp = $("#dlgInput");
  inp.style.display = input ? "" : "none";
  inp.value = value;
  dlg.showModal();
  if (input) { inp.focus(); inp.select(); }
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      resolve(input ? inp.value.trim() || value : true);
    }, { once: true });
  });
}

/* --------------------------------------------------------------- Menu --- */
let menuOpenFor = null;
function openMenu(x, y, items, anchor) {
  const menu = $("#menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it === "sep") { menu.append(h("<hr>")); continue; }
    if (it.label && it.heading) { menu.append(h(`<div class="sub-label">${esc(it.label)}</div>`)); continue; }
    if (it.group) {
      const g = h(`<div class="pl-list"></div>`);
      it.group.forEach((sub) => g.append(menuButton(sub)));
      menu.append(g);
      continue;
    }
    menu.append(menuButton(it));
  }
  menu.classList.add("open");
  const r = menu.getBoundingClientRect();
  const left = Math.min(x, innerWidth - r.width - 10);
  const top = y + r.height > innerHeight - 10 ? Math.max(10, y - r.height) : y;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.style.setProperty("--ox", `${x - left}px ${top < y ? "bottom" : "top"}`);
  menuOpenFor = anchor || null;
  anchor?.classList.add("sel");
}
function menuButton(it) {
  const b = h(`<button role="menuitem" class="${it.danger ? "danger" : ""}">${it.icon ? `<svg><use href="#i-${it.icon}"/></svg>` : ""}<span>${esc(it.label)}</span></button>`);
  b.addEventListener("click", () => { closeMenu(); it.action(); });
  return b;
}
function closeMenu() {
  $("#menu").classList.remove("open");
  menuOpenFor?.classList.remove("sel");
  menuOpenFor = null;
}

function trackMenu(track, x, y, anchor, opts = {}) {
  const pls = state.lib.playlists;
  const items = [
    { label: "Play next", icon: "queue", action: () => playNext([track]) },
    { label: "Add to queue", icon: "list", action: () => addToQueue([track]) },
    { label: "Start radio", icon: "radio", action: () => startRadio(track) },
    "sep",
    { label: "Add to playlist", heading: true },
    { group: [
      { label: "New playlist…", icon: "plus", action: () => createPlaylist([track]) },
      ...pls.map((p) => ({ label: p.name, icon: "list", action: () => addToPlaylist(p.id, [track]) })),
    ] },
    ...(signedIn() && account.playlists.length ? [
      { label: "Add to YouTube Music playlist", heading: true },
      { group: account.playlists.map((p) => ({ label: p.title, icon: "list", action: () => addToYtPlaylist(p, [track]) })) },
    ] : []),
    "sep",
    { label: isLiked(track.videoId) ? "Remove from liked songs" : "Add to liked songs", icon: "heart", action: () => toggleLike(track) },
  ];
  if (track.albumId) items.push({ label: "Go to album", icon: "disc", action: () => navigate({ name: "album", id: track.albumId }) });
  if (track.artistId) items.push({ label: "Go to artist", icon: "user", action: () => navigate({ name: "artist", id: track.artistId }) });
  items.push({ label: "Open on YouTube", icon: "ext", action: () => window.open(`https://music.youtube.com/watch?v=${track.videoId}`, "_blank") });
  if (opts.playlistId) {
    items.push("sep", { label: "Remove from this playlist", icon: "trash", danger: true, action: () => removeFromPlaylist(opts.playlistId, track) });
  }
  if (opts.queueIndex != null) {
    items.push("sep", { label: "Remove from queue", icon: "close", danger: true, action: () => removeFromQueue(opts.queueIndex) });
  }
  openMenu(x, y, items, anchor);
}

/* ------------------------------------------------------------- Router --- */
const sameRoute = (a, b) => a && b && a.name === b.name && a.id === b.id && a.q === b.q;

function navigate(route, { replace = false, fromHistory = false } = {}) {
  closeMenu();
  const scroller = $("#scroller");
  if (state.route && state.history[state.hpos]) state.history[state.hpos].scroll = scroller.scrollTop;
  if (!fromHistory) {
    if (replace && state.hpos >= 0) state.history[state.hpos] = { route };
    else if (!sameRoute(state.history[state.hpos]?.route, route)) {
      state.history = state.history.slice(0, state.hpos + 1);
      state.history.push({ route });
      state.hpos = state.history.length - 1;
    }
  }
  const isNewView = !sameRoute(state.route, route) && !(state.route?.name === "search" && route.name === "search");
  state.route = route;
  updateNav();
  const restore = fromHistory ? state.history[state.hpos]?.scroll || 0 : 0;

  const draw = () => {
    render(route);
    if (isNewView || fromHistory) scroller.scrollTop = restore;
  };
  if (isNewView && document.startViewTransition && !calm()) document.startViewTransition(draw);
  else draw();
}

function goHistory(delta) {
  const next = state.hpos + delta;
  if (next < 0 || next >= state.history.length) return;
  state.history[state.hpos].scroll = $("#scroller").scrollTop;
  state.hpos = next;
  const route = state.history[next].route;
  if (route.name === "search") { $("#q").value = route.q || ""; syncSearchbox(); }
  navigate(route, { fromHistory: true });
}

function updateNav() {
  const r = state.route;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.nav === r.name));
  $$(".nav-pl").forEach((b) => b.classList.toggle("active", (r.name === "playlist" && b.dataset.id === r.id) || (r.name === "ytplaylist" && b.dataset.yt === r.id)));
  $("#histBack").disabled = state.hpos <= 0;
  $("#histFwd").disabled = state.hpos >= state.history.length - 1;
}

let renderToken = 0;
function render(route) {
  const token = ++renderToken;
  const view = $("#view");
  const done = (el) => { if (token !== renderToken) return; view.replaceChildren(el); };
  switch (route.name) {
    case "home": return done(viewHome());
    case "search": return viewSearch(route, done, token);
    case "liked": return viewLiked(route, done, token);
    case "ytplaylist": return viewYtPlaylist(route, done, token);
    case "recent": return done(viewTrackPage({ kind: "History", title: "Recently played", tracks: state.lib.recent || [], mosaic: "recent", source: { label: "Recently played", route } }));
    case "playlist": {
      const pl = state.lib.playlists.find((p) => p.id === route.id);
      if (!pl) return done(emptyState("This playlist no longer exists", "It may have been deleted. Pick another one from the sidebar."));
      return done(viewTrackPage({ kind: "Playlist", title: pl.name, tracks: pl.tracks, playlist: pl, source: { label: pl.name, route } }));
    }
    case "album": return viewAlbum(route, done, token);
    case "artist": return viewArtist(route, done, token);
  }
}

/* -------------------------------------------------------------- Views --- */
function emptyState(title, text, button) {
  const el = h(`<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`);
  if (button) {
    const b = h(`<button class="btn primary">${esc(button.label)}</button>`);
    b.onclick = button.action;
    el.append(b);
  }
  return el;
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return "Late night listening";
  if (hr < 12) return "Good morning";
  if (hr < 18) return "Good afternoon";
  return "Good evening";
}

function viewHome() {
  const el = h(`<div></div>`);
  const recent = (state.lib.recent || []).slice(0, 12);
  el.append(h(`<section class="hello">
    <h1>${greeting()}</h1>
    <p>Search finds real songs first and keeps covers, live cuts and sped-up edits out of your way. Everything you like or save stays on this computer.</p>
  </section>`));
  const chips = h(`<div class="hint-chips"></div>`);
  [["Search", "search", () => $("#q").focus()], ["Liked songs", "heart", () => navigate({ name: "liked" })], ["New playlist", "plus", () => createPlaylist([])]]
    .forEach(([label, icon, fn]) => { const c = h(`<button class="chip"><svg><use href="#i-${icon}"/></svg>${label}</button>`); c.onclick = fn; chips.append(c); });
  el.firstElementChild.append(chips);

  if (recent.length) {
    const sec = h(`<section class="section"><div class="section-head"><h2>Recently played</h2></div></section>`);
    const more = h(`<button class="link-btn">Show all</button>`);
    more.onclick = () => navigate({ name: "recent" });
    sec.firstElementChild.append(more);
    const grid = h(`<div class="grid stagger"></div>`);
    recent.forEach((t, i) => {
      const card = cardEl({ title: t.title, sub: t.artists, thumb: t.thumb, i, onOpen: () => playList(recent, i, { label: "Recently played", route: { name: "recent" } }), onPlay: () => playList(recent, i, { label: "Recently played", route: { name: "recent" } }) });
      grid.append(card);
    });
    sec.append(grid);
    el.append(sec);
  }
  const ytSec = ytHomeSection();
  if (ytSec) el.append(ytSec);
  if (state.lib.playlists.length) {
    const sec = h(`<section class="section"><div class="section-head"><h2>Your playlists</h2></div></section>`);
    const grid = h(`<div class="grid"></div>`);
    state.lib.playlists.forEach((p, i) => {
      const card = cardEl({ title: p.name, sub: `${p.tracks.length} ${p.tracks.length === 1 ? "song" : "songs"}`, mosaic: p.tracks, i,
        onOpen: () => navigate({ name: "playlist", id: p.id }),
        onPlay: p.tracks.length ? () => playList(p.tracks, 0, { label: p.name, route: { name: "playlist", id: p.id } }) : null });
      grid.append(card);
    });
    sec.append(grid);
    el.append(sec);
  }
  if (!recent.length && !state.lib.playlists.length && !ytSec) {
    el.append(emptyState("Your music starts with a search", "Type a song, album or artist in the search bar above. Press Ctrl+K from anywhere to jump there.", { label: "Start searching", action: () => $("#q").focus() }));
  }
  return el;
}

/* Search ---------------------------------------------------------------- */
const searchCache = new Map();
async function runSearch(q) {
  const key = `${q.toLowerCase()}|${state.settings.variants}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const p = api.get(`/api/search?q=${encodeURIComponent(q)}&variants=${state.settings.variants ? "show" : "hide"}`);
  searchCache.set(key, p);
  p.catch(() => searchCache.delete(key));
  return p;
}

function skeletonList(n = 8) {
  const el = h(`<div class="tracks"></div>`);
  for (let i = 0; i < n; i++) el.append(h(`<div class="track"><span></span><div class="skel" style="width:44px;height:44px"></div><div><div class="skel" style="height:12px;width:${40 + (i * 37) % 40}%"></div><div class="skel" style="height:10px;width:${22 + (i * 23) % 25}%;margin-top:8px"></div></div></div>`));
  return el;
}

async function viewSearch(route, done, token) {
  const q = (route.q || "").trim();
  if (!q) {
    return done(emptyState("Find any song", "Type a title, an artist, or both. Results are split into songs, albums, artists and videos, with duplicates removed."));
  }
  const box = $("#searchbox");
  const fresh = !searchCache.has(`${q.toLowerCase()}|${state.settings.variants}`);
  if (fresh && token === renderToken) {
    const wrap = h(`<div></div>`);
    wrap.append(searchTabs(null), skeletonList());
    done(wrap);
  }
  box.classList.add("loading");
  let res;
  try {
    res = await runSearch(q);
  } catch (e) {
    box.classList.remove("loading");
    return done(emptyState("Search didn't go through", e.message, { label: "Try again", action: () => navigate(route, { replace: true }) }));
  }
  box.classList.remove("loading");
  if (token !== renderToken) return;
  const el = h(`<div></div>`);
  el.append(searchTabs(res));
  const body = h(`<div class="search-body"></div>`);
  el.append(body);
  done(el);
  renderSearchBody(body, res, true);
  moveInk();
}

function searchTabs(res) {
  const tabs = [["all", "All"], ["songs", "Songs"], ["albums", "Albums"], ["artists", "Artists"], ["videos", "Videos"]];
  const row = h(`<div class="tabs-row"><div class="tabs" role="tablist"><span class="tab-ink"></span></div></div>`);
  const wrap = row.firstElementChild;
  for (const [id, label] of tabs) {
    const n = res && id !== "all" ? res[id]?.length || 0 : null;
    const b = h(`<button class="tab ${state.searchTab === id ? "active" : ""}" role="tab" data-tab="${id}">${label}${n != null ? `<span class="n">${n}</span>` : ""}</button>`);
    b.onclick = () => {
      if (state.searchTab === id || !res) return;
      state.searchTab = id;
      $$(".tab", wrap).forEach((t) => t.classList.toggle("active", t === b));
      moveInk();
      renderSearchBody($(".search-body"), res, true);
    };
    wrap.append(b);
  }
  const chip = h(`<button class="chip ${state.settings.variants ? "on" : ""}" title="Live versions, covers, remixes, sped up, nightcore and similar">${state.settings.variants ? "Showing variants" : "Variants hidden"}</button>`);
  chip.onclick = () => {
    state.settings.variants = !state.settings.variants;
    persist();
    navigate(state.route, { replace: true });
  };
  row.append(chip);
  requestAnimationFrame(moveInk);
  return row;
}

function moveInk() {
  const active = $(".tab.active"), ink = $(".tab-ink");
  if (!active || !ink) return;
  ink.style.left = active.offsetLeft + "px";
  ink.style.width = active.offsetWidth + "px";
}

function renderSearchBody(body, res, animate) {
  body.replaceChildren();
  const src = { label: `Search: ${res.query}`, route: { name: "search", q: res.query } };
  const tab = state.searchTab;
  const nothing = !res.songs.length && !res.albums.length && !res.artists.length && !res.videos.length;
  if (nothing) return body.append(emptyState(`No results for “${res.query}”`, "Check the spelling, or try fewer words. Turning on variants can help for live and remix versions."));

  if (tab === "all") {
    if (res.top || res.songs.length) {
      const sec = h(`<section class="section"><div class="top-grid"></div></section>`);
      const grid = sec.firstElementChild;
      if (res.top) grid.append(topCard(res.top, res));
      if (res.songs.length) {
        const col = h(`<div><div class="section-head"><h2>Songs</h2></div></div>`);
        const more = h(`<button class="link-btn">See all</button>`);
        more.onclick = () => { state.searchTab = "songs"; renderSearchBody(body, res, true); $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "songs")); moveInk(); };
        col.firstElementChild.append(more);
        col.append(trackList(res.songs.slice(0, 5), { compact: true, source: src, animate, all: res.songs }));
        grid.append(col);
      }
      body.append(sec);
    }
    if (res.artists.length) body.append(cardSection("Artists", res.artists.slice(0, 6), "artist", animate));
    if (res.albums.length) body.append(cardSection("Albums", res.albums.slice(0, 6), "album", animate));
    if (res.videos.length) {
      const sec = h(`<section class="section"><div class="section-head"><h2>Videos</h2></div></section>`);
      sec.append(trackList(res.videos.slice(0, 4), { compact: true, source: src, animate }));
      body.append(sec);
    }
    return;
  }
  if (tab === "songs" || tab === "videos") {
    const list = res[tab];
    if (!list.length) return body.append(emptyState(`No ${tab} found`, "Try the other tabs, or a different search."));
    const sec = h(`<section class="section"></section>`);
    sec.append(trackList(list, { header: true, numbered: true, source: src, animate }));
    return body.append(sec);
  }
  const list = res[tab];
  if (!list.length) return body.append(emptyState(`No ${tab} found`, "Try the other tabs, or a different search."));
  const grid = h(`<div class="grid stagger section"></div>`);
  list.forEach((it, i) => grid.append(tab === "artists" ? artistCard(it, i) : albumCard(it, i)));
  body.append(grid);
}

function topCard(top, res) {
  const isArtist = top.type === "artist";
  const el = h(`<div class="top-card" tabindex="0" style="--img:url('${esc(top.thumb)}')">
    <img class="art ${isArtist ? "round" : ""}" src="${esc(top.thumb)}" alt="">
    <div class="tt">${esc(isArtist ? top.name : top.title)}</div>
    <div class="ts"><span class="kind">${isArtist ? "Artist" : "Song"}</span>${isArtist ? "" : esc(top.artists)}</div>
    <button class="fab" title="Play"><svg><use href="#i-play"/></svg></button>
  </div>`);
  const open = () => isArtist ? navigate({ name: "artist", id: top.id }) : playList(res.songs, 0, { label: `Search: ${res.query}`, route: { name: "search", q: res.query } });
  el.addEventListener("click", (e) => { if (!e.target.closest(".fab")) open(); });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  $(".fab", el).onclick = async () => {
    if (!isArtist) return open();
    const a = await api.get(`/api/artist?id=${encodeURIComponent(top.id)}`).catch(() => null);
    if (a?.songs?.length) playList(a.songs, 0, { label: a.name, route: { name: "artist", id: top.id } });
  };
  return el;
}

function cardSection(title, items, kind, animate) {
  const sec = h(`<section class="section"><div class="section-head"><h2>${title}</h2></div></section>`);
  const grid = h(`<div class="grid ${animate ? "stagger" : ""}"></div>`);
  items.forEach((it, i) => grid.append(kind === "artist" ? artistCard(it, i) : albumCard(it, i)));
  sec.append(grid);
  return sec;
}

function cardEl({ title, sub, thumb, mosaic, round, i = 0, onOpen, onPlay }) {
  const art = mosaic ? mosaicEl(mosaic, "art").outerHTML : `<img class="art" src="${esc(thumb)}" alt="" loading="lazy">`;
  const el = h(`<div class="card ${round ? "artist" : ""}" tabindex="0" style="--i:${i}">
    <div class="cover-box">${art}${onPlay ? `<button class="fab" title="Play"><svg><use href="#i-play"/></svg></button>` : ""}</div>
    <div class="t">${esc(title)}</div><div class="s">${esc(sub || "")}</div>
  </div>`);
  el.addEventListener("click", (e) => { if (!e.target.closest(".fab")) onOpen(); });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") onOpen(); });
  if (onPlay) $(".fab", el).onclick = onPlay;
  return el;
}

function albumCard(a, i) {
  return cardEl({
    title: a.title, sub: [a.year, a.type !== "Album" ? a.type : null, a.artists].filter(Boolean).join(", "), thumb: a.thumb, i,
    onOpen: () => navigate({ name: "album", id: a.id }),
    onPlay: async () => {
      const al = await api.get(`/api/album?id=${encodeURIComponent(a.id)}`).catch((e) => toast(e.message, true));
      if (al?.tracks?.length) playList(al.tracks, 0, { label: al.title, route: { name: "album", id: a.id } });
    },
  });
}

function artistCard(a, i) {
  return cardEl({ title: a.name, sub: "Artist", thumb: a.thumb, round: true, i, onOpen: () => navigate({ name: "artist", id: a.id }) });
}

function mosaicEl(tracks, cls = "") {
  if (tracks === "liked" || tracks === "recent") {
    const icon = tracks === "liked" ? "heart-f" : "clock";
    return h(`<div class="mosaic empty ${cls}" style="background:linear-gradient(135deg,#7253e0,#3a3552 70%);color:#fff"><svg><use href="#i-${icon}"/></svg></div>`);
  }
  const thumbs = [...new Set((tracks || []).map((t) => t.thumb).filter(Boolean))].slice(0, 4);
  if (!thumbs.length) return h(`<div class="mosaic empty ${cls}"><svg><use href="#i-list"/></svg></div>`);
  if (thumbs.length < 4) return h(`<div class="mosaic single ${cls}"><img src="${esc(thumbs[0])}" alt=""></div>`);
  return h(`<div class="mosaic ${cls}">${thumbs.map((t) => `<img src="${esc(t)}" alt="">`).join("")}</div>`);
}

/* Track list ----------------------------------------------------------- */
function trackList(tracks, { numbered = true, compact = false, header = false, source, animate = false, playlistId = null, all = null } = {}) {
  const wrap = h(`<div></div>`);
  if (header) wrap.append(h(`<div class="list-head"><span class="c-idx">#</span><span></span><span>Title</span><span class="c-alb">Album</span><span></span><span class="c-d"><svg style="width:15px;height:15px"><use href="#i-clock"/></svg></span></div>`));
  const list = h(`<div class="tracks ${compact ? "compact" : ""} ${animate ? "stagger" : ""}"></div>`);
  const playSet = all || tracks;
  tracks.forEach((t, i) => list.append(trackRow(t, i, numbered)));
  list._tracks = tracks;

  const rowOf = (e) => e.target.closest(".track");
  const trackOf = (row) => tracks[+row.dataset.i];
  const play = (row) => playList(playSet, +row.dataset.i, source);

  list.addEventListener("click", (e) => {
    const row = rowOf(e); if (!row) return;
    const t = trackOf(row);
    if (e.target.closest(".idx button")) return play(row);
    if (e.target.closest(".heart")) { const btn = e.target.closest(".heart"); toggleLike(t).then(() => { btn.classList.add("pop"); setTimeout(() => btn.classList.remove("pop"), 500); }); return; }
    if (e.target.closest(".more")) { const r = e.target.closest(".more").getBoundingClientRect(); return trackMenu(t, r.left - 180, r.bottom + 6, row, { playlistId }); }
    if (e.target.closest("[data-artist]")) return navigate({ name: "artist", id: e.target.closest("[data-artist]").dataset.artist });
    if (e.target.closest("[data-album]")) return navigate({ name: "album", id: e.target.closest("[data-album]").dataset.album });
    $$(".track.sel", list).forEach((r) => r.classList.remove("sel"));
    row.classList.add("sel");
  });
  list.addEventListener("dblclick", (e) => { const row = rowOf(e); if (row && !e.target.closest("button")) play(row); });
  list.addEventListener("keydown", (e) => { const row = rowOf(e); if (row && e.key === "Enter") play(row); });
  list.addEventListener("contextmenu", (e) => { const row = rowOf(e); if (!row) return; e.preventDefault(); trackMenu(trackOf(row), e.clientX, e.clientY, row, { playlistId }); });

  // Drag & drop: onto a sidebar playlist, or reorder inside a playlist
  list.addEventListener("dragstart", (e) => {
    const row = rowOf(e); if (!row) return;
    dragData = { tracks: [trackOf(row)], from: playlistId, row };
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", trackOf(row).title);
  });
  list.addEventListener("dragend", () => { $$(".dragging,.drop-above", list).forEach((r) => r.classList.remove("dragging", "drop-above")); dragData = null; });
  if (playlistId) {
    list.addEventListener("dragover", (e) => {
      if (!dragData || dragData.from !== playlistId) return;
      e.preventDefault();
      $$(".drop-above", list).forEach((r) => r.classList.remove("drop-above"));
      rowOf(e)?.classList.add("drop-above");
    });
    list.addEventListener("drop", async (e) => {
      if (!dragData || dragData.from !== playlistId) return;
      e.preventDefault();
      const target = rowOf(e);
      const pl = state.lib.playlists.find((p) => p.id === playlistId);
      const moving = dragData.tracks[0];
      const order = pl.tracks.filter((t) => t.videoId !== moving.videoId);
      const at = target ? order.findIndex((t) => t.videoId === trackOf(target).videoId) : order.length;
      order.splice(at < 0 ? order.length : at, 0, moving);
      pl.tracks = order;
      navigate(state.route, { replace: true });
      await api.send("POST", `/api/playlists/${playlistId}/reorder`, { order: order.map((t) => t.videoId) }).catch((err) => toast(err.message, true));
    });
  }
  wrap.append(list);
  return wrap;
}

function trackRow(t, i, numbered) {
  const cur = current();
  const isCur = cur && cur.videoId === t.videoId;
  const artist = t.artistId ? `<span class="lnk" data-artist="${esc(t.artistId)}">${esc(t.artists)}</span>` : esc(t.artists);
  const album = t.albumId ? `<span class="lnk" data-album="${esc(t.albumId)}">${esc(t.album)}</span>` : esc(t.album || "");
  return h(`<div class="track ${isCur ? "current" : ""} ${t.kind === "video" ? "is-video" : ""}" data-i="${i}" data-vid="${esc(t.videoId)}" tabindex="0" draggable="true" style="--i:${i}">
    <div class="idx"><span>${numbered ? i + 1 : ""}</span><div class="eq"><i></i><i></i><i></i></div><button title="Play"><svg><use href="#i-play"/></svg></button></div>
    <img class="art" src="${esc(t.thumb)}" alt="" loading="lazy">
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="a">${t.explicit ? `<span class="badge">E</span>` : ""}${t.variant ? `<span class="badge var">Variant</span>` : ""}${artist}</div></div>
    <div class="alb">${album}</div>
    <button class="icon-btn sm heart ${isLiked(t.videoId) ? "liked" : ""}" title="Like"><svg><use href="#i-${isLiked(t.videoId) ? "heart-f" : "heart"}"/></svg></button>
    <div class="d">${esc(t.duration)}</div>
    <button class="icon-btn sm more" title="More"><svg><use href="#i-more"/></svg></button>
  </div>`);
}

function markCurrentRows() {
  const vid = current()?.videoId;
  $$(".track").forEach((r) => r.classList.toggle("current", r.dataset.vid === vid));
}

function refreshHearts() {
  $$(".track").forEach((r) => {
    const liked = isLiked(r.dataset.vid);
    const b = $(".heart", r);
    if (!b) return;
    b.classList.toggle("liked", liked);
    $("use", b).setAttribute("href", liked ? "#i-heart-f" : "#i-heart");
  });
  const cur = current();
  const barLike = $("#barLike");
  const liked = cur && isLiked(cur.videoId);
  barLike.classList.toggle("liked", !!liked);
  $("use", barLike).setAttribute("href", liked ? "#i-heart-f" : "#i-heart");
  updateLikedCount();
}

function updateLikedCount() {
  const ids = new Set([...state.lib.liked.map((t) => t.videoId), ...account.liked]);
  $("#likedCount").textContent = ids.size || "";
}

/* Track pages (liked, recent, playlists) ------------------------------- */
function viewTrackPage({ kind, title, tracks, mosaic, playlist, source }) {
  const el = h(`<div></div>`);
  const total = tracks.reduce((s, t) => s + (t.seconds || 0), 0);
  const mins = Math.round(total / 60);
  const art = mosaicEl(mosaic || tracks);
  const firstThumb = tracks.find((t) => t.thumb)?.thumb || "";
  const hero = h(`<section class="hero" style="--img:url('${esc(firstThumb)}')"><div class="hero-art"></div><div>
    <div class="kind">${kind}</div><h1>${esc(title)}</h1>
    <div class="sub"><b>${tracks.length}</b> ${tracks.length === 1 ? "song" : "songs"}${mins ? `, about ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}` : ""}</div></div></section>`);
  hero.firstElementChild.replaceWith(art);
  el.append(hero);

  const actions = h(`<div class="actions"></div>`);
  const playBtn = h(`<button class="fab" title="Play"><svg><use href="#i-play"/></svg></button>`);
  playBtn.onclick = () => tracks.length && playList(tracks, 0, source);
  const shuf = h(`<button class="icon-btn" title="Shuffle play"><svg><use href="#i-shuffle"/></svg></button>`);
  shuf.onclick = () => { if (!tracks.length) return; state.settings.shuffle = true; updateModeButtons(); playList(tracks, Math.floor(Math.random() * tracks.length), source); };
  actions.append(playBtn, shuf);
  if (playlist) {
    const ren = h(`<button class="icon-btn" title="Rename"><svg><use href="#i-edit"/></svg></button>`);
    ren.onclick = () => renamePlaylist(playlist);
    const del = h(`<button class="icon-btn" title="Delete playlist"><svg><use href="#i-trash"/></svg></button>`);
    del.onclick = () => deletePlaylist(playlist);
    actions.append(ren, del);
  }
  el.append(actions);

  if (!tracks.length) {
    const msg = playlist
      ? ["This playlist is empty", "Right-click any song and choose Add to playlist, or drag songs onto it in the sidebar."]
      : mosaic === "liked" ? ["No liked songs yet", "Tap the heart next to any song and it will show up here."] : ["Nothing played yet", "Songs you play will be listed here."];
    el.append(emptyState(msg[0], msg[1], { label: "Search for music", action: () => $("#q").focus() }));
    return el;
  }
  el.append(trackList(tracks, { header: true, source, playlistId: playlist?.id }));
  return el;
}

/* Album ---------------------------------------------------------------- */
async function viewAlbum(route, done, token) {
  done(heroSkeleton());
  let a;
  try { a = await api.get(`/api/album?id=${encodeURIComponent(route.id)}`); }
  catch (e) { return done(emptyState("This album couldn't be loaded", e.message, { label: "Try again", action: () => navigate(route, { replace: true }) })); }
  if (token !== renderToken) return;
  const el = h(`<div></div>`);
  const artist = a.artistId ? `<b class="lnk" data-artist="${esc(a.artistId)}">${esc(a.artists)}</b>` : `<b>${esc(a.artists)}</b>`;
  const hero = h(`<section class="hero" style="--img:url('${esc(a.thumb)}')"><img class="art" src="${esc(a.thumb)}" alt=""><div>
    <div class="kind">${esc(a.type || "Album")}</div><h1>${esc(a.title)}</h1>
    <div class="sub">${artist}${a.year ? `, ${esc(a.year)}` : ""}${a.tracks.length ? `, ${a.tracks.length} songs` : ""}${a.duration ? `, ${esc(a.duration)}` : ""}</div></div></section>`);
  $(".lnk", hero)?.addEventListener("click", () => navigate({ name: "artist", id: a.artistId }));
  el.append(hero);
  const source = { label: a.title, route };
  const actions = h(`<div class="actions"></div>`);
  const playBtn = h(`<button class="fab" title="Play"><svg><use href="#i-play"/></svg></button>`);
  playBtn.onclick = () => playList(a.tracks, 0, source);
  const shuf = h(`<button class="icon-btn" title="Shuffle play"><svg><use href="#i-shuffle"/></svg></button>`);
  shuf.onclick = () => { state.settings.shuffle = true; updateModeButtons(); playList(a.tracks, Math.floor(Math.random() * a.tracks.length), source); };
  const save = h(`<button class="icon-btn" title="Save as playlist"><svg><use href="#i-plus"/></svg></button>`);
  save.onclick = () => createPlaylist(a.tracks, a.title);
  actions.append(playBtn, shuf, save);
  el.append(actions);
  el.append(trackList(a.tracks, { header: true, source }));
  done(el);
}

/* Artist --------------------------------------------------------------- */
async function viewArtist(route, done, token) {
  done(heroSkeleton(true));
  let a;
  try { a = await api.get(`/api/artist?id=${encodeURIComponent(route.id)}`); }
  catch (e) { return done(emptyState("This artist couldn't be loaded", e.message, { label: "Try again", action: () => navigate(route, { replace: true }) })); }
  if (token !== renderToken) return;
  const el = h(`<div></div>`);
  el.append(h(`<section class="hero artist" style="--img:url('${esc(a.thumb)}')"><img class="art" src="${esc(a.thumb)}" alt=""><div>
    <div class="kind">Artist</div><h1>${esc(a.name)}</h1>${a.subscribers ? `<div class="sub">${esc(a.subscribers)} subscribers</div>` : ""}</div></section>`));
  const source = { label: a.name, route };
  const actions = h(`<div class="actions"></div>`);
  const playBtn = h(`<button class="fab" title="Play popular songs"><svg><use href="#i-play"/></svg></button>`);
  playBtn.onclick = () => a.songs.length && playList(a.songs, 0, source);
  const radio = h(`<button class="icon-btn" title="Start radio"><svg><use href="#i-radio"/></svg></button>`);
  radio.onclick = () => a.songs.length && startRadio(a.songs[0]);
  actions.append(playBtn, radio);
  el.append(actions);
  if (a.songs.length) {
    const sec = h(`<section class="section"><div class="section-head"><h2>Popular</h2></div></section>`);
    sec.append(trackList(a.songs.slice(0, 10), { source, all: a.songs }));
    el.append(sec);
  }
  if (a.albums.length) el.append(cardSection("Albums", a.albums, "album", false));
  if (a.singles.length) el.append(cardSection("Singles and EPs", a.singles, "album", false));
  if (!a.songs.length && !a.albums.length) el.append(emptyState("No music listed", "YouTube Music doesn't list any songs for this artist yet."));
  done(el);
}

function heroSkeleton(round) {
  return h(`<div><section class="hero"><div class="skel" style="width:${round ? 180 : 216}px;height:${round ? 180 : 216}px;border-radius:${round ? "50%" : "16px"}"></div><div style="flex:1"><div class="skel" style="width:60px;height:12px"></div><div class="skel" style="width:46%;height:52px;margin:12px 0"></div><div class="skel" style="width:30%;height:12px"></div></div></section>${skeletonList(6).outerHTML}</div>`);
}

/* ------------------------------------------------------------- Library --- */
async function toggleLike(track) {
  if (!track) return;
  const like = !isLiked(track.videoId);
  try {
    // Klang's own list (works offline and without an account)
    if (isLikedHere(track.videoId) !== like) {
      const r = await api.send("POST", "/api/like", { track });
      if (r.liked) state.lib.liked.unshift(track);
      else state.lib.liked = state.lib.liked.filter((t) => t.videoId !== track.videoId);
    }
    // Your YouTube likes, when signed in
    await setYtLike(track, like);
    refreshHearts();
    toast(like ? "Added to liked songs" : "Removed from liked songs");
    if (state.route.name === "liked") navigate(state.route, { replace: true });
  } catch (e) { refreshHearts(); toast(e.message, true); }
}

async function createPlaylist(tracks = [], name = "") {
  const n = await ask("New playlist", { value: name || `My playlist ${state.lib.playlists.length + 1}`, ok: "Create" });
  if (!n) return;
  try {
    const pl = await api.send("POST", "/api/playlists", { name: n, tracks });
    state.lib.playlists.push(pl);
    renderSidebar();
    toast(tracks.length ? `Created “${pl.name}” with ${tracks.length} ${tracks.length === 1 ? "song" : "songs"}` : `Created “${pl.name}”`);
    if (!tracks.length || tracks.length > 1) navigate({ name: "playlist", id: pl.id });
  } catch (e) { toast(e.message, true); }
}

async function addToPlaylist(id, tracks) {
  const pl = state.lib.playlists.find((p) => p.id === id);
  try {
    const r = await api.send("POST", `/api/playlists/${id}/tracks`, { tracks });
    const have = new Set(pl.tracks.map((t) => t.videoId));
    tracks.forEach((t) => { if (!have.has(t.videoId)) pl.tracks.push(t); });
    renderSidebar();
    toast(r.added ? `Added to “${pl.name}”` : `Already in “${pl.name}”`);
    if (state.route.name === "playlist" && state.route.id === id) navigate(state.route, { replace: true });
  } catch (e) { toast(e.message, true); }
}

async function removeFromPlaylist(id, track) {
  const pl = state.lib.playlists.find((p) => p.id === id);
  try {
    await api.send("DELETE", `/api/playlists/${id}/tracks/${encodeURIComponent(track.videoId)}`);
    pl.tracks = pl.tracks.filter((t) => t.videoId !== track.videoId);
    renderSidebar();
    navigate(state.route, { replace: true });
    toast(`Removed from “${pl.name}”`);
  } catch (e) { toast(e.message, true); }
}

async function renamePlaylist(pl) {
  const n = await ask("Rename playlist", { value: pl.name });
  if (!n || n === pl.name) return;
  try {
    await api.send("PATCH", `/api/playlists/${pl.id}`, { name: n });
    pl.name = n;
    renderSidebar();
    navigate(state.route, { replace: true });
    toast("Playlist renamed");
  } catch (e) { toast(e.message, true); }
}

async function deletePlaylist(pl) {
  const ok = await ask(`Delete “${pl.name}”? This can't be undone.`, { input: false, ok: "Delete" });
  if (!ok) return;
  try {
    await api.send("DELETE", `/api/playlists/${pl.id}`);
    state.lib.playlists = state.lib.playlists.filter((p) => p.id !== pl.id);
    renderSidebar();
    navigate({ name: "home" });
    toast("Playlist deleted");
  } catch (e) { toast(e.message, true); }
}

let dragData = null;
function renderSidebar() {
  const nav = $("#navPlaylists");
  nav.replaceChildren();
  if (!state.lib.playlists.length) {
    nav.append(h(`<div class="nav-empty">Create a playlist with the + button, then drag songs onto it.</div>`));
  }
  const ctxId = state.context?.route?.name === "playlist" ? state.context.route.id : null;
  for (const p of state.lib.playlists) {
    const b = h(`<button class="nav-pl" data-id="${p.id}"><div class="nav-pl-art"></div><div style="min-width:0"><div class="t">${esc(p.name)}</div><div class="n">${p.tracks.length} ${p.tracks.length === 1 ? "song" : "songs"}</div></div>${ctxId === p.id && state.playing ? `<span class="playing-dot"></span>` : ""}</button>`);
    b.firstElementChild.replaceWith(mosaicEl(p.tracks));
    b.onclick = () => navigate({ name: "playlist", id: p.id });
    b.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: "Play", icon: "play", action: () => p.tracks.length && playList(p.tracks, 0, { label: p.name, route: { name: "playlist", id: p.id } }) },
        { label: "Rename", icon: "edit", action: () => renamePlaylist(p) },
        "sep",
        { label: "Delete", icon: "trash", danger: true, action: () => deletePlaylist(p) },
      ], b);
    };
    b.addEventListener("dragover", (e) => { if (dragData) { e.preventDefault(); b.classList.add("drop"); } });
    b.addEventListener("dragleave", () => b.classList.remove("drop"));
    b.addEventListener("drop", (e) => { e.preventDefault(); b.classList.remove("drop"); if (dragData) addToPlaylist(p.id, dragData.tracks); });
    nav.append(b);
  }
  updateLikedCount();
  if (state.route) updateNav();
}

/* ============================================================== Player === */
/* Two interchangeable engines: the real YouTube IFrame player, and a
   silent stand-in used in demo mode (no internet needed). */

class YouTubeEngine {
  constructor(handlers) {
    this.h = handlers;
    this.player = null;
    this.ready = false;
    this.pending = null;
  }
  ensure() {
    if (this.player) return;
    if (!window.YT?.Player) {
      if (!this._waiting) {
        this._waiting = true;
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { prev?.(); this._waiting = false; this.ensure(); };
        setTimeout(() => { if (!window.YT?.Player) this.h.onError("api"); }, 8000);
      }
      return;
    }
    this.player = new YT.Player("yt", {
      width: "100%", height: "100%",
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0, origin: location.origin },
      events: {
        onReady: () => {
          this.ready = true;
          this.setVolume(state.settings.volume);
          this.setMuted(state.settings.muted);
          if (this.pending) { const p = this.pending; this.pending = null; this.load(p.id, p.autoplay, p.start); }
        },
        onStateChange: (e) => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) this.h.onState("playing");
          else if (e.data === S.PAUSED) this.h.onState("paused");
          else if (e.data === S.ENDED) this.h.onState("ended");
          else if (e.data === S.BUFFERING) this.h.onState("buffering");
        },
        onError: (e) => this.h.onError(e.data),
      },
    });
  }
  load(id, autoplay = true, start = 0) {
    this.ensure();
    if (!this.ready) { this.pending = { id, autoplay, start }; return; }
    if (autoplay) this.player.loadVideoById({ videoId: id, startSeconds: start });
    else this.player.cueVideoById({ videoId: id, startSeconds: start });
  }
  play() { this.ready && this.player.playVideo(); }
  pause() { this.ready && this.player.pauseVideo(); }
  seek(s) { this.ready && this.player.seekTo(s, true); }
  time() { return this.ready ? this.player.getCurrentTime() || 0 : 0; }
  duration() { return this.ready ? this.player.getDuration() || 0 : 0; }
  buffered() { return this.ready ? this.player.getVideoLoadedFraction() || 0 : 0; }
  setVolume(v) { this.ready && this.player.setVolume(v); }
  setMuted(m) { if (!this.ready) return; m ? this.player.mute() : this.player.unMute(); }
}

class DemoEngine {
  constructor(handlers) { this.h = handlers; this.t = 0; this.d = 0; this.on = false; this.timer = null; }
  load(id, autoplay = true, start = 0) {
    const tr = current();
    this.t = start; this.d = tr?.seconds || 200;
    const box = $(".video-wrap .video");
    $(".fake-video", box)?.remove();
    box.append(h(`<div class="fake-video" style="--img:url('${esc(tr?.thumb || "")}')"></div>`));
    this.h.onState("buffering");
    setTimeout(() => (autoplay ? this.play() : this.h.onState("paused")), 350);
  }
  play() {
    if (!this.d) return;
    this.on = true; this.h.onState("playing");
    clearInterval(this.timer);
    this.timer = setInterval(() => { this.t += 0.25; if (this.t >= this.d) { this.t = this.d; this.pause(); this.h.onState("ended"); } }, 250);
  }
  pause() { this.on = false; clearInterval(this.timer); this.h.onState("paused"); }
  seek(s) { this.t = s; }
  time() { return this.t; }
  duration() { return this.d; }
  buffered() { return this.d ? Math.min(1, (this.t + 40) / this.d) : 0; }
  setVolume() {}
  setMuted() {}
}

let engine = null;
let tried = new Set();   // videoIds tried for the current track (fallbacks)

const engineHandlers = {
  onState(s) {
    const btn = $("#btnPlay");
    btn.classList.toggle("busy", s === "buffering");
    if (s === "playing") setPlaying(true);
    if (s === "paused") setPlaying(false);
    if (s === "ended") onEnded();
  },
  async onError(code) {
    const t = current();
    if (code === "api") return toast("The YouTube player couldn't load. Check your internet connection.", true);
    if (!t) return;
    // 101/150: the uploader doesn't allow playback outside YouTube. Try an alternative upload.
    if ((code === 101 || code === 150 || code === 100) && tried.size < 4) {
      try {
        const alts = await api.get(`/api/alternatives?title=${encodeURIComponent(t.title)}&artists=${encodeURIComponent(t.artists)}`);
        const alt = alts.find((a) => !tried.has(a.videoId) && Math.abs((a.seconds || 0) - (t.seconds || 0)) < 25);
        if (alt) { tried.add(alt.videoId); engine.load(alt.videoId, true); return; }
      } catch { /* fall through to skip */ }
    }
    toast(`“${t.title}” can't be played here, skipping it.`, true);
    setTimeout(() => next(true), 600);
  },
};

function setPlaying(on) {
  if (state.playing === on) return;
  state.playing = on;
  document.body.classList.toggle("playing", on);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
  renderSidebar();
}

function playList(list, i, source) {
  if (!list?.length) return;
  const items = list.map((t) => ({ ...t }));
  let order = items;
  if (state.settings.shuffle) {
    const first = items[i];
    const rest = items.filter((_, k) => k !== i);
    shuffleArray(rest);
    order = [first, ...rest];
    i = 0;
  }
  state.queue = order;
  state.context = source || null;
  playIndex(i);
}

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function playIndex(i, { autoplay = true, start = 0 } = {}) {
  const t = state.queue[i];
  if (!t) return;
  state.index = i;
  tried = new Set([t.videoId]);
  engine.load(t.videoId, autoplay, start);
  updateNowPlaying(true);
  renderQueue();
  persist();
  if (autoplay) api.send("POST", "/api/recent", { track: t }).then(() => {
    state.lib.recent = [t, ...(state.lib.recent || []).filter((x) => x.videoId !== t.videoId)].slice(0, 50);
  }).catch(() => {});
}

function togglePlay() {
  if (!current()) {
    const list = $(".tracks")?._tracks;
    if (list?.length) playList(list, 0, null);
    return;
  }
  if (!engine.ready && engine instanceof YouTubeEngine && !engine.player) return playIndex(state.index);
  state.playing ? engine.pause() : engine.play();
}

async function next(auto = false) {
  if (state.settings.repeat === "one" && auto === "ended") { engine.seek(0); engine.play(); return; }
  if (state.index < state.queue.length - 1) return playIndex(state.index + 1);
  if (state.settings.repeat === "all" && state.queue.length) return playIndex(0);
  if (state.settings.autoRadio && current()) {
    try {
      const more = await api.get(`/api/radio?id=${encodeURIComponent(current().videoId)}`);
      const have = new Set(state.queue.map((t) => t.videoId));
      const fresh = more.filter((t) => !have.has(t.videoId));
      if (fresh.length) {
        state.queue.push(...fresh);
        toast("Keeping it going with similar songs");
        return playIndex(state.index + 1);
      }
    } catch { /* nothing more to play */ }
  }
  if (auto) setPlaying(false);
}

function prev() {
  if (engine.time() > 3 || state.index <= 0) { engine.seek(0); return; }
  playIndex(state.index - 1);
}

function onEnded() { next("ended"); }

function playNext(tracks) {
  if (!current()) return playList(tracks, 0, null);
  state.queue.splice(state.index + 1, 0, ...tracks.map((t) => ({ ...t })));
  renderQueue(); persist();
  toast(tracks.length === 1 ? `“${tracks[0].title}” plays next` : `${tracks.length} songs play next`);
}

function addToQueue(tracks) {
  if (!current()) return playList(tracks, 0, null);
  state.queue.push(...tracks.map((t) => ({ ...t })));
  renderQueue(); persist();
  toast(tracks.length === 1 ? `Added “${tracks[0].title}” to the queue` : `Added ${tracks.length} songs to the queue`);
}

function removeFromQueue(i) {
  if (i === state.index) return;
  const li = $(`.queue li[data-i="${i}"]`);
  const finish = () => {
    state.queue.splice(i, 1);
    if (i < state.index) state.index--;
    renderQueue(); persist();
  };
  if (li && !calm()) { li.classList.add("leave"); setTimeout(finish, 280); } else finish();
}

async function startRadio(track) {
  try {
    const more = await api.get(`/api/radio?id=${encodeURIComponent(track.videoId)}`);
    playList([track, ...more], 0, { label: `Radio: ${track.title}`, route: null });
    toast(`Radio started from “${track.title}”`);
  } catch (e) { toast(e.message, true); }
}

/* Now playing ---------------------------------------------------------- */
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap");
}

function updateNowPlaying(animate) {
  const t = current();
  document.body.classList.toggle("has-track", !!t);
  if (!t) return;
  const cover = $("#barCover");
  if (cover.getAttribute("src") !== t.thumb) {
    cover.src = t.thumb;
    if (animate) { cover.classList.remove("swap"); void cover.offsetWidth; cover.classList.add("swap"); }
  }
  swapText($("#barTitle"), t.title);
  swapText($("#barArtist"), t.artists);
  swapText($("#npTitle"), t.title);
  swapText($("#npArtist"), [t.artists, t.album].filter(Boolean).join(", "));
  $("#videoGlow").style.setProperty("--img", `url('${t.thumb}')`);
  document.title = `${t.title} – ${t.artists}`;
  $("#tDur").textContent = t.duration || "0:00";
  refreshHearts();
  markCurrentRows();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artists, album: t.album || "", artwork: t.thumb ? [{ src: t.thumb, sizes: "544x544" }] : [] });
  }
}

function renderQueue() {
  const ol = $("#queue");
  ol.replaceChildren();
  const up = state.queue.slice(state.index + 1);
  if (state.context?.label && current()) ol.append(h(`<li class="q-sep">Playing from ${esc(state.context.label)}</li>`));
  if (!up.length) {
    ol.append(h(`<li class="q-empty">${current() ? (state.settings.autoRadio ? "When this song ends, similar songs will keep playing." : "That's the last song in the queue.") : "Songs you play or queue up will appear here."}</li>`));
    return;
  }
  up.slice(0, 100).forEach((t, k) => {
    const i = state.index + 1 + k;
    const li = h(`<li data-i="${i}" draggable="true"><img src="${esc(t.thumb)}" alt="" loading="lazy"><div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artists)}</div></div><button class="icon-btn sm" title="Remove from queue"><svg><use href="#i-close"/></svg></button></li>`);
    li.onclick = (e) => { if (e.target.closest("button")) return removeFromQueue(i); playIndex(i); };
    li.oncontextmenu = (e) => { e.preventDefault(); trackMenu(t, e.clientX, e.clientY, li, { queueIndex: i }); };
    li.addEventListener("dragstart", () => { qDrag = i; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => { qDrag = null; $$(".queue li").forEach((x) => x.classList.remove("dragging", "drop-above")); });
    li.addEventListener("dragover", (e) => { if (qDrag == null) return; e.preventDefault(); $$(".queue .drop-above").forEach((x) => x.classList.remove("drop-above")); li.classList.add("drop-above"); });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (qDrag == null || qDrag === i) return;
      const [moved] = state.queue.splice(qDrag, 1);
      state.queue.splice(qDrag < i ? i - 1 : i, 0, moved);
      renderQueue(); persist();
    });
    ol.append(li);
  });
}
let qDrag = null;

/* Progress + sliders --------------------------------------------------- */
function makeSlider(el, { onInput, onCommit, hoverLabel }) {
  const frac = (e) => { const r = $(".track", el).getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add("drag");
    onInput(frac(e));
    const move = (ev) => onInput(frac(ev));
    const up = (ev) => { el.classList.remove("drag"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); onCommit?.(frac(ev)); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  if (hoverLabel) {
    const tip = $(".hover-time", el);
    el.addEventListener("pointermove", (e) => { const f = frac(e); tip.style.left = f * 100 + "%"; tip.textContent = hoverLabel(f); });
  }
}

function setSeekVisual(f) {
  $("#seekFill").style.width = f * 100 + "%";
  $("#seekKnob").style.left = f * 100 + "%";
}

function setVolVisual() {
  const v = state.settings.muted ? 0 : state.settings.volume;
  $("#volFill").style.width = v + "%";
  $("#volKnob").style.left = v + "%";
  $("use", $("#btnMute")).setAttribute("href", v === 0 ? "#i-mute" : "#i-vol");
}

function tick() {
  if ($("#seek").classList.contains("drag")) return;
  const d = engine.duration() || current()?.seconds || 0;
  const t = engine.time();
  if (!d) return;
  setSeekVisual(t / d);
  $("#seekBuf").style.width = engine.buffered() * 100 + "%";
  $("#tCur").textContent = fmtTime(t);
  $("#tDur").textContent = fmtTime(d);
  if (state.playing && Math.floor(t) % 5 === 0) { state.resumeAt = t; persistPosition(t); }
}

function persistPosition(t) {
  try { localStorage.setItem(STORE_KEY + ":pos", String(Math.floor(t))); } catch { /* ignore */ }
}

function updateModeButtons() {
  $("#btnShuffle").classList.toggle("on", state.settings.shuffle);
  const rep = $("#btnRepeat");
  rep.classList.toggle("on", state.settings.repeat !== "off");
  rep.classList.toggle("one-mode", state.settings.repeat === "one");
  rep.title = { off: "Repeat", all: "Repeat all (click for repeat one)", one: "Repeat one (click to turn off)" }[state.settings.repeat];
  persist();
}

function setPanel(on) {
  state.settings.panel = on;
  document.body.classList.toggle("panel-off", !on);
  document.body.classList.toggle("panel-on", on);
  $("#btnPanel").classList.toggle("on", on);
  persist();
  setTimeout(moveInk, 520);
}

/* ------------------------------------------------------------- Search UI --- */
let searchTimer = null, suggestTimer = null, suggestSel = -1;

function syncSearchbox() { $("#searchbox").classList.toggle("has-text", !!$("#q").value); }

function doSearch(q, { immediate = false } = {}) {
  clearTimeout(searchTimer);
  const go = () => {
    state.searchTab = state.route?.name === "search" ? state.searchTab : "all";
    navigate({ name: "search", q }, { replace: state.route?.name === "search" });
  };
  immediate ? go() : (searchTimer = setTimeout(go, 320));
}

async function loadSuggestions(q) {
  const box = $("#suggest");
  if (!q || q.length < 2) { box.classList.remove("open"); return; }
  const list = await api.get(`/api/suggest?q=${encodeURIComponent(q)}`).catch(() => []);
  if ($("#q").value.trim() !== q || document.activeElement !== $("#q")) return;
  box.replaceChildren();
  suggestSel = -1;
  list.filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 6).forEach((s) => {
    const lower = s.toLowerCase(), qi = lower.indexOf(q.toLowerCase());
    const label = qi === 0 ? `${esc(s.slice(0, q.length))}<b>${esc(s.slice(q.length))}</b>` : `<b>${esc(s)}</b>`;
    const b = h(`<button role="option"><svg><use href="#i-search"/></svg><span>${label}</span></button>`);
    b.onmousedown = (e) => { e.preventDefault(); pickSuggestion(s); };
    box.append(b);
  });
  box.classList.toggle("open", box.children.length > 0);
}

function pickSuggestion(s) {
  $("#q").value = s;
  syncSearchbox();
  $("#suggest").classList.remove("open");
  doSearch(s, { immediate: true });
}

/* ------------------------------------------------------------------ Init --- */
function initUI() {
  engine = state.mock ? new DemoEngine(engineHandlers) : new YouTubeEngine(engineHandlers);
  if (!state.mock) engine.ensure();

  renderSidebar();
  refreshHearts();
  updateModeButtons();
  setVolVisual();
  setPanel(state.settings.panel && innerWidth > 980);
  $("#autoRadio").checked = state.settings.autoRadio;

  // Navigation
  $$(".nav-item").forEach((b) => b.onclick = () => {
    if (b.dataset.nav === "search") { $("#q").focus(); if ($("#q").value) doSearch($("#q").value.trim(), { immediate: true }); else navigate({ name: "search", q: "" }); return; }
    navigate({ name: b.dataset.nav });
  });
  $("#newPlaylist").onclick = () => createPlaylist([]);
  $("#btnSettings").onclick = (e) => openSettings(e.currentTarget);
  $("#histBack").onclick = () => goHistory(-1);
  $("#histFwd").onclick = () => goHistory(1);

  // Search box
  const q = $("#q");
  q.addEventListener("input", () => {
    syncSearchbox();
    const v = q.value.trim();
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => loadSuggestions(v), 140);
    if (v.length >= 2) doSearch(v);
  });
  q.addEventListener("keydown", (e) => {
    const items = $$("#suggest button");
    const open = $("#suggest").classList.contains("open");
    if (e.key === "ArrowDown" && open) { e.preventDefault(); suggestSel = Math.min(items.length - 1, suggestSel + 1); }
    else if (e.key === "ArrowUp" && open) { e.preventDefault(); suggestSel = Math.max(-1, suggestSel - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && suggestSel >= 0) return pickSuggestion(items[suggestSel].textContent);
      $("#suggest").classList.remove("open");
      if (q.value.trim()) doSearch(q.value.trim(), { immediate: true });
      return;
    } else if (e.key === "Escape") { $("#suggest").classList.remove("open"); q.blur(); return; }
    else return;
    items.forEach((b, k) => b.classList.toggle("sel", k === suggestSel));
  });
  q.addEventListener("focus", () => { if (q.value.trim().length >= 2) loadSuggestions(q.value.trim()); });
  q.addEventListener("blur", () => setTimeout(() => $("#suggest").classList.remove("open"), 120));
  $("#qClear").onclick = () => { q.value = ""; syncSearchbox(); q.focus(); navigate({ name: "search", q: "" }, { replace: state.route?.name === "search" }); };

  // Player controls
  $("#btnPlay").onclick = togglePlay;
  $("#btnNext").onclick = () => next();
  $("#btnPrev").onclick = prev;
  $("#btnShuffle").onclick = () => {
    state.settings.shuffle = !state.settings.shuffle;
    if (state.settings.shuffle && current()) {
      const rest = shuffleArray(state.queue.slice(state.index + 1));
      state.queue = [...state.queue.slice(0, state.index + 1), ...rest];
      renderQueue();
    }
    updateModeButtons();
    toast(state.settings.shuffle ? "Shuffle on" : "Shuffle off");
  };
  $("#btnRepeat").onclick = () => {
    state.settings.repeat = { off: "all", all: "one", one: "off" }[state.settings.repeat];
    updateModeButtons();
  };
  $("#btnPanel").onclick = () => setPanel(!state.settings.panel);
  $("#btnQueue").onclick = () => { setPanel(true); $("#queue").scrollTo({ top: 0, behavior: "smooth" }); $("#queue").animate([{ opacity: .4 }, { opacity: 1 }], { duration: 500 }); };
  $("#barLike").onclick = () => toggleLike(current());
  $("#coverRing").onclick = () => { const t = current(); if (t?.albumId) navigate({ name: "album", id: t.albumId }); };
  $("#barArtist").onclick = () => { const t = current(); if (t?.artistId) navigate({ name: "artist", id: t.artistId }); };
  $("#barArtist").classList.add("lnk");
  $("#btnMute").onclick = () => { state.settings.muted = !state.settings.muted; engine.setMuted(state.settings.muted); setVolVisual(); persist(); };
  $("#autoRadio").onchange = (e) => { state.settings.autoRadio = e.target.checked; persist(); renderQueue(); };

  makeSlider($("#seek"), {
    onInput: (f) => { setSeekVisual(f); $("#tCur").textContent = fmtTime(f * (engine.duration() || current()?.seconds || 0)); },
    onCommit: (f) => engine.seek(f * (engine.duration() || current()?.seconds || 0)),
    hoverLabel: (f) => fmtTime(f * (engine.duration() || current()?.seconds || 0)),
  });
  makeSlider($("#vol"), {
    onInput: (f) => {
      state.settings.volume = Math.round(f * 100);
      state.settings.muted = state.settings.volume === 0;
      engine.setVolume(state.settings.volume);
      engine.setMuted(state.settings.muted);
      setVolVisual();
    },
    onCommit: persist,
  });
  $("#vol").addEventListener("wheel", (e) => {
    e.preventDefault();
    state.settings.volume = Math.max(0, Math.min(100, state.settings.volume + (e.deltaY < 0 ? 5 : -5)));
    state.settings.muted = false;
    engine.setVolume(state.settings.volume); engine.setMuted(false); setVolVisual(); persist();
  }, { passive: false });

  setInterval(tick, 250);

  // Windows media keys / overlay
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => engine.play());
    ms.setActionHandler("pause", () => engine.pause());
    ms.setActionHandler("nexttrack", () => next());
    ms.setActionHandler("previoustrack", prev);
  }

  // Close menus
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#menu")) closeMenu(); });
  $("#scroller").addEventListener("scroll", () => {
    closeMenu();
    $(".topbar").classList.toggle("scrolled", $("#scroller").scrollTop > 8);
  }, { passive: true });
  window.addEventListener("resize", () => { closeMenu(); moveInk(); });
  window.addEventListener("blur", closeMenu);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, textarea") || e.target.closest("dialog");
    if ((e.ctrlKey && e.key.toLowerCase() === "k") || (!typing && e.key === "/")) { e.preventDefault(); q.focus(); q.select(); return; }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); return goHistory(-1); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); return goHistory(1); }
    if (e.key === "Escape") closeMenu();
    if (typing) return;
    if (e.key === " " && !e.target.matches("button")) { e.preventDefault(); togglePlay(); }
    else if (e.ctrlKey && e.key === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.ctrlKey && e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    else if (e.key === "ArrowRight" && !e.target.closest(".track")) engine.seek(engine.time() + 5);
    else if (e.key === "ArrowLeft" && !e.target.closest(".track")) engine.seek(Math.max(0, engine.time() - 5));
    else if (e.key.toLowerCase() === "m") $("#btnMute").click();
    else if (e.key.toLowerCase() === "l" && current()) toggleLike(current());
    else if (e.key.toLowerCase() === "s") $("#btnShuffle").click();
  });
  document.addEventListener("mouseup", (e) => { if (e.button === 3) goHistory(-1); if (e.button === 4) goHistory(1); });
}

function restoreSession() {
  if (current()) {
    let pos = 0;
    try { pos = +localStorage.getItem(STORE_KEY + ":pos") || 0; } catch { /* ignore */ }
    playIndex(state.index, { autoplay: false, start: pos });
    const d = current().seconds || 0;
    if (d) { setSeekVisual(pos / d); $("#tCur").textContent = fmtTime(pos); }
  } else {
    renderQueue();
  }
}

boot();
