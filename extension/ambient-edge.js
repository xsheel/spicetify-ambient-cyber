// ambient-edge.js — cyberpunk edge lights synced to the music
//   • hairline neon line circling the window edge
//   • travelling light streaks that speed up with loudness and kick on beats
//   • whole-edge flash on every beat (bigger on each bar's downbeat)
//   • EQ bars along the bottom edge driven by Spotify's pitch + loudness analysis
//   • album covers glow in their own colours and pulse on the beat
//   • sends colours + beat timeline to the optional macOS desktop glow app (glow-app/)
(function ambientEdge() {
  const S = window.Spicetify;
  if (!S || !S.Player || !S.Player.addEventListener || !S.getAudioData || !document.body) {
    return setTimeout(ambientEdge, 300);
  }
  const LATENCY = 0.0;   // seconds; raise (e.g. 0.08) if flashes feel early, lower if late
  const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb; } };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.id = "ambient-edge";
  const mk = (name, withSpin) => {
    const layer = document.createElement("div");
    layer.className = "ae-layer ae-" + name;
    let spin = null;
    if (withSpin) {
      const mask = document.createElement("div"); mask.className = "ae-mask";
      spin = document.createElement("div"); spin.className = "ae-spin";
      mask.appendChild(spin); layer.appendChild(mask);
    }
    root.appendChild(layer);
    return { layer, spin };
  };
  const comet = mk("comet", true), core = mk("core", true), pulseL = mk("pulse", false);
  const canvas = document.createElement("canvas");
  canvas.className = "ae-bars";
  root.appendChild(canvas);
  document.body.appendChild(root);
  const ctx = canvas.getContext("2d");
  const BAR_H = 14;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(BAR_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize); resize();

  // ---------- neon palette from album art ----------
  const rgbToHsv = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  };
  const hsvToRgb = (h, s, v) => {
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
    return [f(5), f(3), f(1)];
  };
  const neon = ([h, s]) => hsvToRgb(h, clamp(s * 1.4, 0.75, 1), 1);   // fully saturated & bright
  const CYBER = [[187, 1, 1], [342, 0.84, 1], [275, 0.7, 1], [57, 0.99, 0.98]]; // cyan, pink, violet, yellow

  const loadImage = (url) => new Promise((res) => {
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => res(img); img.onerror = () => res(null); img.src = url;
  });
  async function paletteFrom(url) {
    const img = await loadImage(url);
    if (!img) return null;
    const N = 32, c = document.createElement("canvas"); c.width = c.height = N;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data;
    const bins = Array.from({ length: 18 }, () => ({ w: 0, h: 0, s: 0 }));
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
      if (s < 0.2 || v < 0.18) continue;
      const b = bins[Math.floor(h / 20) % 18], w = s * v;
      b.w += w; b.h += h * w; b.s += s * w;
    }
    const picks = bins.filter((b) => b.w > 0.6).map((b) => ({ w: b.w, hsv: [b.h / b.w, b.s / b.w] })).sort((a, b) => b.w - a.w);
    const chosen = [];
    for (const p of picks) {
      if (chosen.every((q) => Math.min(Math.abs(q.hsv[0] - p.hsv[0]), 360 - Math.abs(q.hsv[0] - p.hsv[0])) > 30)) chosen.push(p);
      if (chosen.length === 3) break;
    }
    // fill missing slots with cyberpunk neons (so dull/grey covers still look cyber)
    let k = 0;
    while (chosen.length < 4) chosen.push({ hsv: CYBER[(k++ + (chosen.length ? 1 : 0)) % 4] });
    return chosen.map((p) => neon(p.hsv));
  }

  let pal = CYBER.map(neon), palShown = pal.map((c) => c.slice());
  const css = (c) => `rgb(${c.map(Math.round).join(",")})`;
  function setPalette(p) {
    pal = p;
    p.forEach((c, i) => root.style.setProperty("--c" + (i + 1), css(c)));
    document.documentElement.style.setProperty("--ambient-color", p[0].join(", "));
  }
  setPalette(pal);

  // ---------- per-track data: palette + Spotify's audio analysis ----------
  let A = null, currentUri = null, analysisTries = 0, nextAnalysisTry = 0;

  async function loadAnalysis(uri) {
    analysisTries++;
    nextAnalysisTry = Date.now() + 4000 * analysisTries;           // back off: 4s, 8s, 12s
    try {
      const a = await S.getAudioData(uri);
      if (currentUri !== uri || !a || !a.segments || !a.segments.length) return;
      A = {
        segs: a.segments.map((s) => ({ t: s.start, d: s.duration, l0: s.loudness_start, lm: s.loudness_max, tm: s.loudness_max_time, p: s.pitches, tb: s.timbre })),
        beats: (a.beats || []).map((b) => b.start),
        bars: (a.bars || []).map((b) => b.start),
      };
      sendTrack();
    } catch (e) { /* no analysis yet: the lights use a gentle synthetic pulse */ }
  }

  async function onTrackInner() {
    const item = S.Player.data && (S.Player.data.item || S.Player.data.track);
    if (!item || !item.uri) return;
    if (item.uri === currentUri) {
      // same song: retry the analysis a few times if it failed
      if (!A && analysisTries < 3 && Date.now() >= nextAnalysisTry) await loadAnalysis(currentUri);
      return;
    }
    const uri = (currentUri = item.uri);
    A = null; analysisTries = 0; nextAnalysisTry = 0;
    const img = item.metadata && (item.metadata.image_large_url || item.metadata.image_url);
    if (img) {
      try {
        const p = await paletteFrom(img.replace("spotify:image:", "https://i.scdn.co/image/"));
        if (p && currentUri === uri) setPalette(p);
      } catch (e) { /* cover couldn't be read: keep the previous palette */ }
    }
    if (currentUri === uri) { sendTrack(); await loadAnalysis(uri); }
  }
  const onTrack = () => onTrackInner().catch(() => {});

  // ---------- bridge to the optional macOS desktop glow app (Ambient Glow.app) ----------
  // If the app isn't running, requests fail quietly and we only retry every 15 s (no console spam).
  const GLOW_URL = "http://127.0.0.1:47823";
  let glowUp = true, glowRetryAt = 0;
  function sendGlow(path, obj) {
    if (!glowUp && Date.now() < glowRetryAt) return;
    try {
      fetch(GLOW_URL + path, { method: "POST", mode: "no-cors", body: JSON.stringify(obj) })
        .then(() => { if (!glowUp) { glowUp = true; sendTrack(); } })
        .catch(() => { glowUp = false; glowRetryAt = Date.now() + 15000; });
    } catch (e) { glowUp = false; glowRetryAt = Date.now() + 15000; }
  }
  const playState = () => ({ pos: safe(() => S.Player.getProgress(), 0) / 1000, playing: safe(() => S.Player.isPlaying(), false) });
  function sendTrack() {
    sendGlow("/track", Object.assign({
      palette: pal,
      beats: A ? A.beats : [], bars: A ? A.bars : [],
      segT: A ? A.segs.map((x) => +x.t.toFixed(3)) : [], segL: A ? A.segs.map((x) => +x.lm.toFixed(1)) : [],
    }, playState()));
  }
  setInterval(() => sendGlow("/state", playState()), 500);
  S.Player.addEventListener("onplaypause", () => setTimeout(() => sendGlow("/state", playState()), 50));
  S.Player.addEventListener("onprogress", (() => {
    let lastP = 0;
    return () => { const p = playState().pos; if (Math.abs(p - lastP) > 2) sendGlow("/state", playState()); lastP = p; };   // seeks
  })());
  setInterval(() => { if (glowUp) sendTrack(); }, 5000);   // re-sync if the glow app was (re)started after Spotify

  S.Player.addEventListener("songchange", onTrack);
  setInterval(onTrack, 1000);
  onTrack();

  // binary search: index of last element with value <= t
  const lastIdx = (arr, t, key) => {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  };
  const dbToAmp = (db) => clamp((db + 38) / 34, 0, 1);


  // ================= cover glow: album art lights up in its own colours =================
  const gCanvas = document.createElement("canvas");
  gCanvas.id = "ae-cover-glow";
  document.body.appendChild(gCanvas);
  const g = gCanvas.getContext("2d");
  let gDpr = 1;
  function gResize() {
    gDpr = window.devicePixelRatio || 1;
    gCanvas.width = Math.round(innerWidth * gDpr); gCanvas.height = Math.round(innerHeight * gDpr);
  }
  window.addEventListener("resize", gResize); gResize();

  const GS = 96, GP = 56;                       // glow texture: 96px art + 56px blur padding
  const glowCache = new Map();
  function glowFor(src) {
    if (glowCache.has(src)) return glowCache.get(src);
    const entry = { ready: false, c: null };
    glowCache.set(src, entry);
    if (glowCache.size > 60) glowCache.delete(glowCache.keys().next().value);
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = GS + GP * 2;
      const x = c.getContext("2d");
      x.filter = "blur(22px) saturate(160%)";
      x.drawImage(img, GP, GP, GS, GS);
      entry.c = c; entry.ready = true;
    };
    img.src = src;
    return entry;
  }

  // which covers glow: now-playing cover, big covers on screen, hovered card
  let targets = [], hovered = null;
  const clipCache = new WeakMap();
  const vis = new Map();                       // img -> current glow strength (for fade in/out)
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest && e.target.closest(".main-card-card, [data-testid='tracklist-row']");
    hovered = card ? card.querySelector("img") : null;
  }, true);
  document.addEventListener("mouseleave", () => { hovered = null; });
  const square = (r) => r.width > 0 && r.height / r.width > 0.8 && r.height / r.width < 1.25;
  const visible = (img) => {
    const r = img.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width < 24) return false;
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el) return false;
    const box = img.parentElement && img.parentElement.parentElement && img.parentElement.parentElement.parentElement;
    return el === img || img.contains(el) || (box && box.contains(el));
  };
  // nearest scrolling/clipping container, so glows never spill over other panels
  function clipBoxOf(img) {
    // outermost clipping container that is still a single panel (not the whole window)
    let a = img.parentElement, best = null;
    while (a && a !== document.body) {
      if (a.matches && a.matches("[data-testid='now-playing-bar'], footer")) return a;
      const cs = getComputedStyle(a), b = a.getBoundingClientRect();
      if (b.width >= innerWidth * 0.9 && b.height >= innerHeight * 0.9) break;
      if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) best = a;
      a = a.parentElement;
    }
    return best;
  }
  function pickTargets() {
    const t = [];
    const np = document.querySelector("[data-testid='now-playing-bar'] [data-testid='cover-art-container'] img, [data-testid='now-playing-widget-v2'] img, .Root__now-playing-bar img");
    if (np) t.push({ img: np, kind: "now" });
    document.querySelectorAll("img").forEach((img) => {
      if (img === np || t.length >= 9) return;
      const r = img.getBoundingClientRect();
      const header = img.classList.contains("main-entityHeader-image");
      if ((header && r.width >= 80) || (r.width >= 170 && square(r))) t.push({ img, kind: "big" });
    });
    if (hovered && hovered !== np) t.push({ img: hovered, kind: "hover" });
    targets = t.filter((x) => x.img.currentSrc && /^https?:/.test(x.img.currentSrc) && visible(x.img));
    for (const x of targets) { if (!clipCache.has(x.img)) clipCache.set(x.img, clipBoxOf(x.img)); }
  }
  setInterval(pickTargets, 200);

  const panelOf = (img) => clipCache.get(img) || null;
  function drawGlows(flash, lvl, playing, dt) {
    const W = gCanvas.width, H = gCanvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    g.setTransform(gDpr, 0, 0, gDpr, 0, 0);
    const live = new Set(targets.map((t) => t.img));
    for (const img of [...vis.keys()]) if (!live.has(img)) { const v = vis.get(img) - dt / 250; v <= 0 ? vis.delete(img) : vis.set(img, v); }
    const beat = playing ? 0.6 + 0.2 * lvl + 0.45 * flash : 0.55;
    for (const { img, kind } of targets) {
      const v = Math.min(1, (vis.get(img) || 0) + dt / 250); vis.set(img, v);
    }
    for (const [img, v] of vis) {
      const t = targets.find((x) => x.img === img); const kind = t ? t.kind : "hover";
      const e = glowFor(img.currentSrc); if (!e.ready) continue;
      const r = img.getBoundingClientRect(); if (!r.width) continue;
      // blurred copy of the art sits exactly behind the cover (slightly larger), so its colours bleed out past the edges
      const artScale = (kind === "now" ? 1.35 : 1.04) * (1 + 0.07 * flash);
      const size = ((GS + GP * 2) / GS) * r.width * artScale;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2 + r.height * 0.06;
      g.save();
      const panel = panelOf(img);
      if (panel) { const p = panel.getBoundingClientRect(); g.beginPath(); g.rect(p.left, p.top, p.width, p.height); g.clip(); }
      else if (kind !== "now") { g.restore(); continue; }
      const base = kind === "now" ? 0.9 : kind === "hover" ? 0.8 : 0.7;
      g.globalAlpha = Math.min(1, v * beat * base);
      g.drawImage(e.c, cx - size / 2, cy - size / 2, size, size);
      if (kind === "now") g.drawImage(e.c, cx - size / 2, cy - size / 2, size, size);   // small cover: denser glow
      g.restore();
      // keep the cover itself crisp: punch the glow out where the art sits
      const rad = parseFloat(getComputedStyle(img).borderRadius) || 0;
      g.save(); g.beginPath();
      if (g.roundRect) g.roundRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2, Math.min(rad, r.width / 2)); else g.rect(r.left + 1, r.top + 1, r.width - 2, r.height - 2);
      g.clip(); g.clearRect(r.left, r.top, r.width, r.height); g.restore();
    }
  }

  // ---------- animation ----------
  const NB = 56;                               // bars per half (mirrored from centre)
  const barH = new Float32Array(NB);
  let angle = 0, level = 0.3, last = performance.now(), lastBeatIdx = -1, pulseColor = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(100, now - last); last = now;
    const playing = safe(() => S.Player.isPlaying(), false);
    const pos = safe(() => S.Player.getProgress(), 0) / 1000 + LATENCY;

    let flash = 0, envelope = 0, pitches = null, timbre = null, segI = 0;
    if (A && playing) {
      // beat flash: sharp attack, ~120ms decay, measured from the exact beat time
      const bi = lastIdx(A.beats, pos);
      if (bi >= 0) {
        const since = pos - A.beats[bi];
        const isDown = A.bars.length && Math.abs(A.bars[Math.max(0, lastIdx(A.bars, pos))] - A.beats[bi]) < 0.05;
        flash = Math.exp(-since / (isDown ? 0.18 : 0.11)) * (isDown ? 1 : 0.7);
        if (bi !== lastBeatIdx) { lastBeatIdx = bi; pulseColor = (pulseColor + 1) % 4; root.style.setProperty("--cp", css(pal[pulseColor])); }
      }
      // loudness envelope inside the current segment
      segI = Math.max(0, lastIdx(A.segs, pos, "t"));
      const s = A.segs[segI], nxt = A.segs[segI + 1];
      const tIn = pos - s.t;
      let db;
      if (tIn < s.tm) db = s.l0 + (s.lm - s.l0) * (tIn / Math.max(0.001, s.tm));
      else { const endDb = nxt ? nxt.l0 : -60; db = s.lm + (endDb - s.lm) * clamp((tIn - s.tm) / Math.max(0.001, s.d - s.tm), 0, 1); }
      envelope = dbToAmp(db);
      pitches = s.p; timbre = s.tb;
    } else if (playing) {
      const ph = (pos * 2) % 1;                // fallback ~120 BPM
      flash = Math.exp(-ph / 0.11) * 0.6;
      envelope = 0.5 + 0.2 * Math.sin(pos * 3);
    }
    level += ((playing ? envelope : 0.08) - level) * Math.min(1, dt / 120);

    // palette easing for the canvas (CSS layers ease via @property transitions)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) palShown[i][j] += (pal[i][j] - palShown[i][j]) * Math.min(1, dt / 400);

    // motion: always moving, faster when loud, kicked forward on beats
    const speed = playing ? 25 + 90 * level + 220 * flash : 8;    // deg / s
    angle = (angle + (speed * dt) / 1000) % 360;
    comet.spin.style.transform = `rotate(${angle}deg)`;
    core.spin.style.transform = `rotate(${-angle * 0.5}deg)`;
    comet.layer.style.opacity = (playing ? 0.35 + 0.4 * level + 0.35 * flash : 0.3).toFixed(3);
    core.layer.style.opacity = (playing ? 0.55 + 0.25 * level + 0.2 * flash : 0.45).toFixed(3);
    pulseL.layer.style.opacity = (flash * 0.9).toFixed(3);

    // EQ bars
    const W = window.innerWidth, half = W / 2, step = half / NB, bw = Math.max(1, step * 0.3);
    ctx.clearRect(0, 0, W, BAR_H);
    for (let i = 0; i < NB; i++) {
      let target = 0;
      if (pitches) {
        const f = (i / NB) * 11, a = Math.floor(f), b = Math.min(11, a + 1), fr = f - a;
        const p = pitches[a] * (1 - fr) + pitches[b] * fr;
        const tv = timbre ? 0.75 + 0.25 * Math.sin(i * 1.3 + timbre[(i + segI) % 12] * 0.05) : 1;
        target = clamp(envelope * (0.25 + 0.75 * p) * tv + flash * 0.12 * (1 - i / NB), 0, 1);
      } else if (playing) {
        target = clamp(envelope * (0.4 + 0.4 * Math.sin(i * 0.7 + pos * 6)) + flash * 0.2, 0, 1);
      }
      barH[i] += (target - barH[i]) * (target > barH[i] ? 0.55 : Math.min(1, dt / 160)); // fast up, smooth fall
      const h = 0.5 + barH[i] * (BAR_H - 2);
      const t = i / (NB - 1), seg = t * 3, si = Math.min(2, Math.floor(seg)), sf = seg - si;
      const c = palShown[si].map((v, j) => v + (palShown[si + 1][j] - v) * sf);
      ctx.fillStyle = `rgba(${c.map(Math.round).join(",")},${0.12 + 0.43 * barH[i]})`;
      ctx.fillRect(half + i * step, BAR_H - h, bw, h);
      ctx.fillRect(half - (i + 1) * step + (step - bw), BAR_H - h, bw, h);
    }
    drawGlows(flash, level, playing, dt);
  }
  requestAnimationFrame(frame);
})();
