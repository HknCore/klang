/* ==========================================================================
   Klang – YouTube account
   Sign-in, your YouTube Music playlists and likes. Loaded before app.js and
   shares its globals ($, h, esc, api, state, navigate, toast, …).
   ========================================================================== */
"use strict";

const account = {
  info: { signedIn: false },
  playlists: [],
  liked: new Set(),        // videoIds liked on YouTube
  likedTracks: null,       // full list, loaded on demand
  polling: null,
};

const signedIn = () => !!account.info.signedIn;

async function loadAccount({ quiet = true } = {}) {
  try {
    account.info = await api.get("/api/account");
  } catch {
    account.info = { signedIn: false };
  }
  if (signedIn()) {
    await Promise.all([loadYtPlaylists(), loadYtLiked()]);
  } else {
    account.playlists = [];
    account.liked = new Set();
    account.likedTracks = null;
  }
  renderAccountUI();
  if (!quiet && account.info.problem) toast("Klang couldn't reach your YouTube account. Try signing in again.", true);
}

async function loadYtPlaylists() {
  try { account.playlists = await api.get("/api/yt/playlists"); }
  catch { account.playlists = []; }
}

async function loadYtLiked() {
  try {
    const res = await api.get("/api/yt/liked");
    account.likedTracks = res.tracks || [];
    account.liked = new Set(account.likedTracks.map((t) => t.videoId));
  } catch {
    account.likedTracks = null;
  }
}

function renderAccountUI() {
  renderYtSide();
  renderAvatar();
  refreshHearts();
  const r = state.route;
  if (r && (r.name === "home" || r.name === "liked")) navigate(r, { replace: true });
}

/* Sidebar --------------------------------------------------------------- */
function renderYtSide() {
  const box = $("#ytSide");
  if (!box) return;
  box.replaceChildren();
  if (!signedIn()) {
    const card = h(`<div class="yt-card">
      <div class="yt-card-t">Your YouTube Music library</div>
      <p>Sign in to see your playlists and likes here, and keep likes in sync.</p>
      <button class="btn primary sm">Sign in with YouTube</button>
    </div>`);
    $("button", card).onclick = startSignIn;
    box.append(card);
    return;
  }
  box.append(h(`<div class="nav-head"><span>YouTube Music</span></div>`));
  const list = h(`<div class="nav-playlists"></div>`);
  if (!account.playlists.length) list.append(h(`<div class="nav-empty">No playlists in your YouTube Music library yet.</div>`));
  for (const p of account.playlists) {
    const b = h(`<button class="nav-pl" data-yt="${esc(p.id)}"><div class="mosaic single"><img src="${esc(p.thumb)}" alt="" loading="lazy"></div><div style="min-width:0"><div class="t">${esc(p.title)}</div><div class="n">${esc(p.count ? `${p.count} songs` : "Playlist")}</div></div></button>`);
    b.onclick = () => navigate({ name: "ytplaylist", id: p.id });
    b.addEventListener("dragover", (e) => { if (dragData) { e.preventDefault(); b.classList.add("drop"); } });
    b.addEventListener("dragleave", () => b.classList.remove("drop"));
    b.addEventListener("drop", (e) => { e.preventDefault(); b.classList.remove("drop"); if (dragData) addToYtPlaylist(p, dragData.tracks); });
    list.append(b);
  }
  box.append(list);
  if (state.route) $$(".nav-pl[data-yt]").forEach((x) => x.classList.toggle("active", state.route.name === "ytplaylist" && x.dataset.yt === state.route.id));
}

function renderAvatar() {
  const end = $(".topbar-end");
  $(".avatar", end)?.remove();
  if (!signedIn()) return;
  const name = account.info.name || "Your account";
  const img = account.info.photo
    ? `<img src="${esc(account.info.photo)}" alt="">`
    : `<span>${esc(name.slice(0, 1).toUpperCase())}</span>`;
  const b = h(`<button class="avatar" title="${esc(name)}">${img}</button>`);
  b.onclick = (e) => openSettings(e.currentTarget);
  end.prepend(b);
}

