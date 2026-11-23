// Absolute Carnage team hub — web app (Supabase backend). Phone-first.
(() => {
  "use strict";
  const CFG = window.CARNAGE_CONFIG || {};
  const LOGIN_DOMAIN = "players.absolute-carnage.invalid";   // username -> <username>@this (never emailed)
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  function notice(msg, kind) { const n = $("#notice"); n.hidden = !msg; n.textContent = msg || ""; n.dataset.kind = kind || ""; }

  if (!CFG.supabaseUrl || CFG.supabaseUrl.startsWith("__") || !window.supabase) {
    notice("This site isn't connected to its database yet.", "warn"); return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  const S = { session: null, me: null, players: {}, phones: {}, events: [], rsvps: [], att: [], posts: [],
              filter: "all", view: "schedule", attEvent: null, loaded: false };
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const MARKS = [["present","Present"],["tardy","Tardy"],["absent","Absent"],["ncns","No call / no show"]];
  const isAdmin = () => !!(S.me && S.me.role === "admin");
  const nameOf = (pid) => (S.players[pid] && S.players[pid].name) || "Former player";

  // ---------- dates ----------
  const evDate = (e) => new Date(e.date + "T" + (e.start_time ? e.start_time.slice(0, 5) : "12:00"));
  const today0 = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const isPastDay = (e) => new Date(e.date + "T00:00") < today0();
  function rel(d) {
    const days = Math.round((new Date(d).setHours(0,0,0,0) - today0()) / 864e5);
    if (days === 0) return "Today"; if (days === 1) return "Tomorrow"; if (days === -1) return "Yesterday";
    return days > 0 ? "In " + days + " days" : Math.abs(days) + " days ago";
  }
  function fmtTime(t) { if (!t) return ""; const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + (h >= 12 ? " PM" : " AM"); }
  function ago(ts) { const ms = new Date(ts).getTime(), s = (Date.now() - ms) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s/60) + "m ago"; if (s < 86400) return Math.floor(s/3600) + "h ago"; const d = new Date(ms); return MONTHS[d.getMonth()] + " " + d.getDate(); }
  const evLabel = (e) => { const d = evDate(e); return WD[d.getDay()] + " " + MONTHS[d.getMonth()] + " " + d.getDate() + " · " + (e.title || (e.type === "tournament" ? "Tournament" : "Practice")); };

  // ---------- passwords + texting ----------
  function genPassword() {
    const words = ["paint","bunker","snake","dorito","tape","break","pod","hopper","mid","back","front","sweep","bounce","wire"];
    const a = new Uint32Array(3); crypto.getRandomValues(a);
    return words[a[0] % words.length] + "-" + words[a[1] % words.length] + "-" + (10 + a[2] % 90);
  }
  const siteUrl = () => location.origin + location.pathname.replace(/index\.html$/, "");
  function smsHref(phone, body) {
    const num = String(phone || "").replace(/[^\d+]/g, "");
    return "sms:" + num + (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? "&" : "?") + "body=" + encodeURIComponent(body);
  }
  function showLoginText(name, username, password, phone) {
    const body = "Absolute Carnage team site: " + siteUrl() + "\nUsername: " + username + "\nPassword: " + password + "\nChange your password after you log in (tap your name at the top).";
    $("#txBox").replaceChildren(el("div", { text: name }), el("div", {}, "Site: ", el("b", { text: siteUrl() })),
      el("div", {}, "Username: ", el("b", { text: username })), el("div", {}, "Password: ", el("b", { text: password })));
    const a = $("#txSms");
    if (phone) { a.hidden = false; a.href = smsHref(phone, body); $("#txNote").textContent = "Opens Messages with the text written out. You just hit Send."; }
    else { a.hidden = true; $("#txNote").textContent = "No cellphone on file. Copy the text and send it yourself."; }
    $("#txCopy").onclick = async () => { try { await navigator.clipboard.writeText(body); $("#txCopy").textContent = "Copied"; setTimeout(() => $("#txCopy").textContent = "Copy text", 1500); } catch (e) {} };
    $("#txDlg").showModal();
  }
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

  async function adminCall(body) {
    const { data, error } = await sb.functions.invoke("admin-users", { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  // ---------- login ----------
  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const u = $("#liUser").value.trim().toLowerCase(), p = $("#liPass").value;
    if (!u || !p) { $("#liErr").textContent = "Enter your username and password."; return; }
    $("#liBtn").disabled = true; $("#liErr").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: u + "@" + LOGIN_DOMAIN, password: p });
    $("#liBtn").disabled = false;
    if (error) $("#liErr").textContent = /invalid/i.test(error.message) ? "That username and password don't match." : error.message;
  });
  $("#who").addEventListener("click", () => {
    $("#meWho").textContent = S.me ? S.me.name + " · username " + (S.me.username || "") : "";
    $("#meNew").value = ""; $("#meNew2").value = ""; $("#meErr").textContent = ""; $("#meDlg").showModal();
  });
  $("#meOut").addEventListener("click", async () => { $("#meDlg").close(); await sb.auth.signOut(); });
  $("#meForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("#meNew").value, b = $("#meNew2").value;
    if (a.length < 8) { $("#meErr").textContent = "Use at least 8 characters."; return; }
    if (a !== b) { $("#meErr").textContent = "The two passwords don't match."; return; }
    $("#meSave").disabled = true;
    const { error } = await sb.auth.updateUser({ password: a });
    $("#meSave").disabled = false;
    if (error) { $("#meErr").textContent = error.message; return; }
    $("#meDlg").close(); notice("Password changed.");
    setTimeout(() => { if ($("#notice").textContent === "Password changed.") notice(""); }, 4000);
  });

  // ---------- tabs ----------
  try { const v = localStorage.getItem("ac.view"); if (v) S.view = v; } catch (e) {}
  function showView(v) {
    if (!["home","schedule","bulletin","attendance","roster"].includes(v)) v = "home";
    S.view = v;
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    for (const s of ["home","schedule","bulletin","attendance","roster"]) $("#view-" + s).hidden = s !== v;
    try { localStorage.setItem("ac.view", v); } catch (e) {}
  }
  document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
    S.filter = b.dataset.f; document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); render();
  }));
  showView(S.view);

  // ---------- data ----------
  async function loadTable(t) {
    if (t === "players") { const { data } = await sb.from("players").select("*"); const o = {}; (data || []).forEach(p => o[p.id] = p); S.players = o;
      S.me = Object.values(o).find(p => p.user_id === (S.session && S.session.user.id)) || null; }
    else if (t === "player_private") { if (!isAdmin()) { S.phones = {}; return; } const { data } = await sb.from("player_private").select("*"); const o = {}; (data || []).forEach(r => o[r.player_id] = r.phone); S.phones = o; }
    else if (t === "events") { const { data } = await sb.from("events").select("*").order("date"); S.events = data || []; }
    else if (t === "rsvps") { const { data } = await sb.from("rsvps").select("*"); S.rsvps = data || []; }
    else if (t === "attendance") { const { data } = await sb.from("attendance").select("*"); S.att = data || []; }
    else if (t === "posts") { const { data } = await sb.from("posts").select("*").order("created_at", { ascending: false }).limit(100); S.posts = data || []; }
  }
  let channel = null, reloadTimers = {};
  function liveUpdates() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("carnage");
    for (const t of ["players","events","rsvps","attendance","posts"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => {
        clearTimeout(reloadTimers[t]);
        reloadTimers[t] = setTimeout(async () => { await loadTable(t); if (t === "players") await loadTable("player_private"); render(); }, 250);
      });
    }
    channel.subscribe();
  }
  async function startApp() {
    $("#loginForm").hidden = true; $("#app").hidden = false; $("#tabs").hidden = false; $("#who").hidden = false;
    showView("home");   // every login lands on Home
    try {
      await loadTable("players");
      if (!S.me) { notice("Your login isn't linked to a roster spot. Ask an admin.", "warn"); }
      await Promise.all(["player_private","events","rsvps","attendance","posts"].map(loadTable));
      S.loaded = true; render(); liveUpdates();
    } catch (e) { notice("The team data couldn't load. Check your connection and refresh.", "warn"); }
  }
  function stopApp() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    Object.assign(S, { me: null, players: {}, phones: {}, events: [], rsvps: [], att: [], posts: [], loaded: false });
    $("#app").hidden = true; $("#tabs").hidden = true; $("#who").hidden = true; $("#loginForm").hidden = false; notice("");
  }
  sb.auth.onAuthStateChange((evt, session) => {
    const had = !!S.session; S.session = session;
    if (session && (!had || evt === "SIGNED_IN") && !S.loaded) startApp();
    if (!session) stopApp();
  });
  // refresh when the phone wakes the tab back up
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && S.loaded) { await Promise.all(["players","events","rsvps","attendance","posts"].map(loadTable)); await loadTable("player_private"); render(); }
  });

  // ---------- render ----------
  function render() {
    if (!S.loaded) return;
    $("#whoName").textContent = S.me ? S.me.name : "Signed in";
    $("#whoRole").textContent = isAdmin() ? "Admin" : (S.me ? "Player" : "");
    $("#addEvent").hidden = !isAdmin(); $("#addPlayer").hidden = !isAdmin();
    renderHome(); renderSchedule(); renderPosts(); renderAttendance(); renderRoster();
  }

  // ---------- weather (Open-Meteo: free, no key) ----------
  const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
  const WX = {0:"Clear",1:"Mostly clear",2:"Partly cloudy",3:"Cloudy",45:"Fog",48:"Fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",56:"Freezing drizzle",57:"Freezing drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",66:"Freezing rain",67:"Freezing rain",71:"Light snow",73:"Snow",75:"Heavy snow",77:"Snow",80:"Showers",81:"Showers",82:"Heavy showers",85:"Snow showers",86:"Snow showers",95:"Thunderstorms",96:"Thunderstorms, hail",99:"Thunderstorms, hail"};
  const geoCache = {}, wxCache = {};
  async function geocode(addr) {
    if (geoCache[addr]) return geoCache[addr];
    const m = addr.match(/,\s*([^,]+?),\s*([A-Z]{2})\b/) || addr.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\b/);
    const city = m ? m[1].trim() : addr.split(",").slice(-2, -1)[0] || addr, state = m ? STATES[m[2]] : null;
    const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&countryCode=US&name=" + encodeURIComponent(city));
    const j = await r.json(); const res = (j && j.results) || [];
    const hit = (state && res.find(x => x.admin1 === state)) || res[0] || null;
    geoCache[addr] = hit; return hit;
  }
  async function weatherFor(e) {
    const key = e.id + "|" + e.date + "|" + e.location;
    if (wxCache[key]) return wxCache[key];
    const days = Math.round((new Date(e.date + "T00:00") - today0()) / 864e5);
    if (days > 15) return (wxCache[key] = { note: "Forecast shows up about 2 weeks out" });
    if (!e.location) return (wxCache[key] = { note: "Add a field address to see the forecast" });
    try {
      const g = await geocode(e.location);
      if (!g) return (wxCache[key] = { note: "Couldn't find that address on the map" });
      const u = "https://api.open-meteo.com/v1/forecast?latitude=" + g.latitude + "&longitude=" + g.longitude +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&start_date=" + e.date + "&end_date=" + e.date;
      const d = (await (await fetch(u)).json()).daily;
      if (!d || !d.time || !d.time.length) return (wxCache[key] = { note: "No forecast yet" });
      return (wxCache[key] = { hi: Math.round(d.temperature_2m_max[0]), lo: Math.round(d.temperature_2m_min[0]),
        rain: d.precipitation_probability_max[0], text: WX[d.weather_code[0]] || "", place: g.name });
    } catch (x) { return { note: "Forecast unavailable right now" }; }
  }

  // ---------- home (landing) ----------
  function nextEvent() {
    const now = Date.now();
    return S.events.filter(e => !isPastDay(e) && (e.date !== ymd(new Date()) || !e.start_time || evDate(e).getTime() > now - 5 * 3600e3))
      .sort((a, b) => evDate(a) - evDate(b))[0] || null;
  }
  function renderHome() {
    const box = $("#home"); box.replaceChildren();
    const e = nextEvent();
    if (!e) box.append(el("div", { class: "empty" }, el("b", { text: "Nothing on the schedule" }), isAdmin() ? "Add the next practice or tournament on the Schedule tab." : "Admins add practices and tournaments on the Schedule tab."));
    else {
      const d = evDate(e), rs = S.rsvps.filter(r => r.event_id === e.id), mine = myRsvp(e.id);
      const ins = rs.filter(r => r.status === "in").length, outs = rs.filter(r => r.status === "out").length;
      const pend = rsvpPending && rsvpPending.eid === e.id, shown = pend ? "out" : (mine && mine.status);
      const wxTile = el("div", { class: "tile" }, el("small", { text: "Weather" }), el("b", { text: "…" }), el("span", { text: "Checking the forecast" }));
      weatherFor(e).then(w => {
        if (!wxTile.isConnected) return;
        wxTile.replaceChildren(el("small", { text: "Weather" }),
          w.note ? el("span", { text: w.note }) : el("b", { text: w.hi + "° / " + w.lo + "°" }),
          w.note ? null : el("span", { text: [w.text, w.rain != null ? w.rain + "% rain" : null].filter(Boolean).join(" · ") }));
      });
      box.append(el("article", { class: "hero" },
        el("div", { class: "htop" },
          el("div", {}, el("div", { class: "kick", text: e.type === "tournament" ? "Next tournament" : "Next practice" }),
            el("div", { class: "htitle", text: e.title }),
            el("div", { class: "hwhen", text: WD[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + (e.start_time ? " · " + fmtTime(e.start_time) : "") })),
          el("div", { class: "count", text: rel(d) })),
        el("div", { class: "hbody" },
          el("div", { class: "tiles" }, wxTile,
            e.type === "practice" ? el("div", { class: "tile paint" }, el("small", { text: "Paint to buy" }),
              el("b", { text: e.paint_cases != null ? e.paint_cases + (e.paint_cases === 1 ? " case" : " cases") : "–" }),
              el("span", { text: e.paint_cases != null ? "Set by the admins" : "Not set yet" })) : null,
            el("div", { class: "tile" }, el("small", { text: "Coming" }), el("b", { text: ins + " in" }), el("span", { text: outs + " can't make it" }))),
          mapRow("Field", e.location), mapRow("Stay", e.lodging, e.lodging_url),
          e.notes ? el("div", { class: "notes", text: e.notes }) : null,
          el("div", { class: "rsvp", role: "group", "aria-label": "Your RSVP" },
            [["in","I'm in"],["out","Can't make it"]].map(([v, t]) => el("button", { type: "button", "data-v": v, "aria-pressed": String(shown === v), disabled: S.me ? null : true, onclick: () => pickRsvp(e.id, mine, v) }, t))),
          pend ? rsvpReasonBox(e.id) : (mine && mine.status === "out" && mine.reason ? el("div", { class: "reason-text", text: "Your reason: " + mine.reason }) : null))));
    }
    const latest = [...S.posts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    box.append(el("h2", { text: "Latest on the bulletin" }));
    box.append(latest
      ? el("article", { class: "post" + (latest.pinned ? " pinned" : "") },
          el("div", { class: "phead" }, el("div", { class: "nm", text: nameOf(latest.player_id) }), el("div", { class: "tm", text: ago(latest.created_at) })),
          el("div", { class: "ptext", text: latest.text }),
          el("div", { class: "eactions" }, el("button", { class: "linkbtn", type: "button", onclick: () => showView("bulletin") }, "Open the bulletin")))
      : el("div", { class: "empty" }, el("b", { text: "Nothing posted yet" }), el("button", { class: "linkbtn", type: "button", onclick: () => showView("bulletin") }, "Write the first post")));
  }

  // schedule + RSVP
  const myRsvp = (eid) => S.me ? S.rsvps.find(r => r.event_id === eid && r.player_id === S.me.id) : null;
  let rsvpPending = null;
  function renderSchedule() {
    const box = $("#schedule"); box.replaceChildren();
    const list = S.events.filter(e => S.filter === "all" || e.type === S.filter);
    const up = list.filter(e => !isPastDay(e)).sort((a, b) => evDate(a) - evDate(b));
    const past = list.filter(isPastDay).sort((a, b) => evDate(b) - evDate(a));
    $("#nSched").textContent = up.length || "";
    if (!list.length) { box.append(el("div", { class: "empty" }, el("b", { text: "No events yet" }), isAdmin() ? "Use “Add event” for the next practice or tournament." : "Admins add practices and tournaments here.")); return; }
    if (up.length) box.append(el("h2", { text: "Coming up" }), el("div", { class: "grid" }, up.map(e => eventCard(e, false))));
    if (past.length) box.append(el("h2", { text: "Past" }), el("div", { class: "grid" }, past.slice(0, 12).map(e => eventCard(e, true))));
  }
  function mapRow(kind, addr, link) {
    if (!addr && !link) return null;
    const ext = (href, txt) => el("a", { class: "mapbtn", href, target: "_blank", rel: "noopener noreferrer" }, txt);
    return el("div", { class: "maprow" }, el("span", { class: "maplabel", text: kind }), addr ? el("span", { class: "meta", text: addr }) : null,
      addr ? ext("https://maps.apple.com/?q=" + encodeURIComponent(addr), "Apple Maps") : null,
      addr ? ext("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr), "Google Maps") : null,
      link && /^https:\/\//i.test(link) ? ext(link, "Booking ↗") : null);
  }
  function eventCard(e, isPast) {
    const d = evDate(e), mine = myRsvp(e.id), rs = S.rsvps.filter(r => r.event_id === e.id);
    const ins = rs.filter(r => r.status === "in"), outs = rs.filter(r => r.status === "out");
    const canRsvp = !!S.me && !isPast;
    const pend = rsvpPending && rsvpPending.eid === e.id;
    const shown = pend ? "out" : (mine && mine.status);
    const chip = (r) => el("span", { class: "chip" }, el("i", { class: "dot", style: "background:" + (r.status === "in" ? "var(--green)" : "var(--red)") }),
      el("span", { text: nameOf(r.player_id) + (r.status === "out" && r.reason ? " — " + r.reason : "") }));
    return el("article", { class: "event" + (isPast ? " past" : ""), "data-type": e.type },
      el("div", { class: "date" }, el("div", { class: "mo", text: MONTHS[d.getMonth()] }), el("div", { class: "d", text: d.getDate() }), el("div", { class: "wd", text: WD[d.getDay()] })),
      el("div", { class: "ebody" },
        el("div", { class: "etop" }, el("span", { class: "pill" + (e.type === "tournament" ? " t" : ""), text: e.type === "tournament" ? "Tournament" : "Practice" }),
          el("span", { class: "when", text: [rel(d), fmtTime(e.start_time)].filter(Boolean).join(" · ") })),
        el("h3", { class: "etitle", text: e.title }),
        mapRow("Field", e.location), mapRow("Stay", e.lodging, e.lodging_url),
        e.type === "practice" && e.paint_cases != null ? el("div", { class: "meta", text: "Paint to buy: " + e.paint_cases + (e.paint_cases === 1 ? " case" : " cases") }) : null,
        e.notes ? el("div", { class: "notes", text: e.notes }) : null,
        el("div", { class: "rsvp", role: "group", "aria-label": "Your RSVP" },
          [["in","I'm in"],["out","Can't make it"]].map(([v, t]) => el("button", { type: "button", "data-v": v, "aria-pressed": String(shown === v), disabled: canRsvp ? null : true, onclick: () => pickRsvp(e.id, mine, v) }, t))),
        pend ? rsvpReasonBox(e.id) : (mine && mine.status === "out" && mine.reason ? el("div", { class: "reason-text", text: "Your reason: " + mine.reason }) : null),
        el("div", { class: "tally" }, el("span", { class: "g", text: ins.length + " in" }), el("span", { class: "r", text: outs.length + " out" })),
        rs.length ? el("details", { class: "att" }, el("summary", { text: "Who's coming" }), el("div", { class: "chips" }, ins.map(chip), outs.map(chip))) : null,
        isAdmin() ? el("div", { class: "eactions" }, el("button", { class: "linkbtn", type: "button", onclick: () => openEvent(e) }, "Edit"),
          confirmBtn("Delete", "Delete this event for everyone?", async () => { const { error } = await sb.from("events").delete().eq("id", e.id); if (error) throw error; })) : null));
  }
  function pickRsvp(eid, mine, v) {
    if (v === "out") {
      if (mine && mine.status === "out" && !rsvpPending) { saveRsvp(eid, null); return; }
      rsvpPending = { eid, text: rsvpPending && rsvpPending.eid === eid ? rsvpPending.text : (mine && mine.reason) || "" }; render(); return;
    }
    rsvpPending = null; saveRsvp(eid, mine && mine.status === "in" ? null : "in");
  }
  function rsvpReasonBox(eid) {
    const inp = el("input", { id: "why-" + eid, maxlength: "200", placeholder: "Why can't you make it? (required)", value: rsvpPending.text || "" });
    const err = el("span", { class: "formerr" });
    const save = () => { const t = inp.value.trim(); if (!t) { err.textContent = "Add a reason to save this."; inp.focus(); return; } rsvpPending = null; saveRsvp(eid, "out", t); };
    inp.addEventListener("input", () => { if (rsvpPending) rsvpPending.text = inp.value; });
    inp.addEventListener("keydown", (k) => { if (k.key === "Enter") { k.preventDefault(); save(); } if (k.key === "Escape") { rsvpPending = null; render(); } });
    setTimeout(() => { if (inp.isConnected && document.activeElement !== inp) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (x) {} } }, 0);
    return el("div", { class: "reason" }, inp, el("button", { class: "btn small", type: "button", onclick: save }, "Save"),
      el("button", { class: "linkbtn", type: "button", onclick: () => { rsvpPending = null; render(); } }, "Cancel"), err);
  }
  async function saveRsvp(eid, status, reason) {
    if (!S.me) return;
    const before = S.rsvps;
    S.rsvps = S.rsvps.filter(r => !(r.event_id === eid && r.player_id === S.me.id));
    if (status) S.rsvps = [...S.rsvps, { event_id: eid, player_id: S.me.id, status, reason: status === "out" ? reason : null }];
    render();
    const q = status
      ? sb.from("rsvps").upsert({ event_id: eid, player_id: S.me.id, status, reason: status === "out" ? reason : null, updated_at: new Date().toISOString() })
      : sb.from("rsvps").delete().eq("event_id", eid).eq("player_id", S.me.id);
    const { error } = await q;
    if (error) { S.rsvps = before; render(); notice("Your RSVP didn't save. Check your connection and tap it again.", "warn"); }
  }
  function confirmBtn(txt, q, fn) {
    const wrap = el("span", { class: "confirm" });
    const ask = el("button", { class: "linkbtn", type: "button", onclick: () => {
      wrap.replaceChildren(el("span", { text: q }),
        el("button", { class: "btn small", type: "button", onclick: async () => { try { await fn(); } catch (err) { notice("That didn't go through: " + (err.message || "try again") + ".", "warn"); wrap.replaceChildren(ask); } } }, txt),
        el("button", { class: "linkbtn", type: "button", onclick: () => wrap.replaceChildren(ask) }, "Keep"));
    } }, txt);
    wrap.append(ask); return wrap;
  }

  // events (admin)
  const FIELDS = {
    wellford:   "PBC Wellford, 318 Tucapau Rd, Wellford, SC 29385",
    greensboro: "PBC Greensboro, 6106 Burlington Rd, Gibsonville, NC 27249",
    palmetto:   "Palmetto Hills Paintball, 1481 Anderson Rd S, Rock Hill, SC 29730",
  };
  function syncFieldUi() {
    const practice = $("#evType").value === "practice", f = $("#evField").value;
    $("#evPaintWrap").hidden = !practice; $("#evFieldWrap").hidden = !practice;
    $("#evLocWrap").hidden = practice && f !== "other";
    if (practice && FIELDS[f]) $("#evLoc").value = FIELDS[f];
  }
  let editingEv = null;
  function openEvent(e) {
    editingEv = e || null;
    $("#eventDlgTitle").textContent = e ? "Edit event" : "Add event";
    $("#evType").value = e ? e.type : "practice"; $("#evTitle").value = e ? e.title : "";
    $("#evDate").value = e ? e.date : ""; $("#evTime").value = e && e.start_time ? e.start_time.slice(0, 5) : "";
    $("#evLoc").value = e ? e.location || "" : ""; $("#evStay").value = e ? e.lodging || "" : ""; $("#evStayUrl").value = e ? e.lodging_url || "" : "";
    $("#evNotes").value = e ? e.notes || "" : ""; $("#evErr").textContent = "";
    $("#evPaint").value = e && e.paint_cases != null ? e.paint_cases : "";
    const known = Object.entries(FIELDS).find(([, a]) => e && e.location === a);
    $("#evField").value = e ? (known ? known[0] : (e.location ? "other" : "wellford")) : "wellford";
    syncFieldUi();
    $("#eventDlg").showModal();
  }
  $("#evType").addEventListener("change", syncFieldUi);
  $("#evField").addEventListener("change", () => { if ($("#evField").value === "other") $("#evLoc").value = ""; syncFieldUi(); });
  $("#addEvent").addEventListener("click", () => openEvent(null));
  $("#eventForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { type: $("#evType").value, title: $("#evTitle").value.trim(), date: $("#evDate").value, start_time: $("#evTime").value || null,
                   location: $("#evLoc").value.trim() || null, lodging: $("#evStay").value.trim() || null, lodging_url: $("#evStayUrl").value.trim() || null, notes: $("#evNotes").value.trim() || null };
    if (!body.title || !body.date) { $("#evErr").textContent = "Add a title and a date."; return; }
    const paint = $("#evPaint").value.trim();
    if (body.type === "practice") {
      if (paint === "") { $("#evErr").textContent = "Enter how many cases of paint to buy for this practice."; return; }
      const n = Number(paint);
      if (!Number.isInteger(n) || n < 0 || n > 500) { $("#evErr").textContent = "Cases of paint has to be a whole number."; return; }
      body.paint_cases = n;
    } else body.paint_cases = null;
    if (body.lodging_url && !/^https:\/\//i.test(body.lodging_url)) { $("#evErr").textContent = "The booking link has to start with https://"; return; }
    $("#evSave").disabled = true;
    const { error } = editingEv ? await sb.from("events").update(body).eq("id", editingEv.id)
                                : await sb.from("events").insert({ ...body, created_by: S.me && S.me.id });
    $("#evSave").disabled = false;
    if (error) { $("#evErr").textContent = "That didn't save: " + error.message; return; }
    $("#eventDlg").close(); await loadTable("events"); render();
  });

  // bulletin
  function renderPosts() {
    const box = $("#posts"); box.replaceChildren();
    $("#nPosts").textContent = S.posts.length || "";
    if (!S.posts.length) { box.append(el("div", { class: "empty" }, el("b", { text: "Nothing posted yet" }), "Post field changes, carpools, paint orders or gear swaps for the team.")); return; }
    const sorted = [...S.posts].sort((a, b) => (b.pinned - a.pinned) || (new Date(b.created_at) - new Date(a.created_at)));
    box.append(el("div", { class: "grid" }, sorted.map(p => {
      const mine = S.me && p.player_id === S.me.id;
      return el("article", { class: "post" + (p.pinned ? " pinned" : "") },
        el("div", { class: "phead" }, el("div", { class: "nm", text: nameOf(p.player_id) }), el("div", { class: "tm", text: (p.pinned ? "Pinned · " : "") + ago(p.created_at) })),
        el("div", { class: "ptext", text: p.text }),
        (isAdmin() || mine) ? el("div", { class: "eactions" },
          isAdmin() ? el("button", { class: "linkbtn", type: "button", onclick: async () => { const { error } = await sb.from("posts").update({ pinned: !p.pinned }).eq("id", p.id); if (error) notice("Couldn't change the pin.", "warn"); } }, p.pinned ? "Unpin" : "Pin") : null,
          confirmBtn("Delete", "Delete this post?", async () => { const { error } = await sb.from("posts").delete().eq("id", p.id); if (error) throw error; })) : null);
    })));
  }
  $("#postBtn").addEventListener("click", async () => {
    const text = $("#postText").value.trim();
    if (!text) { $("#postErr").textContent = "Write something first."; return; }
    if (!S.me) { $("#postErr").textContent = "Your login isn't linked to a roster spot yet."; return; }
    $("#postBtn").disabled = true; $("#postErr").textContent = "";
    const { error } = await sb.from("posts").insert({ player_id: S.me.id, text });
    $("#postBtn").disabled = false;
    if (error) { $("#postErr").textContent = "That didn't post. Try again."; return; }
    $("#postText").value = ""; await loadTable("posts"); render();
  });

  // attendance (admins)
  const rosterIds = () => Object.keys(S.players).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  function todaysEvent() {
    const t = ymd(new Date()), now = Date.now(), todays = S.events.filter(e => e.date === t);
    return todays.length ? todays.sort((a, b) => Math.abs(evDate(a) - now) - Math.abs(evDate(b) - now))[0].id : null;
  }
  function defaultAttEvent() {
    const t = todaysEvent(); if (t) return t;
    const past = S.events.filter(isPastDay).sort((a, b) => evDate(b) - evDate(a));
    return past[0] ? past[0].id : null;
  }
  let pending = null;
  function renderAttendance() {
    const admin = isAdmin(), sel = $("#attEvent"), list = $("#attList"), sum = $("#attSummary");
    if (!S.attEvent || !S.events.some(e => e.id === S.attEvent)) S.attEvent = defaultAttEvent();
    const evs = S.events.filter(e => new Date(e.date + "T00:00") <= new Date()).sort((a, b) => evDate(b) - evDate(a));
    sel.replaceChildren(...evs.map(e => el("option", { value: e.id, selected: e.id === S.attEvent ? true : null, text: evLabel(e) })));
    $("#attOther").hidden = evs.length < 2;
    const ev = S.events.find(e => e.id === S.attEvent), isToday = ev && ev.date === ymd(new Date());
    $("#attKicker").textContent = !ev || isToday ? "Today" : (todaysEvent() ? "Earlier event" : "No event today · most recent");
    $("#attTitle").textContent = ev ? ev.title + " · " + (isToday && ev.start_time ? fmtTime(ev.start_time) : evLabel(ev).split(" · ")[0]) : "No practice or tournament today";
    $("#attAll").hidden = !admin || !ev;
    renderRecord();
    if (!ev) { sum.replaceChildren(); list.replaceChildren(el("div", { class: "empty" }, el("b", { text: "Nothing to take attendance for yet" }), "Attendance opens on the day of a practice or tournament.")); return; }
    const marks = {}; S.att.filter(a => a.event_id === ev.id).forEach(a => marks[a.player_id] = a);
    const ids = rosterIds();
    const c = { present: 0, tardy: 0, absent: 0, ncns: 0 }; ids.forEach(p => { if (marks[p]) c[marks[p].mark]++; });
    sum.replaceChildren(el("span", { class: "g", text: c.present + " present" }), el("span", { class: "a", text: c.tardy + " tardy" }),
      el("span", { text: c.absent + " absent" }), el("span", { class: "r", text: c.ncns + " no call / no show" }),
      el("span", { style: "color:var(--muted)", text: (ids.length - c.present - c.tardy - c.absent - c.ncns) + " not marked" }));
    const focusReason = !!(pending && pending.eid === ev.id);
    list.replaceChildren(...(!admin ? [el("div", { class: "notice", text: "Only admins take attendance. You can see the results here." })] : []), ...ids.map(pid => {
      const r = S.rsvps.find(x => x.event_id === ev.id && x.player_id === pid);
      const rtxt = !r ? "No RSVP" : r.status === "in" ? "RSVP: in" : "RSVP: out" + (r.reason ? " (" + r.reason + ")" : "");
      const cur = marks[pid] ? marks[pid].mark : null;
      const pend = pending && pending.eid === ev.id && pending.pid === pid ? pending : null;
      const shown = pend ? pend.m : cur;
      const row = el("div", { class: "attrow" },
        el("div", { class: "who2" }, el("b", { text: nameOf(pid) }), el("span", { class: "rs", text: rtxt })),
        admin ? el("div", { class: "marks", role: "group", "aria-label": "Attendance for " + nameOf(pid) },
          MARKS.map(([m, t]) => el("button", { type: "button", "data-m": m, "aria-pressed": String(shown === m), onclick: () => pickMark(ev.id, pid, cur, m) }, t)))
          : el("span", { class: "mark-badge", text: cur ? MARKS.find(x => x[0] === cur)[1] : "Not marked" }));
      if (pend) {
        const inp = el("input", { id: "reason-" + pid, maxlength: "200", placeholder: "Reason (required): work, sick, car trouble, no answer…", value: pend.text || "" });
        const err = el("span", { class: "formerr" });
        const save = () => { const t = inp.value.trim(); if (!t) { err.textContent = "Add a reason to save this."; inp.focus(); return; } pending = null; saveMark(ev.id, pid, pend.m, t); };
        inp.addEventListener("input", () => { pend.text = inp.value; });
        inp.addEventListener("keydown", (k) => { if (k.key === "Enter") { k.preventDefault(); save(); } if (k.key === "Escape") { pending = null; render(); } });
        row.append(el("div", { class: "reason" }, inp, el("button", { class: "btn small", type: "button", onclick: save }, "Save"),
          el("button", { class: "linkbtn", type: "button", onclick: () => { pending = null; render(); } }, "Cancel"), err));
        if (focusReason) setTimeout(() => { if (inp.isConnected && document.activeElement !== inp) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (x) {} } }, 0);
      } else if (marks[pid] && marks[pid].mark !== "present" && marks[pid].reason) {
        row.append(el("div", { class: "reason-text", text: "Reason: " + marks[pid].reason }));
      }
      return row;
    }));
  }
  function renderRecord() {
    const rec = $("#attRecord"); rec.replaceChildren();
    const ids = rosterIds(), taken = new Set(S.att.map(a => a.event_id));
    if (!ids.length || !taken.size) { rec.append(el("div", { class: "empty" }, el("b", { text: "No attendance taken yet" }), "Each player's totals build up here as admins take attendance.")); return; }
    const rows = ids.map(pid => { const c = { present: 0, tardy: 0, absent: 0, ncns: 0 }; S.att.filter(a => a.player_id === pid).forEach(a => c[a.mark]++);
      const n = c.present + c.tardy + c.absent + c.ncns; return { pid, c, pct: n ? Math.round(100 * (c.present + c.tardy) / n) : null }; })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || nameOf(a.pid).localeCompare(nameOf(b.pid)));
    rec.append(el("div", { class: "tablewrap" }, el("table", { class: "rec" },
      el("thead", {}, el("tr", {}, ["Player","Present","Tardy","Absent","No call / no show","Showed up"].map(h => el("th", { text: h })))),
      el("tbody", {}, rows.map(r => el("tr", {}, el("td", { text: nameOf(r.pid) }), el("td", { text: r.c.present }), el("td", { text: r.c.tardy }),
        el("td", { text: r.c.absent }), el("td", { text: r.c.ncns }), el("td", { text: r.pct == null ? "–" : r.pct + "%" })))))),
      el("div", { class: "meta", style: "margin-top:6px", text: "Across " + taken.size + " event" + (taken.size === 1 ? "" : "s") + " with attendance taken. “Showed up” counts present and tardy." }));
  }
  function pickMark(eid, pid, cur, m) {
    if (!isAdmin()) return;
    if (cur === m && !(pending && pending.pid === pid)) { pending = null; saveMark(eid, pid, null); return; }
    if (m !== "present") { pending = { eid, pid, m, text: pending && pending.pid === pid ? pending.text : "" }; render(); return; }
    pending = null; saveMark(eid, pid, m);
  }
  async function saveMark(eid, pid, mark, reason) {
    const before = S.att;
    S.att = S.att.filter(a => !(a.event_id === eid && a.player_id === pid));
    if (mark) S.att = [...S.att, { event_id: eid, player_id: pid, mark, reason: mark === "present" ? null : reason }];
    render();
    const q = mark ? sb.from("attendance").upsert({ event_id: eid, player_id: pid, mark, reason: mark === "present" ? null : reason, marked_by: S.me && S.me.id, updated_at: new Date().toISOString() })
                   : sb.from("attendance").delete().eq("event_id", eid).eq("player_id", pid);
    const { error } = await q;
    if (error) { S.att = before; render(); notice("That attendance mark didn't save. Tap it again.", "warn"); }
  }
  $("#attEvent").addEventListener("change", (e) => { S.attEvent = e.target.value; pending = null; render(); });
  $("#attAll").addEventListener("click", async () => {
    if (!isAdmin() || !S.attEvent) return;
    const have = new Set(S.att.filter(a => a.event_id === S.attEvent).map(a => a.player_id));
    const rows = rosterIds().filter(pid => !have.has(pid) && !(pending && pending.pid === pid))
      .map(pid => ({ event_id: S.attEvent, player_id: pid, mark: "present", reason: null, marked_by: S.me && S.me.id }));
    if (!rows.length) return;
    const { error } = await sb.from("attendance").upsert(rows);
    if (error) notice("Attendance didn't save. Try again.", "warn");
    await loadTable("attendance"); render();
  });

  // roster
  function renderRoster() {
    const box = $("#roster"); box.replaceChildren();
    const ids = rosterIds(), admin = isAdmin();
    $("#nRoster").textContent = ids.length || "";
    if (!ids.length) { box.append(el("div", { class: "empty" }, el("b", { text: "No one on the roster yet" }), admin ? "Use “Add player” to start the team list." : "Admins add players here.")); return; }
    const upcoming = S.events.filter(e => !isPastDay(e)).map(e => e.id);
    const sorted = [...ids].sort((a, b) => (S.players[a].role === "admin" ? 0 : 1) - (S.players[b].role === "admin" ? 0 : 1) || nameOf(a).localeCompare(nameOf(b)));
    box.append(el("div", { class: "grid" }, sorted.map(pid => {
      const p = S.players[pid], phone = admin ? S.phones[pid] : null;
      const marks = S.att.filter(a => a.player_id === pid), ok = marks.filter(a => a.mark === "present" || a.mark === "tardy").length;
      const pct = marks.length ? Math.round(100 * ok / marks.length) : null;
      const ins = upcoming.filter(eid => S.rsvps.some(r => r.event_id === eid && r.player_id === pid && r.status === "in")).length;
      const sub = [p.pb_id ? "PBL #" + p.pb_id : null, p.username ? "@" + p.username : "No login yet", upcoming.length ? ins + " of " + upcoming.length + " upcoming" : null].filter(Boolean).join(" · ");
      const missing = admin ? [p.user_id ? null : "login", phone ? null : "cellphone", p.pb_id ? null : "PBLeagues ID"].filter(Boolean) : [];
      const link = /^https:\/\//i.test(p.pb_url || "") ? p.pb_url : (S.me && pid === S.me.id ? "https://pbleagues.com/profile" : null);
      return el("article", { class: "player" + (p.role === "admin" ? " admin" : "") },
        el("div", { class: "pn" }, p.name + (S.me && pid === S.me.id ? " (you)" : ""), p.role === "admin" ? el("span", { class: "roletag", text: "Admin" }) : null),
        el("div", { class: "pp", text: sub }),
        phone ? el("div", { class: "pp", text: "Cell " + phone }) : null,
        missing.length ? el("div", { class: "warnline", text: "Missing: " + missing.join(", ") }) : null,
        el("div", { class: "attpct" + (pct == null ? "" : pct >= 80 ? " good" : pct >= 60 ? " mid" : " low") },
          el("b", { text: pct == null ? "–" : pct + "%" }), el("span", { text: pct == null ? " attendance · none taken yet" : " attendance · " + marks.length + " event" + (marks.length === 1 ? "" : "s") })),
        (p.pb_class || link) ? el("div", { class: "pb" }, el("div", { class: "stat" }, el("small", { text: "PBL class" }), el("b", { text: p.pb_class || "–" })),
          link ? el("a", { class: "pbbtn", href: link, target: "_blank", rel: "noopener noreferrer" }, "PBLeagues ↗") : null) : null,
        admin ? el("div", { class: "pa" },
          el("button", { class: "linkbtn", type: "button", onclick: () => openPlayer(pid) }, "Edit"),
          p.user_id ? el("button", { class: "linkbtn", type: "button", onclick: () => openPw(pid, "reset") }, "Reset password")
                    : el("button", { class: "linkbtn", type: "button", onclick: () => openPw(pid, "create") }, "Create login"),
          p.user_id && !(S.me && pid === S.me.id) ? confirmBtn("Remove login", "Remove " + p.name + "'s login? Their history stays.", async () => { await adminCall({ action: "remove_login", player_id: pid }); await loadTable("players"); render(); }) : null,
          !(S.me && pid === S.me.id) ? confirmBtn("Remove player", "Remove " + p.name + " and their login?", async () => {
            if (p.user_id) await adminCall({ action: "remove_login", player_id: pid });
            const { error } = await sb.from("players").delete().eq("id", pid); if (error) throw error; await loadTable("players"); render(); }) : null)
        : (S.me && pid === S.me.id ? el("div", { class: "pa" }, el("button", { class: "linkbtn", type: "button", onclick: () => openPlayer(pid) }, "Edit my PBLeagues info")) : null));
    })));
  }

  // add / edit player
  let editingPl = null;
  function openPlayer(pid) {
    editingPl = pid || null; const p = pid ? S.players[pid] : {}, admin = isAdmin();
    $("#plDlgTitle").textContent = pid ? (admin ? "Edit player" : "My PBLeagues info") : "Add player";
    $("#plName").value = p.name || ""; $("#plName").disabled = !admin;
    $("#plLoginFields").hidden = !!pid;
    $("#plUser").value = ""; $("#plPass").value = pid ? "" : genPassword();
    $("#plPhone").value = (pid && S.phones[pid]) || ""; $("#plPhoneWrap").hidden = !admin;
    $("#plPbId").value = p.pb_id || ""; $("#plPbClass").value = p.pb_class || ""; $("#plPbUrl").value = p.pb_url || "";
    $("#plRole").value = p.role || "player"; $("#plRoleWrap").hidden = !admin; $("#plErr").textContent = "";
    $("#plDlg").showModal();
  }
  $("#plGen").addEventListener("click", () => { $("#plPass").value = genPassword(); });
  $("#addPlayer").addEventListener("click", () => openPlayer(null));
  $("#plForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = (m) => { $("#plErr").textContent = m; };
    const name = $("#plName").value.trim(), phone = $("#plPhone").value.trim(), pbId = $("#plPbId").value.trim();
    const pbClass = $("#plPbClass").value.trim(), pbUrl = $("#plPbUrl").value.trim(), role = $("#plRole").value;
    if (pbUrl && !/^https:\/\//i.test(pbUrl)) return err("The PBLeagues link has to start with https://");
    if (pbId && !/^\d[\d-]{2,11}$/.test(pbId)) return err("PBLeagues IDs are numbers, like 1234-5678.");
    const admin = isAdmin();
    if (admin) {
      if (!name) return err("Add a name.");
      const digits = phone.replace(/\D/g, "");
      if (!editingPl && !phone) return err("Add their cellphone.");
      if (phone && (digits.length < 10 || digits.length > 15)) return err("Enter a full cellphone number, area code included.");
    }
    if (!editingPl && !pbId) return err("Add their PBLeagues ID.");
    $("#plSave").disabled = true;
    try {
      if (!editingPl) {
        const username = $("#plUser").value.trim().toLowerCase(), password = $("#plPass").value;
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error("Usernames are 3-30 letters, numbers, dots, dashes or underscores.");
        if (password.length < 8) throw new Error("Starting passwords need at least 8 characters.");
        await adminCall({ action: "create", name, username, password, phone, role, pb_id: pbId, pb_class: pbClass, pb_url: pbUrl });
        $("#plDlg").close(); await loadTable("players"); await loadTable("player_private"); render();
        showLoginText(name, username, password, phone);
      } else {
        const body = { pb_id: pbId || null, pb_class: pbClass || null, pb_url: pbUrl || null };
        if (admin) Object.assign(body, { name, role });
        const { error } = await sb.from("players").update(body).eq("id", editingPl);
        if (error) throw error;
        if (admin && phone !== (S.phones[editingPl] || "")) {
          const r = phone ? await sb.from("player_private").upsert({ player_id: editingPl, phone }) : await sb.from("player_private").delete().eq("player_id", editingPl);
          if (r.error) throw r.error;
        }
        $("#plDlg").close(); await loadTable("players"); await loadTable("player_private"); render();
      }
    } catch (e) { err(e.message || "That didn't save. Try again."); }
    finally { $("#plSave").disabled = false; }
  });

  // create login for an existing roster spot / reset password
  let pwFor = null, pwMode = "create";
  function openPw(pid, mode) {
    pwFor = pid; pwMode = mode; const p = S.players[pid];
    $("#pwTitle").textContent = mode === "create" ? "Create login" : "Reset password";
    $("#pwFor").textContent = p.name + (mode === "reset" && p.username ? " · username " + p.username : "");
    $("#pwUserWrap").hidden = mode !== "create"; $("#pwUser").value = "";
    $("#pwPhoneWrap").hidden = mode !== "create" || !!S.phones[pid]; $("#pwPhone").value = S.phones[pid] || "";
    $("#pwPass").value = genPassword(); $("#pwErr").textContent = "";
    $("#pwDlg").showModal();
  }
  $("#pwGen").addEventListener("click", () => { $("#pwPass").value = genPassword(); });
  $("#pwForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const p = S.players[pwFor], password = $("#pwPass").value;
    if (password.length < 8) { $("#pwErr").textContent = "Passwords need at least 8 characters."; return; }
    $("#pwSave").disabled = true; $("#pwErr").textContent = "";
    try {
      let username = p.username, phone = S.phones[pwFor] || $("#pwPhone").value.trim();
      if (pwMode === "create") {
        username = $("#pwUser").value.trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error("Usernames are 3-30 letters, numbers, dots, dashes or underscores.");
        await adminCall({ action: "create", player_id: pwFor, username, password, phone });
      } else {
        await adminCall({ action: "set_password", player_id: pwFor, password });
      }
      $("#pwDlg").close(); await loadTable("players"); await loadTable("player_private"); render();
      showLoginText(p.name, username, password, phone);
    } catch (e) { $("#pwErr").textContent = e.message || "That didn't save."; }
    finally { $("#pwSave").disabled = false; }
  });
})();
