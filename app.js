/*
 * Wiki Speedrun — open-source Wikipedia racing game, solo and multiplayer.
 * No build step. Talks to the public Wikipedia API; multiplayer goes through net.js.
 */
(() => {
  "use strict";

  // ======================================================================
  // Config
  // ======================================================================
  const LANGUAGES = [
    ["en", "English"], ["no", "Norsk (bokmål)"], ["nn", "Norsk (nynorsk)"], ["sv", "Svenska"],
    ["da", "Dansk"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["simple", "Simple English"],
  ];
  // Popular English articles for the daily challenge (same route for everyone each day).
  const DAILY_POOL = [
    "Pizza", "Moon", "Albert Einstein", "Norway", "Chess", "Volcano", "Napoleon", "Banana",
    "Jazz", "Ancient Egypt", "Penguin", "Coffee", "Mount Everest", "Leonardo da Vinci",
    "Internet", "Shark", "Roman Empire", "Association football", "Vikings", "Dinosaur", "Black hole",
    "Tea", "Olympic Games", "Electricity", "Japan", "William Shakespeare", "Western honey bee",
    "Titanic", "Bicycle", "Photosynthesis", "Taylor Swift", "Minecraft", "Tokyo",
    "The Beatles", "Antarctica", "Chocolate", "Isaac Newton", "Amazon rainforest",
    "Cheese", "Rocket", "Great Wall of China", "Mathematics", "Lion", "Oxygen",
    "World War I", "Piano", "Aurora", "Wolf", "Bitcoin", "Statue of Liberty",
    "Ice hockey", "Sun", "Egyptian pyramids", "Bread", "Eiffel Tower", "DNA", "Guitar",
    "Piracy", "Snow", "Elephant", "Paper", "Video game", "Lightning", "Potato",
  ];
  const HISTORY_KEY = "wikiSpeedrun.history.v1";
  const NAME_KEY = "wikiSpeedrun.name";
  const LANG_KEY = "wikiSpeedrun.lang";

  const PING_EVERY = 2500;      // presence heartbeat (ms)
  const PLAYER_TIMEOUT = 10000; // drop players not heard from (ms)
  const HOST_TIMEOUT = 9000;    // pick a new host if host is silent (ms)
  const COUNTDOWN = 3;          // seconds

  // ======================================================================
  // Helpers
  // ======================================================================
  const $ = (id) => document.getElementById(id);
  const show = (screenId) => {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === screenId));
    window.scrollTo(0, 0);
  };
  const norm = (t) => (t || "").replace(/_/g, " ").trim().toLowerCase();
  const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  function fmtTime(ms) {
    const total = ms / 1000;
    const m = Math.floor(total / 60);
    const s = (total % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  }

  function setError(id, msg) {
    $(id).textContent = msg || "";
    $(id).hidden = !msg;
  }

  let toastTimer;
  function toast(msg, ms = 2500) {
    const el = $("loading");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function copy(text, flashId) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (flashId) {
      $(flashId).hidden = false;
      setTimeout(() => ($(flashId).hidden = true), 1500);
    }
  }

  function fillLangSelect(sel, value) {
    sel.innerHTML = "";
    LANGUAGES.forEach(([code, name]) => sel.add(new Option(name, code)));
    sel.value = value;
  }
  const validLang = (l) => LANGUAGES.some(([c]) => c === l);

  // ======================================================================
  // Wikipedia API
  // ======================================================================
  async function api(lang, params) {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    Object.entries({ format: "json", formatversion: "2", origin: "*", ...params })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.info || "Wikipedia API error");
    return data;
  }

  // A "linkable" random article: take 10 random ones and choose the longest.
  async function randomTitle(lang) {
    const data = await api(lang, {
      action: "query", generator: "random", grnnamespace: "0", grnlimit: "10", prop: "info",
    });
    const pages = data.query.pages.filter((p) => !/disambiguation|pekerside|flertydig/i.test(p.title));
    pages.sort((a, b) => b.length - a.length);
    return pages[0].title;
  }

  async function resolveTitle(lang, title) {
    const data = await api(lang, { action: "query", titles: title, redirects: "1" });
    const page = data.query.pages[0];
    return page.missing || page.invalid ? null : page.title;
  }

  async function fetchArticle(lang, title) {
    const data = await api(lang, {
      action: "parse", page: title, prop: "text|displaytitle", redirects: "1",
      disableeditsection: "1", disabletoc: "1",
    });
    return { title: data.parse.title, displaytitle: data.parse.displaytitle, html: data.parse.text };
  }

  async function fetchSummary(lang, title) {
    try {
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function suggest(lang, query, datalist) {
    if (query.length < 2) return;
    try {
      const data = await api(lang, { action: "opensearch", search: query, limit: "8", namespace: "0" });
      datalist.innerHTML = "";
      (data[1] || []).forEach((t) => datalist.appendChild(new Option(t)));
    } catch { /* ignore */ }
  }

  function wireSuggest(inputId, listId, getLang) {
    let t;
    $(inputId).addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => suggest(getLang(), e.target.value, $(listId)), 200);
    });
  }

  async function showTargetInfo(lang, title, imgId, textId) {
    $(textId).textContent = "Loading description…";
    $(imgId).hidden = true;
    const sum = await fetchSummary(lang, title);
    $(textId).textContent = sum?.extract || "";
    if (sum?.thumbnail?.source) {
      $(imgId).src = sum.thumbnail.source;
      $(imgId).hidden = false;
    }
  }

  // ======================================================================
  // Routes (daily / random / custom)
  // ======================================================================
  function todayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function seededRandom(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }
  function dailyPair() {
    const rand = seededRandom(todayKey());
    const a = Math.floor(rand() * DAILY_POOL.length);
    let b = Math.floor(rand() * DAILY_POOL.length);
    if (b === a) b = (b + 1) % DAILY_POOL.length;
    return [DAILY_POOL[a], DAILY_POOL[b]];
  }

  /** Returns { lang, start, target, kind } with resolved titles, or throws. */
  async function pickRoute(kind, lang, customStart, customTarget) {
    let a, b;
    if (kind === "daily") {
      if (lang !== "en") throw new Error("The daily challenge is only on English Wikipedia.");
      [a, b] = dailyPair();
    } else if (kind === "random") {
      [a, b] = await Promise.all([randomTitle(lang), randomTitle(lang)]);
    } else {
      a = (customStart || "").trim();
      b = (customTarget || "").trim();
      if (!a || !b) throw new Error("Enter both a start and a target article.");
    }
    const [start, target] = await Promise.all([resolveTitle(lang, a), resolveTitle(lang, b)]);
    if (!start) throw new Error(`Couldn't find an article called “${a}”.`);
    if (!target) throw new Error(`Couldn't find an article called “${b}”.`);
    if (norm(start) === norm(target)) throw new Error("Start and target are the same article.");
    return { lang, start, target, kind, date: kind === "daily" ? todayKey() : undefined };
  }

  // ======================================================================
  // Race engine (shared by solo and multiplayer)
  // ======================================================================
  const race = {
    route: null, path: [], clicks: 0, startTime: 0, timerId: null,
    busy: false, active: false, token: 0, hooks: {},
  };

  function beginRace(route, hooks = {}) {
    race.token++;
    Object.assign(race, { route, path: [], clicks: 0, busy: false, active: true, hooks, startTime: 0 });
    $("hud-target").textContent = route.target;
    $("hud-clicks").textContent = "0";
    $("hud-time").textContent = "0:00.0";
    $("path").innerHTML = "";
    $("article-title").textContent = "";
    $("article-body").innerHTML = "";
    const mpMode = !!hooks.multiplayer;
    $("race-side").hidden = !mpMode;
    document.querySelector(".game-layout").classList.toggle("with-side", mpMode);
    show("game");
    navigate(route.start, { initial: true });
  }

  function stopRace() {
    race.active = false;
    race.token++;
    stopTimer();
  }

  function startTimer() {
    stopTimer();
    race.startTime = performance.now();
    race.timerId = setInterval(() => {
      $("hud-time").textContent = fmtTime(performance.now() - race.startTime);
    }, 100);
  }
  function stopTimer() {
    if (race.timerId) clearInterval(race.timerId);
    race.timerId = null;
  }
  const elapsed = () => (race.startTime ? performance.now() - race.startTime : 0);

  function renderPathList(ol, path) {
    ol.innerHTML = "";
    path.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      ol.appendChild(li);
    });
  }

  async function navigate(title, { initial = false, back = false } = {}) {
    if (race.busy || !race.active) return;
    const token = race.token;
    race.busy = true;
    $("loading").textContent = "Loading…";
    $("loading").hidden = false;
    try {
      const art = await fetchArticle(race.route.lang, title);
      if (token !== race.token) { $("loading").hidden = true; return; } // race was cancelled meanwhile
      if (!initial) {
        race.clicks++;
        $("hud-clicks").textContent = race.clicks;
      }
      if (back) race.path.pop();
      else race.path.push(art.title);
      renderArticle(art);
      renderPathList($("path"), race.path);
      if (initial) startTimer();
      race.hooks.onMove?.(art.title, race.clicks);
      $("loading").hidden = true;
      if (norm(art.title) === norm(race.route.target)) finishRace();
    } catch (e) {
      if (token === race.token) toast(`Couldn't load “${title}”: ${e.message}`, 3500);
    } finally {
      if (token === race.token) race.busy = false;
    }
  }

  function finishRace() {
    const result = { clicks: race.clicks, time: elapsed(), path: [...race.path] };
    stopRace();
    race.hooks.onFinish?.(result);
  }

  // Parse Wikipedia HTML and rewrite links so only article links work.
  function renderArticle(art) {
    const doc = new DOMParser().parseFromString(art.html, "text/html");
    doc.querySelectorAll("script, style, link, meta, iframe, object, embed, form, .mw-editsection, .navbox, .reflist, .mw-references-wrap, .metadata, .sistersitebox")
      .forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((a) => { if (a.name.startsWith("on")) el.removeAttribute(a.name); });
    });
    doc.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/wiki\/([^#?]+)/);
      let target = null;
      if (m) {
        try { target = decodeURIComponent(m[1]).replace(/_/g, " "); } catch { target = null; }
        if (target && target.includes(":")) target = null; // File:, Category:, Help: …
      }
      a.removeAttribute("href");
      a.removeAttribute("title");
      if (target) {
        a.className = "wl";
        a.dataset.title = target;
        a.setAttribute("role", "link");
        a.tabIndex = 0;
      } else {
        a.className = "dead";
      }
    });
    doc.querySelectorAll("img").forEach((img) => {
      ["src", "srcset"].forEach((attr) => {
        const v = img.getAttribute(attr);
        if (v) img.setAttribute(attr, v.replace(/(^|\s|,)\/\//g, "$1https://"));
      });
      img.loading = "lazy";
    });
    const titleDoc = new DOMParser().parseFromString(art.displaytitle || art.title, "text/html");
    $("article-title").textContent = titleDoc.body.textContent;
    const body = $("article-body");
    body.innerHTML = "";
    body.append(...doc.body.childNodes);
    window.scrollTo(0, 0);
  }

  function onArticleClick(e) {
    const a = e.target.closest("a.wl");
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.title);
  }

  function goBack() {
    if (race.path.length < 2 || race.busy) return;
    navigate(race.path[race.path.length - 2], { back: true });
  }

  let quitArmed = null;
  function quitClicked() {
    const btn = $("btn-quit");
    if (!quitArmed) {
      btn.textContent = "Sure? Click again";
      quitArmed = setTimeout(() => { quitArmed = null; btn.textContent = "Give up"; }, 2500);
      return;
    }
    clearTimeout(quitArmed);
    quitArmed = null;
    btn.textContent = "Give up";
    stopRace();
    race.hooks.onQuit?.();
  }

  // ======================================================================
  // Solo
  // ======================================================================
  const solo = { route: null, lastRun: null };

  function loadHistory() {
    try { return JSON.parse(store.get(HISTORY_KEY)) || []; } catch { return []; }
  }
  function saveRun(run) {
    const list = loadHistory();
    list.push(run);
    list.sort((a, b) => a.clicks - b.clicks || a.time - b.time);
    store.set(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
  }
  function renderHistory() {
    const list = loadHistory();
    const ol = $("history");
    ol.innerHTML = "";
    $("history-empty").hidden = list.length > 0;
    list.slice(0, 10).forEach((r) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${r.start} → ${r.target}`;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = ` ${r.clicks} clicks · ${fmtTime(r.time)} · ${r.lang} · ${r.mode}${r.date ? " · " + r.date : ""}`;
      li.append(strong, meta);
      ol.appendChild(li);
    });
  }

  async function soloPick(kind) {
    setError("menu-error", "");
    setMenuBusy(true);
    try {
      solo.route = await pickRoute(kind, $("lang").value, $("custom-start").value, $("custom-target").value);
      $("pv-start").textContent = solo.route.start;
      $("pv-target").textContent = solo.route.target;
      show("preview");
      showTargetInfo(solo.route.lang, solo.route.target, "pv-img", "pv-extract");
    } catch (e) {
      setError("menu-error", e.message || "Something went wrong. Check your connection.");
    } finally {
      setMenuBusy(false);
    }
  }

  function soloStart() {
    beginRace(solo.route, {
      onFinish(result) {
        const r = solo.route;
        solo.lastRun = { start: r.start, target: r.target, lang: r.lang, mode: r.kind, date: r.date, ...result };
        saveRun(solo.lastRun);
        renderHistory();
        $("win-time").textContent = fmtTime(result.time);
        $("win-clicks").textContent = result.clicks;
        renderPathList($("win-path"), result.path);
        setTimeout(() => show("win"), 400);
      },
      onQuit() { show("menu"); },
    });
  }

  function soloShareText() {
    const r = solo.lastRun;
    const label = r.mode === "daily" ? `Daily ${r.date}` : `${r.start} → ${r.target}`;
    return `🏁 Wiki Speedrun — ${label}\n${r.clicks} clicks · ${fmtTime(r.time)}\n${r.path.join(" → ")}\n${baseUrl()}`;
  }

  function setMenuBusy(b) {
    document.querySelectorAll("#menu button").forEach((btn) => (btn.disabled = b));
    if (!b) updateDailyAvailability();
  }

  function updateDailyAvailability() {
    const isEn = $("lang").value === "en";
    $("btn-daily").disabled = !isEn;
    $("daily-sub").textContent = isEn
      ? `${dailyPair().join(" → ")} · ${todayKey()}`
      : "Only available on English Wikipedia";
  }

  function baseUrl() {
    const url = new URL(location.href);
    url.hash = "";
    const brokers = url.searchParams.getAll("broker");
    url.search = "";
    brokers.forEach((b) => url.searchParams.append("broker", b)); // keep custom brokers in shared links
    return url.toString();
  }

  // ======================================================================
  // Multiplayer
  // ======================================================================
  /*
   * Model: one player is the host. The host owns the room "state" (route, phase,
   * race id, player order) and re-broadcasts it every few seconds. Everyone sends
   * a heartbeat "ping" with their own progress. If the host disappears, the next
   * player in the host's join order takes over automatically.
   *
   * Message types:
   *   ping   {name, raceId, status, clicks, current, time}
   *   state  {phase, route, raceId, order}            (host only)
   *   go     {raceId, route}                           (host only, starts countdown)
   *   move   {raceId, clicks, current}
   *   finish {raceId, clicks, time, path}
   *   quit   {raceId}
   *   leave  {}
   */
  const mp = {
    room: null, code: null, me: null, name: "",
    hostId: null, lastHostSeen: 0, order: [],
    players: new Map(), // id -> {name, lastSeen, raceId, status, clicks, current, time, path}
    phase: "lobby",     // lobby | racing
    route: null, raceId: null,
    myRaceDone: false,  // finished or gave up in current race
    inRace: false,      // currently racing (on game screen)
    startedRaceIds: new Set(),
    loop: null, joinTimer: null,
  };
  const isHost = () => mp.hostId === mp.me;

  function myName() {
    let n = $("nickname").value.trim().slice(0, 20);
    if (!n) {
      const adj = ["Speedy", "Clever", "Sneaky", "Turbo", "Lucky", "Swift", "Brave", "Curious"];
      const ani = ["Fox", "Otter", "Moose", "Owl", "Lynx", "Puffin", "Wolf", "Hare"];
      n = `${adj[Math.floor(Math.random() * adj.length)]} ${ani[Math.floor(Math.random() * ani.length)]}`;
      $("nickname").value = n;
    }
    store.set(NAME_KEY, n);
    return n;
  }

  function freshPlayer(name) {
    return { name, lastSeen: Date.now(), raceId: null, status: "lobby", clicks: 0, current: "", time: 0, path: [] };
  }

  async function enterRoom(code, creating) {
    setError("mp-error", "");
    const btns = [$("btn-create"), $("btn-join")];
    btns.forEach((b) => (b.disabled = true));
    leaveRoom(true);

    mp.me = Net.randomId();
    mp.code = code;
    mp.name = myName();
    mp.players = new Map([[mp.me, freshPlayer(mp.name)]]);
    mp.phase = "lobby";
    mp.route = null;
    mp.raceId = null;
    mp.myRaceDone = false;
    mp.inRace = false;
    mp.startedRaceIds = new Set();
    mp.hostId = creating ? mp.me : null;
    mp.order = [mp.me];
    mp.lastHostSeen = Date.now();

    $("lobby-code").textContent = code;
    $("net-status").textContent = "Connecting…";
    renderLobby();
    show("lobby");
    history.replaceState(null, "", inviteUrl());

    const room = new Net.Room(code, mp.me, onMessage, (n, total) => {
      $("net-status").textContent = n > 0
        ? `🟢 Connected (${n}/${total} relays) · end-to-end encrypted`
        : "🔴 Reconnecting…";
    });
    mp.room = room;
    try {
      await room.connect();
    } catch (e) {
      if (mp.room === room) {
        mp.room = null;
        show("menu");
        setError("mp-error", e.message);
      }
      btns.forEach((b) => (b.disabled = false));
      return;
    }
    btns.forEach((b) => (b.disabled = false));
    if (mp.room !== room) return;

    sendPing();
    if (isHost()) broadcastState();
    mp.loop = setInterval(tick, PING_EVERY);

    // Joining an empty room (or nobody answered): become host.
    if (!creating) {
      mp.joinTimer = setTimeout(() => {
        if (!mp.hostId) { mp.hostId = mp.me; electOrder(); broadcastState(); renderAll(); }
      }, 5000);
      $("lobby-wait").textContent = "Looking for the host…";
    }
  }

  function leaveRoom(silent) {
    if (mp.room) {
      if (!silent) mp.room.send("leave");
      const r = mp.room;
      setTimeout(() => r.close(), 300);
    }
    mp.room = null;
    clearInterval(mp.loop);
    clearTimeout(mp.joinTimer);
    if (mp.inRace) stopRace();
    mp.inRace = false;
    if (!silent) {
      history.replaceState(null, "", baseUrl());
      show("menu");
    }
  }

  function inviteUrl() {
    const url = new URL(baseUrl());
    url.searchParams.set("room", mp.code);
    return url.toString();
  }

  const send = (type, data = {}) => mp.room?.send(type, { ...data, name: mp.name });

  function myPlayer() { return mp.players.get(mp.me); }

  function sendPing() {
    const p = myPlayer();
    send("ping", {
      name: mp.name, raceId: p.raceId, status: p.status, clicks: p.clicks,
      current: p.current, time: p.time, path: p.status === "finished" ? p.path : undefined,
    });
  }

  function broadcastState() {
    if (!isHost()) return;
    electOrder();
    send("state", { phase: mp.phase, route: mp.route, raceId: mp.raceId, order: mp.order });
  }

  // Keep join order: existing order first, then newcomers.
  function electOrder() {
    const alive = new Set(mp.players.keys());
    const order = mp.order.filter((id) => alive.has(id));
    [...alive].filter((id) => !order.includes(id)).sort().forEach((id) => order.push(id));
    mp.order = order;
  }

  function pickNewHost() {
    electOrder();
    const next = mp.order[0] || mp.me;
    mp.hostId = next;
    mp.lastHostSeen = Date.now();
    if (isHost()) {
      toast("You are now the host 👑");
      broadcastState();
    }
    renderAll();
  }

  function tick() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of mp.players) {
      if (id !== mp.me && now - p.lastSeen > PLAYER_TIMEOUT) {
        mp.players.delete(id);
        changed = true;
      }
    }
    sendPing();
    if (isHost()) {
      broadcastState();
    } else if (mp.hostId && now - mp.lastHostSeen > HOST_TIMEOUT) {
      mp.players.delete(mp.hostId);
      pickNewHost();
      changed = true;
    }
    if (changed) renderAll();
  }

  function sanitizeRoute(r) {
    if (!r || typeof r !== "object") return null;
    const lang = validLang(r.lang) ? r.lang : null;
    const start = str(r.start, 255), target = str(r.target, 255);
    if (!lang || !start || !target) return null;
    return { lang, start, target, kind: str(r.kind, 10), date: str(r.date, 10) || undefined };
  }

  function resetRaceFields(raceId) {
    for (const p of mp.players.values()) {
      if (p.raceId !== raceId) Object.assign(p, { raceId, status: "waiting", clicks: 0, current: "", time: 0, path: [] });
    }
  }

  function onMessage(from, type, d) {
    let p = mp.players.get(from);
    if (!p) {
      p = freshPlayer(str(d.name, 20) || "Player");
      mp.players.set(from, p);
      if (isHost()) setTimeout(broadcastState, 50); // let newcomers sync fast
    }
    p.lastSeen = Date.now();
    if (typeof d.name === "string" && d.name.trim()) p.name = str(d.name.trim(), 20);

    const sameRace = (rid) => typeof rid === "string" && rid === mp.raceId;

    switch (type) {
      case "ping":
        if (sameRace(d.raceId)) {
          p.raceId = d.raceId;
          p.status = ["waiting", "racing", "finished", "gaveup"].includes(d.status) ? d.status : p.status;
          p.clicks = num(d.clicks);
          p.current = str(d.current);
          p.time = num(d.time);
          if (Array.isArray(d.path)) p.path = d.path.slice(0, 200).map((t) => str(t));
        } else if (!d.raceId && mp.phase === "lobby") {
          p.status = "lobby";
        }
        break;

      case "state": {
        // Two hosts at once (e.g. both joined an empty room): smaller id wins, everywhere.
        if (mp.hostId && from !== mp.hostId && from > mp.hostId &&
            (isHost() || (mp.players.has(mp.hostId) && Date.now() - mp.lastHostSeen < HOST_TIMEOUT))) {
          return;
        }
        clearTimeout(mp.joinTimer);
        mp.hostId = from;
        mp.lastHostSeen = Date.now();
        if (Array.isArray(d.order)) mp.order = d.order.filter((x) => typeof x === "string").slice(0, 100);
        mp.route = sanitizeRoute(d.route);
        const newRaceId = typeof d.raceId === "string" ? d.raceId : null;
        if (newRaceId !== mp.raceId) {
          mp.raceId = newRaceId;
          mp.myRaceDone = false;
          if (newRaceId) resetRaceFields(newRaceId);
        }
        const newPhase = d.phase === "racing" ? "racing" : "lobby";
        if (newPhase === "lobby" && mp.phase === "racing") backToLobby();
        mp.phase = newPhase;
        break;
      }

      case "go": {
        if (from !== mp.hostId) return;
        const route = sanitizeRoute(d.route);
        if (!route || typeof d.raceId !== "string") return;
        mp.route = route;
        mp.raceId = d.raceId;
        mp.phase = "racing";
        mp.myRaceDone = false;
        resetRaceFields(d.raceId);
        startCountdown(d.raceId);
        break;
      }

      case "move":
        if (sameRace(d.raceId)) {
          p.raceId = d.raceId;
          p.status = "racing";
          p.clicks = num(d.clicks);
          p.current = str(d.current);
        }
        break;

      case "finish":
        if (sameRace(d.raceId)) {
          const wasDone = p.status === "finished";
          Object.assign(p, {
            raceId: d.raceId, status: "finished", clicks: num(d.clicks), time: num(d.time),
            path: Array.isArray(d.path) ? d.path.slice(0, 200).map((t) => str(t)) : [],
          });
          if (!wasDone && mp.inRace) toast(`🏁 ${p.name} finished in ${fmtTime(p.time)}!`);
        }
        break;

      case "quit":
        if (sameRace(d.raceId)) { p.raceId = d.raceId; p.status = "gaveup"; }
        break;

      case "leave":
        mp.players.delete(from);
        if (from === mp.hostId) pickNewHost();
        else if (isHost()) broadcastState();
        break;

      default:
        return;
    }
    renderAll();
  }

  // ---------- Host actions ----------
  async function hostPick(kind) {
    if (!isHost()) return;
    setError("lobby-error", "");
    const btns = ["lobby-daily", "lobby-random", "lobby-custom", "btn-start-race"].map($);
    btns.forEach((b) => (b.disabled = true));
    try {
      mp.route = await pickRoute(kind, $("lobby-lang").value, $("lobby-start").value, $("lobby-target").value);
      broadcastState();
    } catch (e) {
      setError("lobby-error", e.message);
    } finally {
      btns.forEach((b) => (b.disabled = false));
      renderAll();
    }
  }

  function hostStart() {
    if (!isHost() || !mp.route) return;
    mp.raceId = Net.randomId();
    mp.phase = "racing";
    mp.myRaceDone = false;
    resetRaceFields(mp.raceId);
    send("go", { raceId: mp.raceId, route: mp.route });
    broadcastState();
    startCountdown(mp.raceId);
  }

  function hostNewRace() {
    if (!isHost()) return;
    mp.phase = "lobby";
    broadcastState();
    backToLobby();
    renderAll();
  }

  // ---------- Racing ----------
  function startCountdown(raceId) {
    if (mp.startedRaceIds.has(raceId)) return;
    mp.startedRaceIds.add(raceId);
    let n = COUNTDOWN;
    $("countdown-num").textContent = n;
    $("countdown").hidden = false;
    show("lobby");
    renderAll();
    const t = setInterval(() => {
      n--;
      if (n > 0) { $("countdown-num").textContent = n; return; }
      clearInterval(t);
      $("countdown").hidden = true;
      if (mp.raceId === raceId && mp.room) mpBeginRace();
    }, 1000);
  }

  function mpBeginRace() {
    const raceId = mp.raceId;
    mp.startedRaceIds.add(raceId);
    mp.inRace = true;
    mp.myRaceDone = false;
    Object.assign(myPlayer(), { raceId, status: "racing", clicks: 0, current: mp.route.start, time: 0, path: [] });
    sendPing();
    beginRace(mp.route, {
      multiplayer: true,
      onMove(title, clicks) {
        Object.assign(myPlayer(), { current: title, clicks });
        send("move", { raceId, clicks, current: title });
        renderAll();
      },
      onFinish(result) {
        mp.inRace = false;
        mp.myRaceDone = true;
        Object.assign(myPlayer(), { status: "finished", ...result, current: mp.route.target });
        send("finish", { raceId, ...result });
        renderAll();
        setTimeout(() => show("results"), 400);
      },
      onQuit() {
        mp.inRace = false;
        mp.myRaceDone = true;
        myPlayer().status = "gaveup";
        send("quit", { raceId });
        renderAll();
        show("results");
      },
    });
    renderAll();
  }

  function backToLobby() {
    if (mp.inRace) stopRace();
    mp.inRace = false;
    $("countdown").hidden = true;
    for (const p of mp.players.values()) p.status = "lobby";
    if (mp.room) show("lobby");
  }

  // ---------- Rendering ----------
  function rankedPlayers() {
    const order = { finished: 0, racing: 1, waiting: 2, gaveup: 3, lobby: 4 };
    return [...mp.players.entries()].sort(([, a], [, b]) => {
      const sa = order[a.status] ?? 5, sb = order[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      if (a.status === "finished") return a.time - b.time || a.clicks - b.clicks;
      if (a.status === "racing") return b.clicks - a.clicks;
      return 0;
    });
  }

  function renderBoard(ol, { racing }) {
    ol.innerHTML = "";
    const list = racing ? rankedPlayers() : mp.order.filter((id) => mp.players.has(id)).map((id) => [id, mp.players.get(id)])
      .concat([...mp.players.entries()].filter(([id]) => !mp.order.includes(id)));
    let rank = 0;
    list.forEach(([id, p]) => {
      const li = document.createElement("li");
      li.className = p.status + (id === mp.me ? " me" : "");
      const r = document.createElement("span");
      r.className = "rank";
      if (racing && p.status === "finished") r.textContent = ["🥇", "🥈", "🥉"][rank] || String(rank + 1);
      if (racing && p.status === "finished") rank++;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = (id === mp.hostId ? "👑 " : "") + p.name + (id === mp.me ? " (you)" : "");
      const info = document.createElement("span");
      info.className = "info";
      if (racing) {
        info.textContent = {
          finished: `${fmtTime(p.time)} · ${p.clicks} clicks`,
          racing: `${p.clicks} · ${p.current || "…"}`,
          waiting: "starting…",
          gaveup: "gave up",
          lobby: "not in this race",
        }[p.status] || "";
      } else {
        info.textContent = id === mp.hostId ? "host" : "";
      }
      li.append(r, name, info);
      ol.appendChild(li);
    });
  }

  function renderLobby() {
    const host = isHost();
    $("player-count").textContent = `(${mp.players.size})`;
    renderBoard($("lobby-players"), { racing: mp.phase === "racing" });
    $("host-controls").hidden = !host;
    $("lobby-route").hidden = !mp.route;
    if (mp.route) {
      const changed = $("lr-target").textContent !== mp.route.target || $("lr-start").dataset.lang !== mp.route.lang;
      $("lr-start").textContent = mp.route.start;
      $("lr-start").dataset.lang = mp.route.lang;
      $("lr-target").textContent = mp.route.target;
      if (changed) showTargetInfo(mp.route.lang, mp.route.target, "lr-img", "lr-extract");
      if (host) $("lobby-lang").value = mp.route.lang;
    } else {
      $("lr-target").textContent = "";
      $("lr-extract").textContent = "";
      $("lr-img").hidden = true;
    }
    const racingNow = mp.phase === "racing";
    $("btn-start-race").hidden = !host || racingNow;
    $("btn-start-race").disabled = !mp.route;
    const canJump = racingNow && !mp.inRace && !mp.myRaceDone && $("countdown").hidden &&
      mp.route && !mp.startedRaceIds.has(mp.raceId);
    $("btn-jump-in").hidden = !canJump;

    let wait = "";
    if (!mp.hostId) wait = "Looking for the host…";
    else if (racingNow) wait = canJump ? "A race is already running. Jump in, your own clock starts when you do." : "Race in progress…";
    else if (host) wait = mp.route ? "Press start when everyone's here." : "Pick a route to get started.";
    else wait = mp.route ? "Waiting for the host to start…" : "Waiting for the host to pick a route…";
    $("lobby-wait").textContent = wait;
  }

  function renderResults() {
    renderBoard($("results-board"), { racing: true });
    const me = myPlayer();
    $("results-title").textContent = me.status === "finished" ? "🎉 You made it!" : "🏁 Results";
    $("results-sub").textContent = mp.route ? `${mp.route.start} → ${mp.route.target}` : "";
    renderPathList($("results-path"), me.status === "finished" ? me.path : []);
    const stillRacing = [...mp.players.values()].some((p) => p.status === "racing" || p.status === "waiting");
    $("btn-new-race").hidden = !isHost();
    $("results-wait").textContent = stillRacing
      ? "Others are still racing…"
      : (isHost() ? "Everyone's done!" : "Waiting for the host to start a new race…");
  }

  function renderAll() {
    if (!mp.room) return;
    renderLobby();
    renderResults();
    if (mp.inRace) renderBoard($("race-board"), { racing: true });
  }

  // ======================================================================
  // Init
  // ======================================================================
  function init() {
    const params = new URLSearchParams(location.search);

    // Nickname
    $("nickname").value = store.get(NAME_KEY) || "";
    $("nickname").addEventListener("change", () => store.set(NAME_KEY, $("nickname").value.trim().slice(0, 20)));

    // Languages
    const savedLang = store.get(LANG_KEY);
    fillLangSelect($("lang"), validLang(savedLang) ? savedLang : "en");
    fillLangSelect($("lobby-lang"), "en");
    $("lang").addEventListener("change", () => { store.set(LANG_KEY, $("lang").value); updateDailyAvailability(); });
    $("lobby-lang").addEventListener("change", () => { $("lobby-daily").disabled = $("lobby-lang").value !== "en"; });
    updateDailyAvailability();

    // Solo
    $("btn-daily").addEventListener("click", () => soloPick("daily"));
    $("btn-random").addEventListener("click", () => soloPick("random"));
    $("btn-custom").addEventListener("click", () => soloPick("custom"));
    $("btn-go").addEventListener("click", soloStart);
    $("btn-cancel").addEventListener("click", () => show("menu"));
    $("btn-menu").addEventListener("click", () => show("menu"));
    $("btn-share").addEventListener("click", () => copy(soloShareText(), "copied"));
    wireSuggest("custom-start", "suggest-start", () => $("lang").value);
    wireSuggest("custom-target", "suggest-target", () => $("lang").value);
    renderHistory();

    // Game
    $("article-body").addEventListener("click", onArticleClick);
    $("article-body").addEventListener("keydown", (e) => { if (e.key === "Enter") onArticleClick(e); });
    $("btn-back").addEventListener("click", goBack);
    $("btn-quit").addEventListener("click", quitClicked);

    // Multiplayer
    $("btn-create").addEventListener("click", () => enterRoom(Net.newCode(), true));
    const doJoin = () => {
      const code = Net.normalizeCode($("join-code").value);
      if (!Net.isValidCode(code)) return setError("mp-error", "Room codes are 6 letters/numbers.");
      enterRoom(code, false);
    };
    $("btn-join").addEventListener("click", doJoin);
    $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
    $("join-code").addEventListener("input", (e) => { e.target.value = Net.normalizeCode(e.target.value); });
    $("btn-copy-code").addEventListener("click", () => copy(mp.code, "copied-lobby"));
    $("btn-copy-invite").addEventListener("click", () => copy(inviteUrl(), "copied-lobby"));
    $("btn-leave").addEventListener("click", () => leaveRoom(false));
    $("btn-results-leave").addEventListener("click", () => leaveRoom(false));
    $("lobby-daily").addEventListener("click", () => hostPick("daily"));
    $("lobby-random").addEventListener("click", () => hostPick("random"));
    $("lobby-custom").addEventListener("click", () => hostPick("custom"));
    $("btn-start-race").addEventListener("click", hostStart);
    $("btn-jump-in").addEventListener("click", mpBeginRace);
    $("btn-new-race").addEventListener("click", hostNewRace);
    wireSuggest("lobby-start", "suggest-lobby-start", () => $("lobby-lang").value);
    wireSuggest("lobby-target", "suggest-lobby-target", () => $("lobby-lang").value);
    window.addEventListener("pagehide", () => { if (mp.room) mp.room.send("leave"); });

    // Invite link: ?room=CODE
    const roomParam = Net.normalizeCode(params.get("room"));
    if (Net.isValidCode(roomParam)) {
      $("join-code").value = roomParam;
      if (store.get(NAME_KEY)) {
        enterRoom(roomParam, false);
      } else {
        $("nickname").focus();
        setError("mp-error", "Pick a nickname, then press Join.");
      }
    }
  }

  init();
})();