/* Settings menu --------------------------------------------------------- */
function openSettings(anchor) {
  const r = anchor.getBoundingClientRect();
  const items = [];
  if (signedIn()) {
    items.push(
      { label: account.info.name ? `Signed in as ${account.info.name}` : "Signed in to YouTube", heading: true },
      { label: "Sign out of YouTube", icon: "user", action: signOut },
      "sep",
    );
  } else {
    items.push({ label: "Sign in with YouTube", icon: "user", action: startSignIn }, "sep");
  }
  items.push(
    { label: "Settings", heading: true },
    { label: calm() ? "Turn animations on" : "Turn animations off", icon: "sparkle", action: () => {
      state.settings.animations = calm();
      document.body.classList.toggle("calm", calm());
      persist();
      toast(calm() ? "Animations off" : "Animations on");
    } },
    { label: state.settings.autoRadio ? "Stop autoplay of similar songs" : "Autoplay similar songs", icon: "radio", action: () => {
      state.settings.autoRadio = !state.settings.autoRadio;
      $("#autoRadio").checked = state.settings.autoRadio;
      persist(); renderQueue();
      toast(state.settings.autoRadio ? "Autoplay on" : "Autoplay off");
    } },
  );
  openMenu(r.right - 250, r.bottom + 8, items, anchor);
}

/* Sign-in dialog ------------------------------------------------------- */
function acctDialog(html) {
  const dlg = $("#acct");
  $("#acctBody").replaceChildren(h(`<div>${html}</div>`));
  if (!dlg.open) dlg.showModal();
  return $("#acctBody");
}

function closeAcctDialog() {
  clearInterval(account.polling);
  account.polling = null;
  const dlg = $("#acct");
  if (dlg.open) dlg.close();
}

async function startSignIn() {
  closeMenu();
  let res;
  try { res = await api.send("POST", "/api/account/login"); }
  catch (e) { return toast(e.message, true); }
  if (res.mode === "paste") return showPasteSignIn();

  const body = acctDialog(`
    <div class="acct-ring"><svg class="ring" viewBox="-100 -100 200 200" data-bars="36" data-r="56" data-len="30"></svg></div>
    <h3>Sign in to YouTube</h3>
    <p>Google's sign-in page opened in a new window. Sign in there and Klang takes care of the rest.</p>
    <p class="acct-note" id="acctNote"></p>
    <div class="dlg-actions"><button class="btn ghost" data-act="paste">Use another way</button><button class="btn ghost" data-act="cancel">Cancel</button></div>`);
  const ring = buildRing($(".acct-ring svg", body));
  ring.spin = true;
  $("[data-act=paste]", body).onclick = showPasteSignIn;
  $("[data-act=cancel]", body).onclick = closeAcctDialog;

  clearInterval(account.polling);
  account.polling = setInterval(async () => {
    let info;
    try { info = await api.get("/api/account"); } catch { return; }
    if (info.signedIn) {
      closeAcctDialog();
      await loadAccount();
      toast(info.name ? `Signed in as ${info.name}` : "Signed in to YouTube");
    } else if (info.login === "closed" || info.login === "failed") {
      clearInterval(account.polling);
      showSignInStopped();
    } else if (info.loginError) {
      const note = $("#acctNote");
      if (note) note.textContent = "Still waiting for the sign-in to finish…";
    }
  }, 1500);
}

function showSignInStopped() {
  const body = acctDialog(`
    <h3>Sign-in didn't finish</h3>
    <p>The sign-in window was closed before Klang could connect. If Google said the browser or app may not be secure, use your regular browser instead. It takes about a minute.</p>
    <div class="dlg-actions"><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn ghost" data-act="retry">Try again</button><button class="btn primary" data-act="paste">Use my browser</button></div>`);
  $("[data-act=cancel]", body).onclick = closeAcctDialog;
  $("[data-act=retry]", body).onclick = startSignIn;
  $("[data-act=paste]", body).onclick = showPasteSignIn;
}

function showPasteSignIn() {
  clearInterval(account.polling);
  const body = acctDialog(`
    <h3>Sign in with your browser</h3>
    <ol class="acct-steps">
      <li>Open <b>music.youtube.com</b> in Chrome, Edge or Firefox and make sure you're signed in.</li>
      <li>Press <kbd>F12</kbd> and open the <b>Network</b> tab.</li>
      <li>Type <b>browse</b> into the filter box, then click Home in YouTube Music so a request shows up.</li>
      <li>Right-click the request and choose <b>Copy → Copy as fetch</b> (Chrome, Edge) or <b>Copy → Copy request headers</b> (Firefox).</li>
      <li>Paste it here.</li>
    </ol>
    <textarea id="acctPaste" spellcheck="false" placeholder="Paste here"></textarea>
    <p class="acct-error" id="acctError"></p>
    <p class="acct-note">This works like a password for your YouTube account. Klang keeps it only on this computer. Don't share it with anyone.</p>
    <div class="dlg-actions"><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn primary" data-act="go">Sign in</button></div>`);
  const ta = $("#acctPaste");
  ta.focus();
  $("[data-act=cancel]", body).onclick = closeAcctDialog;
  const go = $("[data-act=go]", body);
  go.onclick = async () => {
    if (!ta.value.trim()) { $("#acctError").textContent = "Paste the copied request first."; return; }
    go.disabled = true; go.textContent = "Signing in…";
    try {
      const info = await api.send("POST", "/api/account/paste", { text: ta.value });
      closeAcctDialog();
      await loadAccount();
      toast(info.name ? `Signed in as ${info.name}` : "Signed in to YouTube");
    } catch (e) {
      $("#acctError").textContent = e.message;
      go.disabled = false; go.textContent = "Sign in";
    }
  };
}

async function signOut() {
  const ok = await ask("Sign out of YouTube? Your Klang playlists and likes stay on this computer.", { input: false, ok: "Sign out" });
  if (!ok) return;
  try {
    await api.send("POST", "/api/account/logout");
    account.info = { signedIn: false };
    account.playlists = []; account.liked = new Set(); account.likedTracks = null;
    renderAccountUI();
    if (state.route?.name === "ytplaylist") navigate({ name: "home" });
    toast("Signed out of YouTube");
  } catch (e) { toast(e.message, true); }
}

/* Likes ------------------------------------------------------------------ */
async function setYtLike(track, like) {
  if (!signedIn()) return;
  await api.send("POST", "/api/yt/rate", { videoId: track.videoId, like });
  if (like) {
    account.liked.add(track.videoId);
    if (account.likedTracks && !account.likedTracks.some((t) => t.videoId === track.videoId)) account.likedTracks.unshift(track);
  } else {
    account.liked.delete(track.videoId);
    if (account.likedTracks) account.likedTracks = account.likedTracks.filter((t) => t.videoId !== track.videoId);
  }
}

async function pushLocalLikes(tracks) {
  try {
    const r = await api.send("POST", "/api/yt/rate-many", { videoIds: tracks.map((t) => t.videoId) });
    tracks.forEach((t) => account.liked.add(t.videoId));
    await loadYtLiked();
    toast(`Added ${r.liked} ${r.liked === 1 ? "song" : "songs"} to your YouTube likes`);
    navigate(state.route, { replace: true });
  } catch (e) { toast(e.message, true); }
}

/* Views ------------------------------------------------------------------ */
async function viewLiked(route, done, token) {
  if (!signedIn()) {
    return done(viewTrackPage({ kind: "Playlist", title: "Liked songs", tracks: state.lib.liked, mosaic: "liked", source: { label: "Liked songs", route } }));
  }
  if (!account.likedTracks) {
    done(heroSkeleton());
    await loadYtLiked();
    if (token !== renderToken) return;
  }
  const yt = account.likedTracks || [];
  const ytIds = new Set(yt.map((t) => t.videoId));
  const localOnly = state.lib.liked.filter((t) => !ytIds.has(t.videoId));
  const tracks = [...localOnly, ...yt];
  const el = viewTrackPage({ kind: "Playlist", title: "Liked songs", tracks, mosaic: "liked", source: { label: "Liked songs", route } });
  $(".hero .kind", el).textContent = "Synced with YouTube Music";
  if (localOnly.length) {
    const banner = h(`<div class="banner"><div><b>${localOnly.length} ${localOnly.length === 1 ? "song" : "songs"}</b> you liked in Klang ${localOnly.length === 1 ? "isn't" : "aren't"} in your YouTube likes yet.</div><button class="btn primary sm">Add to YouTube</button></div>`);
    $("button", banner).onclick = () => pushLocalLikes(localOnly);
    $(".actions", el).after(banner);
  }
  done(el);
}

async function viewYtPlaylist(route, done, token) {
  done(heroSkeleton());
  let pl;
  try { pl = await api.get(`/api/yt/playlist?id=${encodeURIComponent(route.id)}`); }
  catch (e) { return done(emptyState("This playlist couldn't be loaded", e.message, { label: "Try again", action: () => navigate(route, { replace: true }) })); }
  if (token !== renderToken) return;
  const el = h(`<div></div>`);
  const thumb = pl.thumb || pl.tracks[0]?.thumb || "";
  el.append(h(`<section class="hero" style="--img:url('${esc(thumb)}')"><img class="art" src="${esc(thumb)}" alt=""><div>
    <div class="kind">YouTube Music playlist</div><h1>${esc(pl.title)}</h1>
    <div class="sub">${pl.author ? `<b>${esc(pl.author)}</b>, ` : ""}${pl.tracks.length} ${pl.tracks.length === 1 ? "song" : "songs"}</div></div></section>`));
  const source = { label: pl.title, route };
  const actions = h(`<div class="actions"></div>`);
  const playBtn = h(`<button class="fab" title="Play"><svg><use href="#i-play"/></svg></button>`);
  playBtn.onclick = () => pl.tracks.length && playList(pl.tracks, 0, source);
  const shuf = h(`<button class="icon-btn" title="Shuffle play"><svg><use href="#i-shuffle"/></svg></button>`);
  shuf.onclick = () => { if (!pl.tracks.length) return; state.settings.shuffle = true; updateModeButtons(); playList(pl.tracks, Math.floor(Math.random() * pl.tracks.length), source); };
  const copy = h(`<button class="icon-btn" title="Save a copy in Klang"><svg><use href="#i-plus"/></svg></button>`);
  copy.onclick = () => createPlaylist(pl.tracks, pl.title);
  const open = h(`<button class="icon-btn" title="Open on YouTube Music"><svg><use href="#i-ext"/></svg></button>`);
  open.onclick = () => window.open(`https://music.youtube.com/playlist?list=${encodeURIComponent(pl.id)}`, "_blank");
  actions.append(playBtn, shuf, copy, open);
  el.append(actions);
  if (!pl.tracks.length) el.append(emptyState("This playlist is empty", "Add songs to it from any song's menu."));
  else el.append(trackList(pl.tracks, { header: true, source }));
  done(el);
}

function ytHomeSection() {
  if (!signedIn() || !account.playlists.length) return null;
  const sec = h(`<section class="section"><div class="section-head"><h2>From your YouTube Music</h2></div></section>`);
  const grid = h(`<div class="grid"></div>`);
  account.playlists.slice(0, 6).forEach((p, i) => grid.append(cardEl({
    title: p.title, sub: p.count ? `${p.count} songs` : "Playlist", thumb: p.thumb, i,
    onOpen: () => navigate({ name: "ytplaylist", id: p.id }),
    onPlay: async () => {
      const pl = await api.get(`/api/yt/playlist?id=${encodeURIComponent(p.id)}`).catch((e) => toast(e.message, true));
      if (pl?.tracks?.length) playList(pl.tracks, 0, { label: pl.title, route: { name: "ytplaylist", id: p.id } });
    },
  })));
  sec.append(grid);
  return sec;
}

async function addToYtPlaylist(p, tracks) {
  try {
    await api.send("POST", "/api/yt/playlist/add", { id: p.id, videoIds: tracks.map((t) => t.videoId) });
    toast(`Added to “${p.title}” on YouTube Music`);
    if (state.route?.name === "ytplaylist" && state.route.id === p.id) navigate(state.route, { replace: true });
  } catch (e) { toast(e.message, true); }
}
