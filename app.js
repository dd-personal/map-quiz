(() => {
  // ---- CONFIG ----
  const QUIZZES = {
    map1: { id: "map1", tabId: "tabMap1", label: "Map Quiz", mapFile: "map.png", hotspotsFile: "hotspots.json" },
    map2: { id: "map2", tabId: "tabMap2", label: "Beat/Radio Quiz", mapFile: "map2.png", hotspotsFile: "hotspots2.json" },
    // Add your new map image + hotspot file here
    map3: { id: "map3", tabId: "tabMap3", label: "Map 3", mapFile: "map3.png", hotspotsFile: "hotspots3.json" }
  };
  let activeQuizId = "map1";
  const mapUrl = () => new URL(QUIZZES[activeQuizId].mapFile, window.location.href).toString();
  const hotspotsUrl = () => new URL(QUIZZES[activeQuizId].hotspotsFile, window.location.href).toString();


  // How close the cursor must be to a route to hover/highlight/click it (in pixels on the canvas)
  const ROUTE_HIT_TOL = 14;
  const TOUCH_ROUTE_HIT_TOL = 24;
  const MOBILE_BREAKPOINT = 900;

  // ---------- storage ----------
  const lsKey = (kind) => `mapQuiz.${activeQuizId}.${kind}.v1`;

  const UI_KEYS = {
    sidebarCollapsed: "mapQuiz.sidebarCollapsed.v1"
  };


  // ---------- legal quiz ----------
  const LEGAL_DATA_FILE = "legal_elements.json";
  const LEGAL_STORAGE_KEY = "mapQuiz.legal.completed.v1";

  let legalActive = false;
  let legalDataset = [];
  let legalCurrent = null; // {id, statute, title, definition, elements[]}
  let legalRevealAll = false;
  let legalSolved = false;

  // Per-current-crime render cache: [{ original, maskedHtml, missingWords, missingFullText }]
  let legalRender = [];
  let legalDraftAnswers = [];
  let legalLastCheckResults = [];

  const STOPWORDS = new Set([
    "a","an","the","and","or","but","if","then","than","to","of","in","on","at","by","for","from","with","without",
    "is","are","was","were","be","been","being","as","into","over","under","while","during","within","that","this",
    "these","those","any","all","no","not","nor"
  ]);

  function normalizeText(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function tokenizeWords(s) {
    const raw = (s || "").match(/[A-Za-z0-9']+/g) || [];
    return raw.map(w => w);
  }

  function chooseKeyWordIndexes(words) {
    // Prioritize non-stopwords and longer tokens
    const scored = words
      .map((w, i) => {
        const lw = w.toLowerCase();
        const isStop = STOPWORDS.has(lw);
        const len = w.replace(/[^A-Za-z0-9]/g, "").length;
        const score = (isStop ? 0 : 100) + Math.min(len, 12);
        return { i, w, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.map(x => x.i);
  }

  function maskElementText(elementText, level) {
    const words = tokenizeWords(elementText);
    if (words.length === 0) {
      return { masked: elementText, missingWords: [], missingFullText: false };
    }

    // Level behavior:
    // 1: hide 1 key word (or 2 if there are many words)
    // 2: hide ~half of key words (but never all)
    // 3: hide all words (full recall)
    if (level >= 3) {
      const blanks = words.map(() => "____");
      return { masked: blanks.join(" "), missingWords: words.slice(), missingFullText: true };
    }

    const keyIdx = chooseKeyWordIndexes(words);
    let hideCount = 1;
    if (level === 1) {
      hideCount = words.length >= 6 ? 2 : 1;
    } else if (level === 2) {
      hideCount = Math.max(2, Math.round(words.length * 0.5));
      hideCount = Math.min(hideCount, Math.max(1, words.length - 1)); // never all
    }

    const hideSet = new Set(keyIdx.slice(0, hideCount));
    const missingWords = [];
    const maskedWords = words.map((w, idx) => {
      if (hideSet.has(idx)) {
        missingWords.push(w);
        return "____";
      }
      return w;
    });

    return { masked: maskedWords.join(" "), missingWords, missingFullText: false };
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  function loadLegalCompletedSet() {
    try {
      const raw = localStorage.getItem(LEGAL_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function saveLegalCompletedSet(set) {
    try {
      localStorage.setItem(LEGAL_STORAGE_KEY, JSON.stringify(Array.from(set)));
    } catch {}
  }

  function clearLegalCompletedSet() {
    try {
      localStorage.removeItem(LEGAL_STORAGE_KEY);
    } catch {}
  }

  function resetLegalAttemptState() {
    legalDraftAnswers = [];
    legalLastCheckResults = [];
  }

  function extractPrimaryStatuteRef(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const match = raw.match(/\d{3}\.\d+(?:\([A-Za-z0-9]+\))*/);
    return match ? match[0] : "";
  }

  function buildLegalElementsUrl(entry) {
    const ref = extractPrimaryStatuteRef(entry?.statute || entry?.id || "");
    if (!ref) return "";

    const match = ref.match(/^(\d{3})\.(\d+)(.*)$/);
    if (!match) return "";

    const [, chapter, section, remainder] = match;
    const subsectionMatches = Array.from(remainder.matchAll(/\(([^)]+)\)/g)).map((m) => m[1]);

    // Wisconsin Law Library anchor pattern examples:
    // 940.01(1)     -> elements-940.html#01-1
    // 940.01(1)(a)  -> elements-940.html#01-1a
    // 940.09(1g)(a) -> elements-940.html#09-1ga
    // 961.41(3g)    -> elements-961.html#41-3g
    const fragment = subsectionMatches.length
      ? `${section}-${subsectionMatches[0]}${subsectionMatches.slice(1).join("")}`
      : section;

    return `https://wilawlibrary.gov/elements/elements-${chapter}.html#${fragment}`;
  }


  // Zoom behavior (scroll wheel)
  const WRAP_PAD = 12;
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 6;
  const ZOOM_STEP_IN = 1.12;
  const ZOOM_STEP_OUT = 1 / ZOOM_STEP_IN;

  // Drag-to-pan (quiz mode)
  const PAN_THRESHOLD_PX = 4;
  const pan = {
    active: false,
    moved: false,
    startClientX: 0,
    startClientY: 0,
    startScrollLeft: 0,
    startScrollTop: 0,
  };

  const touchNav = {
    active: false,
    moved: false,
    pinchActive: false,
    startClientX: 0,
    startClientY: 0,
    startScrollLeft: 0,
    startScrollTop: 0,
    pinchStartDist: 0,
    pinchStartZoom: 1
  };

  let suppressMouseUntil = 0;

  // ---------- state ----------
  const state = {
    mode: "quiz",          // "quiz" | "edit"
    tool: "circle",        // "circle" | "rect" | "route"
    showHotspots: false,
    img: null,
    imgLoaded: false,
    imgLoading: true,
    imgLoadError: null,
    targets: [],
    selectedId: null,
    hoverId: null,         // hovered target id (quiz)
    stats: { correct: 0, attempted: 0 },
    answeredIds: new Set(),
    attemptsById: {},
    rectDrag: null,
    routeDraft: null,      // { points: [{x,y},...]} while drawing a route in edit mode
    zoom: 1,               // scroll-wheel zoom multiplier
    fitScale: 1            // auto-fit scale based on viewport
  };

  // ---------- dom ----------
  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");

  const canvasWrap = document.getElementById("canvasWrap");
  const toggleSidebarBtn = document.getElementById("toggleSidebar");
  const routeHoverTip = document.getElementById("routeHoverTip");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  const mapZoomInBtn = document.getElementById("mapZoomIn");
  const mapZoomOutBtn = document.getElementById("mapZoomOut");
  const mapZoomResetBtn = document.getElementById("mapZoomReset");

  // Tabs (multi-map)
  const tabMap1Btn = document.getElementById("tabMap1");
  const tabMap2Btn = document.getElementById("tabMap2");
  const tabMap3Btn = document.getElementById("tabMap3");

  const tabLegalBtn = document.getElementById("tabLegal");

  // Legal elements panel (separate from map quizzes)
  const legalCard = document.getElementById("legalCard");
  const legalDifficultySel = document.getElementById("legalDifficulty");
  const legalNextBtn = document.getElementById("legalNextBtn");
  const legalRevealBtn = document.getElementById("legalRevealBtn");
  const legalClearProgressBtn = document.getElementById("legalClearProgressBtn");
  const legalExportBtn = document.getElementById("legalExportBtn");
  const legalImportFile = document.getElementById("legalImportFile");
  const legalImportBtn = document.getElementById("legalImportBtn");
  const legalDatasetLine = document.getElementById("legalDatasetLine");
  const legalProgressLine = document.getElementById("legalProgressLine");

  const legalQuizPanel = document.getElementById("legalQuizPanel");
  const legalCrimeTitleEl = document.getElementById("legalCrimeTitle");
  const legalCrimeStatuteEl = document.getElementById("legalCrimeStatute");
  const legalCrimeDefEl = document.getElementById("legalCrimeDefinition");
  const legalElementsListEl = document.getElementById("legalElementsList");
  const legalSubmitBtn = document.getElementById("legalSubmitBtn");
  const legalAnotherBtn = document.getElementById("legalAnotherBtn");
  const legalFeedbackEl = document.getElementById("legalFeedback");



  const imgStatus = document.getElementById("imgStatus");
  const modePill = document.getElementById("modePill");
  const toggleModeBtn = document.getElementById("toggleMode");
  const editCard = document.getElementById("editCard");

  const clearProgressBtn = document.getElementById("clearProgress");

  const scoreLine = document.getElementById("scoreLine");
  const accuracyPill = document.getElementById("accuracyPill");

  const revealAllBtn = document.getElementById("revealAll");
  const hideAllBtn = document.getElementById("hideAll");

  const toolPill = document.getElementById("toolPill");
  const toggleToolBtn = document.getElementById("toggleTool");
  const routeStatus = document.getElementById("routeStatus");
  const finishRouteBtn = document.getElementById("finishRoute");
  const cancelRouteBtn = document.getElementById("cancelRoute");

  const answerInput = document.getElementById("answerInput");
  const aliasesInput = document.getElementById("aliasesInput");
  const radiusInput = document.getElementById("radiusInput");
  const shapeSelect = document.getElementById("shapeSelect");

  const saveSelectedBtn = document.getElementById("saveSelected");
  const deleteSelectedBtn = document.getElementById("deleteSelected");

  const targetsList = document.getElementById("targetsList");
  const exportTargetsBtn = document.getElementById("exportTargets");
  const importTargetsFile = document.getElementById("importTargets");
  const importBtn = document.getElementById("importBtn");

  // ---------- helpers ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function isMobileLayout() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function isCoarsePointerDevice() {
    return !!(window.matchMedia && (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches));
  }

  function useTouchFriendlyUi() {
    return isMobileLayout() || isCoarsePointerDevice();
  }

  function getRouteHitTolerance() {
    return useTouchFriendlyUi() ? TOUCH_ROUTE_HIT_TOL : ROUTE_HIT_TOL;
  }

  function noteTouchInteraction() {
    suppressMouseUntil = Date.now() + 800;
  }

  function shouldIgnoreMouse() {
    return Date.now() < suppressMouseUntil;
  }

  function showRouteHoverTip(target, clientX, clientY) {
    if (!routeHoverTip || !target) return;
    const answered = state.answeredIds.has(target.id);
    const label = answered ? (target.answer || "") : "?";
    if (!label) return;

    routeHoverTip.textContent = label;
    routeHoverTip.classList.toggle("answered", answered);

    if (useTouchFriendlyUi()) {
      routeHoverTip.style.left = "50%";
      routeHoverTip.style.top = (window.innerHeight - 18) + "px";
      routeHoverTip.style.opacity = "1";
      routeHoverTip.style.transform = "translate(-50%, -100%)";
      return;
    }

    routeHoverTip.style.left = clientX + "px";
    routeHoverTip.style.top = clientY + "px";
    routeHoverTip.style.opacity = "1";
    routeHoverTip.style.transform = "translate(-50%, -130%)";
  }

  function hideRouteHoverTip() {
    if (!routeHoverTip) return;
    routeHoverTip.style.opacity = "0";
    routeHoverTip.style.transform = "translate(-50%, -110%)";
  }


  // ---------- zoom + sidebar UI helpers ----------
  function computeFitScale() {
    if (!state.imgLoaded || !state.img) return 1;
    const availW = Math.max(50, canvasWrap.clientWidth - WRAP_PAD * 2);
    const availH = Math.max(50, canvasWrap.clientHeight - WRAP_PAD * 2);
    const s = Math.min(availW / state.img.naturalWidth, availH / state.img.naturalHeight);
    // don't auto-scale up; user can zoom in with wheel
    return Math.min(1, s);
  }

  function applyCanvasDisplaySize() {
    if (!state.imgLoaded || !state.img) return;
    state.fitScale = computeFitScale();
    const scale = state.fitScale * state.zoom;

    const w = Math.round(state.img.naturalWidth * scale);
    const h = Math.round(state.img.naturalHeight * scale);

    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }

  function setZoom(newZoom, anchorClientX, anchorClientY) {
    if (!state.imgLoaded || !state.img) return;

    const oldZoom = state.zoom;
    newZoom = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(newZoom - oldZoom) < 0.0001) return;

    const oldScale = (state.fitScale * oldZoom) || 1;

    const rect = canvasWrap.getBoundingClientRect();
    const mx = (anchorClientX - rect.left) - WRAP_PAD;
    const my = (anchorClientY - rect.top) - WRAP_PAD;

    const worldX = (canvasWrap.scrollLeft + mx) / oldScale;
    const worldY = (canvasWrap.scrollTop + my) / oldScale;

    state.zoom = newZoom;
    applyCanvasDisplaySize();

    const newScale = (state.fitScale * newZoom) || 1;
    canvasWrap.scrollLeft = worldX * newScale - mx;
    canvasWrap.scrollTop = worldY * newScale - my;

    render();
  }

  function setSidebarCollapsed(collapsed) {
    localStorage.setItem(UI_KEYS.sidebarCollapsed, collapsed ? "1" : "0");

    if (isMobileLayout()) {
      document.body.classList.add("sidebar-collapsed");
      document.body.classList.toggle("mobile-sidebar-open", !collapsed);
      if (toggleSidebarBtn) toggleSidebarBtn.textContent = collapsed ? "☰" : "×";
    } else {
      document.body.classList.remove("mobile-sidebar-open");
      document.body.classList.toggle("sidebar-collapsed", collapsed);
      if (toggleSidebarBtn) toggleSidebarBtn.textContent = collapsed ? "»" : "☰";
    }

    applyCanvasDisplaySize();
    render();
  }

  function syncResponsiveUi() {
    if (isMobileLayout()) {
      document.body.classList.add("sidebar-collapsed");
      if (toggleSidebarBtn) toggleSidebarBtn.textContent = document.body.classList.contains("mobile-sidebar-open") ? "×" : "☰";
    } else {
      const collapsed = localStorage.getItem(UI_KEYS.sidebarCollapsed) === "1";
      document.body.classList.remove("mobile-sidebar-open");
      document.body.classList.toggle("sidebar-collapsed", collapsed);
      if (toggleSidebarBtn) toggleSidebarBtn.textContent = collapsed ? "»" : "☰";
    }

    if (mapZoomInBtn?.parentElement) {
      mapZoomInBtn.parentElement.style.display = (!legalActive && useTouchFriendlyUi()) ? "flex" : "none";
    }
  }

  function normStr(s) {
    return (s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[’']/g, "'")
      .replace(/[^\w\s\-'.]/g, "");
  }

  function escapeHtml(s) {
    return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function getCanvasPointFromClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function getCanvasPoint(evt) {
    return getCanvasPointFromClient(evt.clientX, evt.clientY);
  }

  function getTouchDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function getTouchCenter(a, b) {
    return {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2
    };
  }

  function pointSegmentDistance(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const c1 = wx*vx + wy*vy;
    if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const c2 = vx*vx + vy*vy;
    if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
    const t = c1 / c2;
    const projx = a.x + t*vx, projy = a.y + t*vy;
    return Math.hypot(p.x - projx, p.y - projy);
  }

  function routeMinDistance(points, p) {
    if (!Array.isArray(points) || points.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const d = pointSegmentDistance(p, points[i], points[i+1]);
      if (d < best) best = d;
    }
    return best;
  }

  function routeMidpoint(points) {
    if (!Array.isArray(points) || points.length === 0) return {x: 0, y: 0};
    if (points.length === 1) return {x: points[0].x, y: points[0].y};

    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += Math.hypot(points[i+1].x - points[i].x, points[i+1].y - points[i].y);
    }
    if (total <= 0) return {x: points[0].x, y: points[0].y};

    const half = total / 2;
    let acc = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i+1];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + seg >= half) {
        const t = (half - acc) / (seg || 1);
        return { x: a.x + t*(b.x - a.x), y: a.y + t*(b.y - a.y) };
      }
      acc += seg;
    }
    return {x: points[points.length-1].x, y: points[points.length-1].y};
  }

  function normalizeTargets(arr) {
    const input = Array.isArray(arr) ? arr : [];
    return input.map(t => {
      const shape = (t && (t.shape === "rect" || t.shape === "route")) ? t.shape : "circle";
      const base = {
        id: (t && t.id) ? t.id : uid(),
        answer: (t && typeof t.answer === "string") ? t.answer : "",
        aliases: (t && Array.isArray(t.aliases)) ? t.aliases : [],
        shape
      };

      if (shape === "circle") {
        const x = Number(t?.x);
        const y = Number(t?.y);
        const r = Number(t?.r);
        return {
          ...base,
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          r: (Number.isFinite(r) && r > 0) ? r : 26
        };
      }

      if (shape === "rect") {
        const x1 = Number(t?.x1), y1 = Number(t?.y1), x2 = Number(t?.x2), y2 = Number(t?.y2);
        return {
          ...base,
          x1: Number.isFinite(x1) ? x1 : 0,
          y1: Number.isFinite(y1) ? y1 : 0,
          x2: Number.isFinite(x2) ? x2 : 0,
          y2: Number.isFinite(y2) ? y2 : 0
        };
      }

      // route
      const pts = Array.isArray(t?.points) ? t.points : [];
      const points = pts
        .filter(p => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)))
        .map(p => ({x: Number(p.x), y: Number(p.y)}));
      return { ...base, points };
    });
  }

  function getTargetById(id) {
    return state.targets.find(t => t.id === id) || null;
  }

  function saveTargets() {
    localStorage.setItem(lsKey("targets"), JSON.stringify(state.targets));
  }

  function saveProgress() {
    const payload = {
      stats: state.stats,
      answeredIds: Array.from(state.answeredIds),
      attemptsById: state.attemptsById
    };
    localStorage.setItem(lsKey("progress"), JSON.stringify(payload));
  }

  function loadFromStorage() {
    try {
      const t = localStorage.getItem(lsKey("targets"));
      if (t) state.targets = normalizeTargets(JSON.parse(t));

      const p = localStorage.getItem(lsKey("progress"));
      if (p) {
        const payload = JSON.parse(p);
        state.stats = payload.stats || state.stats;
        state.answeredIds = new Set(payload.answeredIds || []);
        state.attemptsById = payload.attemptsById || {};
      }
    } catch (e) {
      console.warn("Storage load error:", e);
    }
  }

  function clearProgress() {
    state.answeredIds = new Set();
    state.attemptsById = {};
    state.stats = { correct: 0, attempted: 0 };
    saveProgress();
    render();
    refreshUI();
    renderTargetsList();
  }

  function loadLockedImage(url) {
    state.imgLoading = true;
    state.imgLoadError = null;
    state.imgLoaded = false;

    imgStatus.textContent = "Loading map… please wait";
    render();

    const img = new Image();

    img.onload = () => {
      state.img = img;
      state.imgLoaded = true;
      state.imgLoading = false;
      state.imgLoadError = null;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      // Fit-to-view on load, then allow scroll-wheel zoom
      state.zoom = 1;
      applyCanvasDisplaySize();
      canvasWrap.scrollLeft = 0;
      canvasWrap.scrollTop = 0;

      imgStatus.innerHTML = `<span class="ok">Loaded:</span> ${QUIZZES[activeQuizId].mapFile} (${img.naturalWidth}×${img.naturalHeight})`;
      render();
      refreshUI();
    };

    img.onerror = () => {
      state.img = null;
      state.imgLoaded = false;
      state.imgLoading = false;
      state.imgLoadError = `Failed to load ${url}`;

      imgStatus.innerHTML = `<span class="bad">Failed to load:</span> ${QUIZZES[activeQuizId].mapFile}`;
      render();
      refreshUI();
    };

    img.src = url;
  }

  async function loadHotspotsFromRepo(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const arr = await res.json();
      if (Array.isArray(arr)) {
        state.targets = normalizeTargets(arr);
        saveTargets(); // optional local cache
        renderTargetsList();
        render();
      }
    } catch (e) {
      console.warn(`Could not load ${QUIZZES[activeQuizId].hotspotsFile}; falling back to localStorage.`, e);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    hideRouteHoverTip();

    if (mode === "edit") {
      state.showHotspots = true;
      state.hoverId = null;
    }
    if (mode === "quiz") {
      state.showHotspots = false;
      state.routeDraft = null; // don’t leave a draft hanging
      state.hoverId = null;
    }

    refreshUI();
    render();
  }

  function toggleTool() {
    const order = ["circle", "rect", "route"];
    const idx = order.indexOf(state.tool);
    state.tool = order[(idx + 1) % order.length];
    refreshUI();
    render();
  }

  function hitTest(target, p, routeTol = getRouteHitTolerance()) {
    if (target.shape === "circle") {
      const r = (typeof target.r === "number" && Number.isFinite(target.r)) ? target.r : 26;
      const dx = p.x - target.x;
      const dy = p.y - target.y;
      return (dx*dx + dy*dy) <= (r * r);
    }
    if (target.shape === "rect") {
      const x1 = Math.min(target.x1, target.x2);
      const x2 = Math.max(target.x1, target.x2);
      const y1 = Math.min(target.y1, target.y2);
      const y2 = Math.max(target.y1, target.y2);
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    }
    if (target.shape === "route") {
      const d = routeMinDistance(target.points, p);
      return d <= routeTol;
    }
    return false;
  }


  function nowMs() {
    return (typeof performance !== "undefined" && performance && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
  }

  // --- Overlap-aware picking (prevents top hotspots from blocking lower ones) ---
  // When you're very close to a route, we prefer the route even if you're also inside a box.
  const ROUTE_PICK_OVERRIDE = 0.25; // 0..1 (lower = stricter)
  let lastOverlapPick = null; // {x,y,idsSig,idx,ts}

  function rectMetrics(t, p) {
    const x1 = Math.min(t.x1, t.x2);
    const x2 = Math.max(t.x1, t.x2);
    const y1 = Math.min(t.y1, t.y2);
    const y2 = Math.max(t.y1, t.y2);
    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);
    const area = w * h;

    const cx = x1 + w / 2;
    const cy = y1 + h / 2;
    const centerDist = Math.hypot(p.x - cx, p.y - cy);

    const diagHalf = Math.max(1, Math.hypot(w, h) / 2);
    const score = centerDist / diagHalf; // 0..~1 for points inside
    return { area, score };
  }

  function circleMetrics(t, p) {
    const r = (typeof t.r === "number" && Number.isFinite(t.r)) ? t.r : 26;
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    const area = Math.PI * r * r;
    const score = r > 0 ? (d / r) : 0; // 0..1 inside
    return { area, score };
  }

  function getHitCandidates(p, { includeAnswered = true, routeTol = getRouteHitTolerance() } = {}) {
    const candidates = [];

    for (const t of state.targets) {
      // In quiz mode, answered hotspots should be "click-through" so they don't block unanswered ones.
      if (!includeAnswered && state.answeredIds.has(t.id)) continue;

      if (t.shape === "route") {
        const d = routeMinDistance(t.points, p);
        if (d <= routeTol) {
          candidates.push({ t, kind: "route", score: d / routeTol });
        }
        continue;
      }

      if (!hitTest(t, p, routeTol)) continue;

      if (t.shape === "rect") {
        const { area, score } = rectMetrics(t, p);
        candidates.push({ t, kind: "rect", area, score });
      } else if (t.shape === "circle") {
        const { area, score } = circleMetrics(t, p);
        candidates.push({ t, kind: "circle", area, score });
      }
    }

    return candidates;
  }

  function buildPickList(p, { includeAnswered = true, routeTol = getRouteHitTolerance() } = {}) {
    const candidates = getHitCandidates(p, { includeAnswered, routeTol });
    if (!candidates.length) return [];

    const routes = candidates
      .filter(c => c.kind === "route")
      .sort((a, b) => a.score - b.score);

    const others = candidates
      .filter(c => c.kind !== "route")
      // Prefer the smallest hotspot when boxes overlap; break ties by "closest to center".
      .sort((a, b) => (a.area - b.area) || (a.score - b.score));

    // If you're very close to a route, let the route win; otherwise prefer the smallest/closest box/dot.
    let primary = others;
    let secondary = routes;
    if (routes.length && (!others.length || routes[0].score <= ROUTE_PICK_OVERRIDE)) {
      primary = routes;
      secondary = others;
    }

    return primary.concat(secondary).map(c => c.t);
  }

  function bestTargetAtPoint(p, { includeAnswered = true, routeTol = getRouteHitTolerance() } = {}) {
    const list = buildPickList(p, { includeAnswered, routeTol });
    return list.length ? list[0] : null;
  }

  function pickTargetAtPoint(p, { includeAnswered = true, cycle = false, routeTol = getRouteHitTolerance() } = {}) {
    const list = buildPickList(p, { includeAnswered, routeTol });
    if (!list.length) return null;

    if (!cycle || list.length === 1) {
      lastOverlapPick = { x: p.x, y: p.y, idsSig: list.map(t => t.id).join(","), idx: 0, ts: nowMs() };
      return list[0];
    }

    const sig = list.map(t => t.id).join(",");
    const tNow = nowMs();
    const near =
      lastOverlapPick &&
      lastOverlapPick.idsSig === sig &&
      (Math.hypot(p.x - lastOverlapPick.x, p.y - lastOverlapPick.y) <= 10) &&
      (tNow - lastOverlapPick.ts <= 1800);

    // If this is the first cycle click at this spot, jump to the next candidate.
    const idx = near
      ? ((lastOverlapPick.idx + 1) % list.length)
      : Math.min(1, list.length - 1);

    lastOverlapPick = { x: p.x, y: p.y, idsSig: sig, idx, ts: tNow };
    return list[idx];
  }

    function findHoverTarget(p, { routeTol = getRouteHitTolerance() } = {}) {
    const hit = bestTargetAtPoint(p, { includeAnswered: true, routeTol });
    return hit ? hit.id : null;
  }

  function selectTarget(id) {
    state.selectedId = id;
    const t = getTargetById(id);
    if (!t) {
      answerInput.value = "";
      aliasesInput.value = "";
      shapeSelect.value = "circle";
      radiusInput.value = 26;
      radiusInput.disabled = false;
      shapeSelect.disabled = false;
      renderTargetsList();
      render();
      return;
    }

    answerInput.value = t.answer || "";
    aliasesInput.value = (t.aliases || []).join(", ");

    shapeSelect.value = t.shape || "circle";

    if (t.shape === "circle") {
      radiusInput.value = t.r ?? 26;
      radiusInput.disabled = false;
    } else {
      radiusInput.disabled = true;
    }

    // We allow shapeSelect to show route, but prevent cross-conversion involving routes.
    shapeSelect.disabled = false;

    renderTargetsList();
    render();
  }

  function upsertSelectedFromInputs() {
    const t = getTargetById(state.selectedId);
    if (!t) return;

    const answer = (answerInput.value || "").trim();
    if (!answer) { alert("Answer is required."); return; }

    t.answer = answer;
    t.aliases = (aliasesInput.value || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const desiredShape = shapeSelect.value;

    // Prevent converting to/from route (keeps your route geometry intact).
    if ((t.shape === "route" && desiredShape !== "route") || (t.shape !== "route" && desiredShape === "route")) {
      alert("To change between route and non-route shapes, delete and redraw the hotspot.");
      shapeSelect.value = t.shape;
      return;
    }

    // Non-route conversions only (circle <-> rect)
    if (desiredShape !== t.shape && t.shape !== "route") {
      if (desiredShape === "circle") {
        const cx = (t.shape === "rect") ? (t.x1 + t.x2) / 2 : t.x;
        const cy = (t.shape === "rect") ? (t.y1 + t.y2) / 2 : t.y;
        t.shape = "circle";
        t.x = cx; t.y = cy;
        t.r = clamp(parseInt(radiusInput.value || "26", 10), 6, 200);
        delete t.x1; delete t.y1; delete t.x2; delete t.y2;
      } else if (desiredShape === "rect") {
        const cx = (t.shape === "circle") ? t.x : (t.x1 + t.x2) / 2;
        const cy = (t.shape === "circle") ? t.y : (t.y1 + t.y2) / 2;
        t.shape = "rect";
        t.x1 = cx - 40; t.y1 = cy - 20;
        t.x2 = cx + 40; t.y2 = cy + 20;
        delete t.x; delete t.y; delete t.r;
      }
    } else if (t.shape === "circle") {
      t.r = clamp(parseInt(radiusInput.value || "26", 10), 6, 200);
    }

    saveTargets();
    renderTargetsList();
    render();
  }

  function deleteSelected() {
    const t = getTargetById(state.selectedId);
    if (!t) return;
    if (!confirm(`Delete hotspot "${t.answer || "(unnamed)"}"?`)) return;

    state.targets = state.targets.filter(x => x.id !== t.id);
    state.answeredIds.delete(t.id);
    delete state.attemptsById[t.id];
    state.selectedId = null;

    saveTargets();
    saveProgress();
    renderTargetsList();
    render();
    refreshUI();
  }

  function renderTargetsList() {
    targetsList.innerHTML = "";
    if (!state.targets.length) {
      targetsList.innerHTML = `<div style="padding:10px;" class="muted">No hotspots yet. Switch to Edit mode and add some.</div>`;
      return;
    }
    for (const t of state.targets) {
      const div = document.createElement("div");
      div.className = "targetItem" + (t.id === state.selectedId ? " selected" : "");
      div.innerHTML = `
        <div>
          <div style="font-weight:600;">${escapeHtml(t.answer || "(unnamed)")}</div>
          <div class="muted" style="font-size:12px;">${t.shape}${state.answeredIds.has(t.id) ? " • ✅" : ""}</div>
        </div>
        <div class="muted" style="font-size:12px;">${(t.aliases||[]).length ? "aliases" : ""}</div>
      `;
      div.onclick = () => selectTarget(t.id);
      targetsList.appendChild(div);
    }
  }

  function refreshUI() {
    document.body.classList.toggle("mode-quiz", state.mode === "quiz");

    modePill.textContent = "Mode: " + (state.mode === "quiz" ? "Quiz" : "Edit");
    toggleModeBtn.textContent = state.mode === "quiz" ? "Switch to Edit" : "Switch to Quiz";
    editCard.style.display = state.mode === "edit" ? "block" : "none";

    const toolName = state.tool === "circle" ? "Circle" : (state.tool === "rect" ? "Rect" : "Route");
    toolPill.textContent = "Tool: " + toolName;

    scoreLine.textContent = `${state.stats.correct} correct / ${state.stats.attempted} attempted`;
    const acc = state.stats.attempted ? Math.round((state.stats.correct / state.stats.attempted) * 100) : null;
    accuracyPill.textContent = "Accuracy: " + (acc === null ? "—" : `${acc}%`);

    const draftPts = state.routeDraft?.points?.length || 0;
    const drawingRoute = state.mode === "edit" && state.tool === "route";
    if (drawingRoute && draftPts > 0) {
      routeStatus.textContent = `Route in progress: ${draftPts} point${draftPts===1?"":"s"} (double-click or Enter to finish)`;
    } else if (drawingRoute) {
      routeStatus.textContent = `Route tool: click along the road to place points.`;
    } else {
      routeStatus.textContent = "";
    }

    finishRouteBtn.disabled = !(state.mode === "edit" && state.tool === "route" && draftPts >= 2);
    cancelRouteBtn.disabled = !(state.mode === "edit" && state.tool === "route" && draftPts >= 1);

    // If selected is route, radius doesn’t apply
    const sel = getTargetById(state.selectedId);
    if (sel && sel.shape !== "circle") radiusInput.disabled = true;
    if (sel && sel.shape === "circle") radiusInput.disabled = false;
  }

  function drawRoute(points, style) {
    if (!Array.isArray(points) || points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = style.strokeStyle;
    ctx.lineWidth = style.lineWidth;
    ctx.globalAlpha = style.alpha ?? 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  
  function drawQuestionBubble(x, y, sizePx, highlight = false) {
    const base = clamp(sizePx, 10, 24);
    const r = base + (highlight ? 8 : 6);

    ctx.save();
    ctx.globalAlpha = 0.95;

    if (highlight) {
      ctx.shadowColor = "rgba(110,160,255,0.95)";
      ctx.shadowBlur = 10;
    }

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = highlight ? "rgba(0,0,0,0.70)" : "rgba(0,0,0,0.55)";
    ctx.fill();

    ctx.lineWidth = highlight ? 3 : 2;
    ctx.strokeStyle = highlight ? "rgba(110,160,255,0.95)" : "rgba(255,255,255,0.65)";
    ctx.stroke();

    // text
    ctx.shadowBlur = highlight ? 8 : 0;
    ctx.shadowColor = highlight ? "rgba(110,160,255,0.95)" : "transparent";
    ctx.font = `bold ${Math.round(base + 10)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = highlight ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.92)";
    ctx.fillText("?", x, y + 1);

    ctx.restore();
  }

  
  function drawLabelAt(x, y, label, answered, highlight = false) {
    const text = (label || "").trim().slice(0, 40);
    if (!text) return;

    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.font = "14px system-ui";

    const w = ctx.measureText(text).width;
    const px = x + 8;
    const py = y - 10;

    if (highlight) {
      ctx.shadowColor = "rgba(110,160,255,0.95)";
      ctx.shadowBlur = 10;
    }

    const bx = px - 4;
    const by = py - 16;
    const bw = w + 8;
    const bh = 20;

    ctx.fillStyle = highlight ? "rgba(0,0,0,0.70)" : "rgba(0,0,0,0.55)";
    ctx.fillRect(bx, by, bw, bh);

    if (highlight) {
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(110,160,255,0.95)";
      ctx.strokeRect(bx, by, bw, bh);
    }

    // text (brighter on hover)
    ctx.shadowColor = highlight ? "rgba(110,160,255,0.95)" : "transparent";
    ctx.shadowBlur = highlight ? 8 : 0;

    ctx.fillStyle = highlight
      ? "rgba(255,255,255,0.98)"
      : (answered ? "rgba(200,255,220,0.95)" : "rgba(255,255,255,0.92)");

    ctx.fillText(text, px, py);
    ctx.restore();
  }

  function drawTarget(t, opts = {}) {
    const selected = opts.selected || false;
    const answered = state.answeredIds.has(t.id);

    // '?' marker shows in quiz mode for unanswered, but NOT during reveal-all
    const drawQuestion = state.mode === "quiz" && !answered && !state.showHotspots;

    // hover highlight: quiz mode, not reveal-all
    const hovered = state.mode === "quiz" && !state.showHotspots && state.hoverId === t.id;

    // show if editing/reveal/selected/answered OR we need to draw '?' OR hovered highlight
    const show = state.mode === "edit" || state.showHotspots || selected || answered || drawQuestion || hovered;
    if (!show) return;

    const drawOutline = state.mode === "edit" || state.showHotspots || selected;
    const drawLabel = state.mode === "edit" || state.showHotspots || answered;

    ctx.save();

    if (t.shape === "circle") {
      const r = t.r ?? 26;

      if (drawOutline) {
        ctx.globalAlpha = answered ? 0.75 : 0.9;
        ctx.lineWidth = selected ? 4 : 2;
        ctx.beginPath();
        ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = selected ? "rgba(110,160,255,0.95)" : "rgba(255,255,255,0.75)";
        ctx.stroke();
      }

      if (drawLabel) {
        drawLabelAt(t.x + r, t.y, t.answer, answered);
      }

      if (drawQuestion) {
        drawQuestionBubble(t.x, t.y, r * 0.55);
      }

      ctx.restore();
      return;
    }

    if (t.shape === "rect") {
      const cx = (t.x1 + t.x2) / 2;
      const cy = (t.y1 + t.y2) / 2;

      if (drawOutline) {
        ctx.globalAlpha = answered ? 0.75 : 0.9;
        ctx.lineWidth = selected ? 4 : 2;

        const x1 = Math.min(t.x1, t.x2);
        const y1 = Math.min(t.y1, t.y2);
        const w = Math.abs(t.x2 - t.x1);
        const h = Math.abs(t.y2 - t.y1);

        ctx.strokeStyle = selected ? "rgba(110,160,255,0.95)" : "rgba(255,255,255,0.75)";
        ctx.strokeRect(x1, y1, w, h);
      }

      if (drawLabel) {
        drawLabelAt(cx, cy, t.answer, answered);
      }

      if (drawQuestion) {
        const base = clamp(Math.min(Math.abs(t.x2 - t.x1), Math.abs(t.y2 - t.y1)) * 0.25, 10, 22);
        drawQuestionBubble(cx, cy, base);
      }

      ctx.restore();
      return;
    }

    if (t.shape === "route") {
      // Routes: do NOT draw "?" or labels on the map.
      // In Quiz mode, routes show as:
      //   - answered: deep yellow line
      //   - hovered: blue highlight line + tooltip near cursor
      //   - unanswered + unhovered: faint translucent line (so users know what's left)
      // In Edit/Reveal, we draw the route geometry (white), but keep labels off-map.

      const showFaint = (state.mode === "quiz" && !state.showHotspots && !answered && !hovered);
      const drawRouteLine = drawOutline || hovered || answered || showFaint;

      if (drawRouteLine) {
        if (hovered) {
          drawRoute(t.points, {
            strokeStyle: "rgba(110,160,255,0.95)",
            lineWidth: 7,
            alpha: 0.95
          });
        } else if (answered) {
          drawRoute(t.points, {
            strokeStyle: "rgba(251,188,4,0.95)",
            lineWidth: 5,
            alpha: 0.95
          });
        } else if (showFaint) {
          // Slightly more visible than before, but still subtle.
          // Tune these two values if you want it lighter/heavier:
          //   opacity: 0.36–0.48, width: 3–4
          drawRoute(t.points, {
            strokeStyle: "rgba(255,0,0,0.12)",
            lineWidth: 3.6,
            alpha: 1
          });
        } else {
          // Edit/Reveal (unanswered): normal visible outline
          drawRoute(t.points, {
            strokeStyle: "rgba(255,255,255,0.80)",
            lineWidth: 4,
            alpha: 0.85
          });
        }
      }

      ctx.restore();
      return;
    }

    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = "#0e1422";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state.imgLoading) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "20px system-ui";
      ctx.fillText("Loading map… please wait", 24, 44);

      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "14px system-ui";
      ctx.fillText("If this takes more than a few seconds, refresh the page.", 24, 70);
      return;
    }

    if (!state.imgLoaded || !state.img) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "18px system-ui";
      ctx.fillText("Map failed to load.", 24, 44);

      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "14px system-ui";
      ctx.fillText(state.imgLoadError || `Check that ${QUIZZES[activeQuizId].mapFile} exists next to index.html.`, 24, 70);
      return;
    }

    // Draw map
    ctx.drawImage(state.img, 0, 0);

    // Draw targets
    const sel = state.selectedId;
    for (const t of state.targets) drawTarget(t, { selected: t.id === sel });

    // Draw route draft (edit mode)
    if (state.mode === "edit" && state.tool === "route" && state.routeDraft?.points?.length) {
      // draft line
      drawRoute(state.routeDraft.points, {
        strokeStyle: "rgba(110,160,255,0.95)",
        lineWidth: 5,
        alpha: 0.9
      });

      // draft points
      ctx.save();
      ctx.fillStyle = "rgba(110,160,255,0.95)";
      for (const p of state.routeDraft.points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Rect drag preview
    if (state.rectDrag) {
      const { start, end } = state.rectDrag;
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.save();
      ctx.strokeStyle = "rgba(110,160,255,0.95)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(110,160,255,0.10)";
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  // ---- QUIZ answering ----
  function askAnswerForTarget(t) {
    const user = window.prompt("Type the name for this location/label:", "");
    if (user === null) return;

    const guess = normStr(user);
    const correct = normStr(t.answer);
    const aliases = (t.aliases || []).map(normStr);

    state.stats.attempted += 1;
    state.attemptsById[t.id] = (state.attemptsById[t.id] || 0) + 1;

    const ok = guess === correct || aliases.includes(guess);

    if (ok) {
      state.stats.correct += 1;
      state.answeredIds.add(t.id);
      // silent success
    } else {
      alert(`❌ Not quite.\n\nCorrect: ${t.answer}`);
    }

    saveProgress();
    refreshUI();
    renderTargetsList();
    render();
  }

  // ---- Route draft helpers ----
  function startOrAddRoutePoint(p) {
    if (!state.routeDraft) state.routeDraft = { points: [] };
    state.routeDraft.points.push({ x: p.x, y: p.y });
    refreshUI();
    render();
  }

  function finishRouteDraft() {
    const pts = state.routeDraft?.points || [];
    if (pts.length < 2) return;

    const t = {
      id: uid(),
      answer: "",
      aliases: [],
      shape: "route",
      points: pts.map(p => ({x: p.x, y: p.y}))
    };

    state.targets.push(t);
    state.selectedId = t.id;
    state.routeDraft = null;

    saveTargets();
    renderTargetsList();
    selectTarget(t.id);
    refreshUI();
    render();

    // focus answer
    answerInput.focus();
  }

  function cancelRouteDraft() {
    state.routeDraft = null;
    refreshUI();
    render();
  }

  function beginPan(evt) {
    if (evt.button !== 0) return; // left-click only
    if (state.mode !== "quiz") return;
    if (!state.imgLoaded) return;

    pan.active = true;
    pan.moved = false;
    pan.startClientX = evt.clientX;
    pan.startClientY = evt.clientY;
    pan.startScrollLeft = canvasWrap.scrollLeft;
    pan.startScrollTop = canvasWrap.scrollTop;

    // Clear hover visuals while panning
    state.hoverId = null;
    hideRouteHoverTip();
    canvasWrap.classList.add("panning");
    render();
    evt.preventDefault();
  }

  function updatePan(evt) {
    if (!pan.active) return;
    const dx = evt.clientX - pan.startClientX;
    const dy = evt.clientY - pan.startClientY;
    if (!pan.moved && (Math.abs(dx) + Math.abs(dy) >= PAN_THRESHOLD_PX)) {
      pan.moved = true;
    }
    if (!pan.moved) return;
    canvasWrap.scrollLeft = pan.startScrollLeft - dx;
    canvasWrap.scrollTop = pan.startScrollTop - dy;
    hideRouteHoverTip();
    evt.preventDefault();
  }

  function endPan() {
    if (!pan.active) return;
    pan.active = false;
    canvasWrap.classList.remove("panning");
  }

  function resetMapView() {
    if (!state.imgLoaded || !state.img) return;
    state.zoom = 1;
    applyCanvasDisplaySize();
    canvasWrap.scrollLeft = 0;
    canvasWrap.scrollTop = 0;
    render();
  }

  function updateTouchHover(clientX, clientY) {
    if (!state.imgLoaded || state.mode !== "quiz" || state.showHotspots) return;
    const p = getCanvasPointFromClient(clientX, clientY);
    const hover = findHoverTarget(p, { routeTol: getRouteHitTolerance() });
    const t = hover ? getTargetById(hover) : null;

    if (t && t.shape === "route") {
      showRouteHoverTip(t, clientX, clientY);
    } else {
      hideRouteHoverTip();
    }

    if (hover !== state.hoverId) {
      state.hoverId = hover;
      render();
    }
  }

  // ---------- events ----------

  // Sidebar collapse toggle (persisted)
  toggleSidebarBtn.addEventListener("click", () => {
    if (isMobileLayout()) {
      const open = document.body.classList.contains("mobile-sidebar-open");
      setSidebarCollapsed(open);
      return;
    }
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    setSidebarCollapsed(collapsed);
  });

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => setSidebarCollapsed(true));
  }

  if (mapZoomInBtn) mapZoomInBtn.addEventListener("click", () => {
    if (!state.imgLoaded) return;
    setZoom(state.zoom * ZOOM_STEP_IN, window.innerWidth / 2, window.innerHeight / 2);
  });

  if (mapZoomOutBtn) mapZoomOutBtn.addEventListener("click", () => {
    if (!state.imgLoaded) return;
    setZoom(state.zoom * ZOOM_STEP_OUT, window.innerWidth / 2, window.innerHeight / 2);
  });

  if (mapZoomResetBtn) mapZoomResetBtn.addEventListener("click", resetMapView);

  // Scroll-wheel zoom on the map (works in both Quiz/Edit)
  canvasWrap.addEventListener("wheel", (e) => {
    if (!state.imgLoaded) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP_IN : ZOOM_STEP_OUT;
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Drag-to-pan (quiz mode)
  window.addEventListener("mousemove", (e) => {
    if (shouldIgnoreMouse()) return;
    if (!pan.active) return;
    updatePan(e);
  }, { passive: false });

  window.addEventListener("mouseup", () => {
    if (shouldIgnoreMouse()) return;
    if (!pan.active) return;
    endPan();
  });

  window.addEventListener("blur", () => {
    if (!pan.active) return;
    endPan();
  });

  // Re-fit canvas display on resize (keeps scroll position roughly stable)
  window.addEventListener("resize", () => {
    syncResponsiveUi();
    const prevScale = (state.fitScale * state.zoom) || 1;
    applyCanvasDisplaySize();
    const nextScale = (state.fitScale * state.zoom) || 1;
    if (prevScale > 0 && nextScale > 0) {
      canvasWrap.scrollLeft = canvasWrap.scrollLeft * (nextScale / prevScale);
      canvasWrap.scrollTop = canvasWrap.scrollTop * (nextScale / prevScale);
    }
    render();
  });

  toggleModeBtn.addEventListener("click", () => {
    setMode(state.mode === "quiz" ? "edit" : "quiz");
  });


  function setActiveTabUI() {
    const mapOn = !legalActive;

    if (tabMap1Btn) {
      const on = mapOn && activeQuizId === "map1";
      tabMap1Btn.classList.toggle("active", on);
      tabMap1Btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (tabMap2Btn) {
      const on = mapOn && activeQuizId === "map2";
      tabMap2Btn.classList.toggle("active", on);
      tabMap2Btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (tabMap3Btn) {
      const on = mapOn && activeQuizId === "map3";
      tabMap3Btn.classList.toggle("active", on);
      tabMap3Btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (tabLegalBtn) {
      const on = legalActive;
      tabLegalBtn.classList.toggle("active", on);
      tabLegalBtn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function setMapUiVisible(visible) {
    const ids = ["modeCard","mapStatusCard","scoreCard","editCard","exportTargets","importTargets","importBtn","targetsList","revealAll","hideAll","clearProgress"];
    if (mapZoomInBtn?.parentElement) {
      mapZoomInBtn.parentElement.style.display = visible && useTouchFriendlyUi() ? "flex" : "none";
    }
    // cards
    const modeCard = document.getElementById("modeCard");
    const mapStatusCard = document.getElementById("mapStatusCard");
    const scoreCard = document.getElementById("scoreCard");
    const editCard = document.getElementById("editCard");
    if (modeCard) modeCard.style.display = visible ? "" : "none";
    if (mapStatusCard) mapStatusCard.style.display = visible ? "" : "none";
    if (scoreCard) scoreCard.style.display = visible ? "" : "none";
    if (editCard) editCard.style.display = visible ? "" : "none";
    // map buttons inside scoreCard
    const revealAllBtn = document.getElementById("revealAll");
    const hideAllBtn = document.getElementById("hideAll");
    const clearProgressBtn = document.getElementById("clearProgress");
    if (revealAllBtn) revealAllBtn.style.display = visible ? "" : "none";
    if (hideAllBtn) hideAllBtn.style.display = visible ? "" : "none";
    if (clearProgressBtn) clearProgressBtn.style.display = visible ? "" : "none";
  }

  function setLegalUiVisible(visible) {
    if (legalCard) legalCard.style.display = visible ? "" : "none";
    if (legalQuizPanel) legalQuizPanel.style.display = visible ? "" : "none";
  }

  function showLegalTab() {
    legalActive = true;
    setActiveTabUI();
    setMapUiVisible(false);
    setLegalUiVisible(true);
    if (canvasWrap) canvasWrap.style.display = "none";
    // Map hover tooltip shouldn't show over legal
    try { hideRouteHoverTip(); } catch {}
  }

  function hideLegalTab() {
    legalActive = false;
    setActiveTabUI();
    setMapUiVisible(true);
    setLegalUiVisible(false);
    if (canvasWrap) canvasWrap.style.display = "";
  }

async function switchQuiz(nextId) {
    if (!QUIZZES[nextId]) return;
    // Allow switching back to the currently-selected map if we are leaving Legal
    if (nextId === activeQuizId && !legalActive) return;

    if (legalActive) {
      // Leaving legal tab back to a map
      hideLegalTab();
      legalRevealAll = false;
      legalSolved = false;
    }

    try { saveTargets(); } catch {}
    try { saveProgress(); } catch {}

    activeQuizId = nextId;
    setActiveTabUI();
    if (isMobileLayout()) setSidebarCollapsed(true);

    // HARD CLEAR so old hotspots never render on the new map
    hideRouteHoverTip();
    state.hoverId = null;
    state.selectedId = null;
    state.rectDrag = null;
    state.routeDraft = null;
    state.targets = [];

    // reset per-map quiz progress (will be reloaded below)
    state.stats = { correct: 0, attempted: 0 };
    state.answeredIds = new Set();
    state.attemptsById = {};

    state.showHotspots = (state.mode === "edit");

    state.zoom = 1;
    canvasWrap.scrollLeft = 0;
    canvasWrap.scrollTop = 0;

    state.img = null;
    state.imgLoaded = false;
    state.imgLoading = true;
    state.imgLoadError = null;
    if (imgStatus) imgStatus.textContent = "Loading map… please wait";

    renderTargetsList();
    refreshUI();
    render();

    // load per-map local cache (if any), then fetch repo hotspots
    loadFromStorage();
    renderTargetsList();
    refreshUI();
    render();

    loadLockedImage(mapUrl());
    await loadHotspotsFromRepo(hotspotsUrl());

    renderTargetsList();
    refreshUI();
    render();
  }


  toggleToolBtn.addEventListener("click", toggleTool);
  if (tabMap1Btn) tabMap1Btn.addEventListener("click", () => { switchQuiz("map1"); });
  if (tabMap2Btn) tabMap2Btn.addEventListener("click", () => { switchQuiz("map2"); });
  if (tabMap3Btn) tabMap3Btn.addEventListener("click", () => { switchQuiz("map3"); });
  if (tabLegalBtn) tabLegalBtn.addEventListener("click", async () => {
    // Save map progress before leaving the map
    try { saveTargets(); } catch {}
    try { saveProgress(); } catch {}
    showLegalTab();
    if (isMobileLayout()) setSidebarCollapsed(true);
    try { await ensureLegalReady(); } catch (e) {
      if (legalFeedbackEl) legalFeedbackEl.textContent = String(e?.message || e);
    }
  });

  if (legalDifficultySel) legalDifficultySel.addEventListener("change", () => {
    // re-render masking only if not solved/revealed
    if (!legalSolved && !legalRevealAll) renderLegal();
  });

  if (legalNextBtn) legalNextBtn.addEventListener("click", async () => {
    legalRevealAll = false;
    legalSolved = false;
    await startNewLegalCrime();
  });

  if (legalRevealBtn) legalRevealBtn.addEventListener("click", () => {
    // Reveal all should also show Summary/Definition under title
    revealAllLegal();
  });

  if (legalClearProgressBtn) legalClearProgressBtn.addEventListener("click", async () => {
    clearLegalCompletedSet();
    legalRevealAll = false;
    legalSolved = false;
    legalCurrent = null;
    resetLegalAttemptState();
    if (legalFeedbackEl) legalFeedbackEl.textContent = "Legal quiz progress cleared.";
    await ensureLegalReady();
  });

  if (legalSubmitBtn) legalSubmitBtn.addEventListener("click", () => {
    checkLegalAnswers();
  });

  if (legalAnotherBtn) legalAnotherBtn.addEventListener("click", async () => {
    legalRevealAll = false;
    legalSolved = false;
    await startNewLegalCrime();
  });

  if (legalExportBtn) legalExportBtn.addEventListener("click", () => {
    if (!legalDataset || !legalDataset.length) return;
    downloadJson(LEGAL_DATA_FILE, legalDataset);
  });

  if (legalImportBtn) legalImportBtn.addEventListener("click", async () => {
    const f = legalImportFile?.files?.[0];
    if (!f) {
      if (legalFeedbackEl) legalFeedbackEl.textContent = "Choose a JSON file first.";
      return;
    }
    try {
      const txt = await f.text();
      const data = JSON.parse(txt);
      if (!Array.isArray(data)) throw new Error("Imported file must be a JSON array.");
      legalDataset = data.map(x => ({
        id: String(x.id ?? x.statute),
        statute: String(x.statute ?? x.id ?? ""),
        title: String(x.title ?? ""),
        definition: String(x.definition ?? ""),
        elements: Array.isArray(x.elements) ? x.elements.map(e => String(e)) : []
      })).filter(x => x.id && x.title && x.elements.length);

      if (legalDatasetLine) legalDatasetLine.textContent = `${legalDataset.length} crimes loaded (imported)`;
      await startNewLegalCrime();
    } catch (e) {
      if (legalFeedbackEl) legalFeedbackEl.textContent = `Import failed: ${String(e?.message || e)}`;
    }
  });



  document.addEventListener("keydown", (e) => {
    // Don't interfere while typing in fields
    const el = document.activeElement;
    const tag = (el?.tagName || "").toLowerCase();
    const isTypingField =
      el?.isContentEditable ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select";

    // R cycles tools in edit mode, but not while typing
    if (state.mode === "edit" && !isTypingField && (e.key === "r" || e.key === "R")) {
      toggleTool();
      return;
    }

    // Route finishing/cancel keys (edit mode)
    if (state.mode === "edit" && state.tool === "route" && !isTypingField) {
      if (e.key === "Enter") {
        finishRouteDraft();
      } else if (e.key === "Escape") {
        cancelRouteDraft();
      }
    }
  });

  clearProgressBtn.addEventListener("click", clearProgress);

  revealAllBtn.addEventListener("click", () => { state.showHotspots = true; state.hoverId = null; hideRouteHoverTip(); render(); });
  hideAllBtn.addEventListener("click", () => { state.showHotspots = false; hideRouteHoverTip(); render(); });

  finishRouteBtn.addEventListener("click", finishRouteDraft);
  cancelRouteBtn.addEventListener("click", cancelRouteDraft);

  saveSelectedBtn.addEventListener("click", upsertSelectedFromInputs);
  deleteSelectedBtn.addEventListener("click", deleteSelected);

  exportTargetsBtn.addEventListener("click", () => {
    const payload = JSON.stringify(state.targets, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = QUIZZES[activeQuizId].hotspotsFile;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  importBtn.addEventListener("click", () => importTargetsFile.click());

  importTargetsFile.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error("JSON must be an array of targets.");
      for (const t of arr) {
        if (!t.answer) throw new Error("Each target must have an 'answer'.");
      }
      state.targets = normalizeTargets(arr);
      state.selectedId = null;
      saveTargets();
      renderTargetsList();
      render();
      alert("Imported targets.");
    } catch (err) {
      alert("Import failed: " + err.message);
    } finally {
      importTargetsFile.value = "";
    }
  });

  // Hover highlight in quiz mode (routes highlight on hover + tooltip near cursor)
  canvas.addEventListener("mousemove", (evt) => {
    if (shouldIgnoreMouse()) return;
    if (!state.imgLoaded) return;

    if (pan.active) {
      hideRouteHoverTip();
      return;
    }

    // Tooltip/hover only in Quiz mode and not during Reveal All
    if (state.mode !== "quiz" || state.showHotspots) {
      if (state.hoverId) state.hoverId = null;
      hideRouteHoverTip();
      render();
      return;
    }

    const p = getCanvasPoint(evt);
    const hover = findHoverTarget(p, { routeTol: getRouteHitTolerance() });

    // Tooltip follows cursor smoothly for ROUTES only
    const t = hover ? getTargetById(hover) : null;
    if (t && t.shape === "route") {
      showRouteHoverTip(t, evt.clientX, evt.clientY);
    } else {
      hideRouteHoverTip();
    }

    // Only redraw map if hover target changed (keeps it snappy)
    if (hover !== state.hoverId) {
      state.hoverId = hover;
      render();
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (shouldIgnoreMouse()) return;
    if (state.hoverId) {
      state.hoverId = null;
      render();
    }
    hideRouteHoverTip();
  });

  canvas.addEventListener("mousedown", (evt) => {
    if (shouldIgnoreMouse()) return;
    if (!state.imgLoaded) return;

    if (state.mode === "edit" && state.tool === "rect") {
      const p = getCanvasPoint(evt);
      state.rectDrag = { start: p, end: p };
      render();
      return;
    }

    // Quiz mode: click-drag to pan the map (only when starting on empty space)
    if (state.mode === "quiz") {
      const p = getCanvasPoint(evt);
      const hit = bestTargetAtPoint(p, { includeAnswered: true, routeTol: getRouteHitTolerance() });
      if (!hit) beginPan(evt);
    }
  });

  canvas.addEventListener("mousemove", (evt) => {
    if (shouldIgnoreMouse()) return;
    if (!state.rectDrag) return;
    state.rectDrag.end = getCanvasPoint(evt);
    render();
  });

  // Double-click finishes a route draft (edit mode)
  canvas.addEventListener("dblclick", (evt) => {
    if (shouldIgnoreMouse()) return;
    if (!state.imgLoaded) return;
    if (state.mode === "edit" && state.tool === "route") {
      finishRouteDraft();
    }
  });

  canvas.addEventListener("mouseup", (evt) => {
    if (shouldIgnoreMouse()) return;
    if (!state.imgLoaded) return;
    // If we were dragging to pan, do not treat this as a click-to-answer
    if (state.mode === "quiz" && pan.active) {
      const moved = pan.moved;
      endPan();
      if (moved) return;
    }
    const p = getCanvasPoint(evt);

    if (state.mode === "edit") {
      if (state.tool === "circle") {
        const t = {
          id: uid(),
          answer: "",
          aliases: [],
          shape: "circle",
          x: p.x,
          y: p.y,
          r: clamp(parseInt(radiusInput.value || "26", 10), 6, 200),
        };
        state.targets.push(t);
        state.selectedId = t.id;
        saveTargets();
        renderTargetsList();
        selectTarget(t.id);
        render();
        answerInput.focus();
        return;
      }

      if (state.tool === "rect") {
        if (!state.rectDrag) return;
        const start = state.rectDrag.start;
        const end = state.rectDrag.end;
        state.rectDrag = null;

        if (Math.abs(end.x - start.x) < 8 || Math.abs(end.y - start.y) < 8) {
          render();
          return;
        }

        const t = {
          id: uid(),
          answer: "",
          aliases: [],
          shape: "rect",
          x1: start.x, y1: start.y,
          x2: end.x,   y2: end.y
        };
        state.targets.push(t);
        state.selectedId = t.id;
        saveTargets();
        renderTargetsList();
        selectTarget(t.id);
        render();
        answerInput.focus();
        return;
      }

      if (state.tool === "route") {
        startOrAddRoutePoint(p);
        return;
      }
    }

    if (state.mode === "quiz") {
      // Overlap-safe pick. Answered hotspots are click-through.
      // Hold Shift and click repeatedly to cycle through overlapping hotspots.
      const hit = pickTargetAtPoint(p, { includeAnswered: false, cycle: evt.shiftKey, routeTol: getRouteHitTolerance() });
      if (!hit) return;
      askAnswerForTarget(hit);
    }
  });



  canvas.addEventListener("touchstart", (evt) => {
    if (!state.imgLoaded) return;
    noteTouchInteraction();

    if (evt.touches.length >= 2) {
      const a = evt.touches[0];
      const b = evt.touches[1];
      touchNav.active = true;
      touchNav.moved = true;
      touchNav.pinchActive = true;
      touchNav.pinchStartDist = Math.max(1, getTouchDistance(a, b));
      touchNav.pinchStartZoom = state.zoom;
      state.hoverId = null;
      hideRouteHoverTip();
      render();
      evt.preventDefault();
      return;
    }

    const touch = evt.touches[0];
    if (!touch) return;

    touchNav.active = true;
    touchNav.moved = false;
    touchNav.pinchActive = false;
    touchNav.startClientX = touch.clientX;
    touchNav.startClientY = touch.clientY;
    touchNav.startScrollLeft = canvasWrap.scrollLeft;
    touchNav.startScrollTop = canvasWrap.scrollTop;

    if (state.mode === "quiz" && !state.showHotspots) {
      updateTouchHover(touch.clientX, touch.clientY);
    }

    evt.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchmove", (evt) => {
    if (!state.imgLoaded) return;
    noteTouchInteraction();

    if (evt.touches.length >= 2) {
      const a = evt.touches[0];
      const b = evt.touches[1];
      const center = getTouchCenter(a, b);
      if (!touchNav.pinchActive) {
        touchNav.pinchActive = true;
        touchNav.pinchStartDist = Math.max(1, getTouchDistance(a, b));
        touchNav.pinchStartZoom = state.zoom;
      }
      const dist = Math.max(1, getTouchDistance(a, b));
      const factor = dist / touchNav.pinchStartDist;
      setZoom(touchNav.pinchStartZoom * factor, center.x, center.y);
      touchNav.active = true;
      touchNav.moved = true;
      state.hoverId = null;
      hideRouteHoverTip();
      evt.preventDefault();
      return;
    }

    const touch = evt.touches[0];
    if (!touch || !touchNav.active) return;

    const dx = touch.clientX - touchNav.startClientX;
    const dy = touch.clientY - touchNav.startClientY;

    if (!touchNav.moved && (Math.abs(dx) + Math.abs(dy) >= PAN_THRESHOLD_PX + 2)) {
      touchNav.moved = true;
    }

    if (touchNav.moved) {
      canvasWrap.scrollLeft = touchNav.startScrollLeft - dx;
      canvasWrap.scrollTop = touchNav.startScrollTop - dy;
      state.hoverId = null;
      hideRouteHoverTip();
      render();
    } else if (state.mode === "quiz" && !state.showHotspots) {
      updateTouchHover(touch.clientX, touch.clientY);
    }

    evt.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchend", (evt) => {
    noteTouchInteraction();

    if (touchNav.pinchActive) {
      if (evt.touches.length >= 2) {
        evt.preventDefault();
        return;
      }
      touchNav.pinchActive = false;
    }

    const touch = evt.changedTouches[0];
    if (!touch) {
      touchNav.active = false;
      touchNav.moved = false;
      hideRouteHoverTip();
      return;
    }

    const wasTap = touchNav.active && !touchNav.moved;
    touchNav.active = false;
    touchNav.moved = false;

    if (state.mode === "quiz") {
      if (wasTap && !state.showHotspots) {
        const p = getCanvasPointFromClient(touch.clientX, touch.clientY);
        const hit = pickTargetAtPoint(p, { includeAnswered: false, cycle: false, routeTol: getRouteHitTolerance() });
        if (hit) {
          state.hoverId = hit.id;
          const t = getTargetById(hit.id);
          if (t && t.shape === "route") {
            showRouteHoverTip(t, touch.clientX, touch.clientY);
          }
          render();
          askAnswerForTarget(hit);
        } else {
          state.hoverId = null;
          hideRouteHoverTip();
          render();
        }
      } else {
        state.hoverId = null;
        hideRouteHoverTip();
        render();
      }
    }

    evt.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchcancel", () => {
    noteTouchInteraction();
    touchNav.active = false;
    touchNav.moved = false;
    touchNav.pinchActive = false;
    state.hoverId = null;
    hideRouteHoverTip();
    render();
  }, { passive: false });
  
  async function loadLegalDataset() {
    // Prefer imported dataset already loaded
    if (legalDataset && legalDataset.length) return legalDataset;

    const url = new URL(LEGAL_DATA_FILE, document.baseURI).toString();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${LEGAL_DATA_FILE}: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("legal_elements.json must be an array");
    // Normalize expected fields
    legalDataset = data
      .filter(x => x && (x.id || x.statute) && x.title && Array.isArray(x.elements))
      .map(x => ({
        id: String(x.id ?? x.statute),
        statute: String(x.statute ?? x.id ?? ""),
        title: String(x.title ?? ""),
        definition: String(x.definition ?? ""),
        elements: x.elements.map(e => String(e))
      }));
    if (legalDatasetLine) legalDatasetLine.textContent = `${legalDataset.length} crimes loaded`;
    return legalDataset;
  }

  function pickNextLegalCrime() {
    const completed = loadLegalCompletedSet();
    const pool = (legalDataset || []).filter(x => !completed.has(x.id));
    const pickFrom = pool.length ? pool : legalDataset;
    if (!pickFrom || !pickFrom.length) return null;
    return pickFrom[Math.floor(Math.random() * pickFrom.length)];
  }

  function updateLegalProgressLine() {
    if (!legalProgressLine) return;
    const completed = loadLegalCompletedSet();
    const done = completed.size;
    const total = legalDataset ? legalDataset.length : 0;
    legalProgressLine.textContent = total ? `${done}/${total} completed` : "";
  }

  function renderLegal() {
    if (!legalCurrent) return;

    if (legalCrimeTitleEl) {
      legalCrimeTitleEl.textContent = "";
      const titleText = legalCurrent.title || "";
      const legalUrl = buildLegalElementsUrl(legalCurrent);

      if (titleText && legalUrl) {
        const link = document.createElement("a");
        link.href = legalUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "legalTitleLink";
        link.textContent = titleText;
        link.title = `Open ${legalCurrent.statute || legalCurrent.id || "statute"} in Wisconsin Statutory Elements`;
        legalCrimeTitleEl.appendChild(link);
      } else {
        legalCrimeTitleEl.textContent = titleText;
      }
    }
    if (legalCrimeStatuteEl) legalCrimeStatuteEl.textContent = legalCurrent.statute || "";

    // Definition under title/statute (hidden until solved or reveal)
    if (legalCrimeDefEl) {
      const shouldShow = legalRevealAll || legalSolved;
      legalCrimeDefEl.textContent = shouldShow ? (legalCurrent.definition || "") : "";
      legalCrimeDefEl.style.display = shouldShow && (legalCurrent.definition || "").trim() ? "" : "none";
    }

    const level = Number(legalDifficultySel?.value || "1");

    legalRender = (legalCurrent.elements || []).map((txt) => {
      const masked = (legalRevealAll || legalSolved) ? txt : maskElementText(txt, level).masked;
      const maskedInfo = maskElementText(txt, level);
      // If solved/reveal, no missing required
      const missingWords = (legalRevealAll || legalSolved) ? [] : maskedInfo.missingWords;
      const missingFullText = (legalRevealAll || legalSolved) ? false : maskedInfo.missingFullText;
      return { original: txt, masked, missingWords, missingFullText };
    });

    if (legalElementsListEl) {
      legalElementsListEl.innerHTML = "";
      legalRender.forEach((row, idx) => {
        const wrap = document.createElement("div");
        wrap.className = "card";
        wrap.style.marginBottom = "12px";

        const h = document.createElement("div");
        h.className = "legalSectionLabel";
        h.textContent = `Element ${idx + 1}`;
        wrap.appendChild(h);

        const t = document.createElement("div");
        t.className = "legalElementText";
        t.textContent = row.masked;
        wrap.appendChild(t);

        const inputLabel = document.createElement("div");
        inputLabel.className = "legalSmallLabel";
        inputLabel.textContent = legalSolved || legalRevealAll ? "Completed element" : "Your answer";
        wrap.appendChild(inputLabel);

        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "legalInput";
        inp.autocomplete = "off";
        inp.spellcheck = false;
        inp.dataset.idx = String(idx);

        if (legalSolved || legalRevealAll) {
          inp.value = "Completed";
          inp.disabled = true;
        } else {
          inp.value = legalDraftAnswers[idx] || "";
          const status = legalLastCheckResults[idx];
          if (status === true) inp.classList.add("goodInput");
          if (status === false) inp.classList.add("badInput");
          inp.addEventListener("input", () => {
            const i = Number(inp.dataset.idx || "0");
            legalDraftAnswers[i] = inp.value;
            legalLastCheckResults[i] = undefined;
            inp.classList.remove("goodInput", "badInput");
          });
        }

        wrap.appendChild(inp);
        legalElementsListEl.appendChild(wrap);
      });
    }

    updateLegalProgressLine();
  }

  function checkLegalAnswers() {
    if (!legalCurrent) return;
    const inputs = Array.from(legalElementsListEl?.querySelectorAll("input.legalInput") || []);
    let correctCount = 0;

    legalLastCheckResults = [];

    inputs.forEach((inp) => {
      const idx = Number(inp.dataset.idx || "0");
      const row = legalRender[idx];
      if (!row) return;

      const user = (inp.value || "").trim();
      legalDraftAnswers[idx] = user;

      let ok = false;
      if (legalRevealAll || legalSolved) {
        ok = true;
      } else if (row.missingFullText) {
        ok = normalizeText(user) === normalizeText(row.original);
      } else {
        const normUser = normalizeText(user);
        ok = row.missingWords.every(w => normUser.includes(normalizeText(w)));
      }

      legalLastCheckResults[idx] = ok;
      inp.classList.remove("goodInput", "badInput");
      inp.classList.add(ok ? "goodInput" : "badInput");

      if (ok) correctCount++;
    });

    if (correctCount === legalRender.length) {
      legalSolved = true;

      const completed = loadLegalCompletedSet();
      completed.add(legalCurrent.id);
      saveLegalCompletedSet(completed);

      legalRevealAll = false;
      resetLegalAttemptState();
      if (legalFeedbackEl) {
        legalFeedbackEl.textContent = `Correct. You completed ${legalCurrent.statute} - ${legalCurrent.title}.`;
      }
      renderLegal();
    } else {
      if (legalFeedbackEl) legalFeedbackEl.textContent = `You have ${correctCount}/${legalRender.length} correct.`;
    }
  }

  function revealAllLegal() {
    if (!legalCurrent) return;
    legalRevealAll = true;
    legalSolved = true; // treat as solved for display/fill purposes (does not auto-mark completed)
    resetLegalAttemptState();
    if (legalFeedbackEl) legalFeedbackEl.textContent = "Revealed.";
    renderLegal();
  }

  async function ensureLegalReady() {
    await loadLegalDataset();
    updateLegalProgressLine();
    if (!legalCurrent) {
      legalCurrent = pickNextLegalCrime();
      legalRevealAll = false;
      legalSolved = false;
      resetLegalAttemptState();
    }
    renderLegal();
  }

  async function startNewLegalCrime() {
    await loadLegalDataset();
    legalCurrent = pickNextLegalCrime();
    legalRevealAll = false;
    legalSolved = false;
    resetLegalAttemptState();
    renderLegal();
  }

// ---------- init ----------
  async function init() {
    loadFromStorage();

    // Default to map UI
    setLegalUiVisible(false);
    legalActive = false;

    // Restore sidebar state
    setSidebarCollapsed(localStorage.getItem(UI_KEYS.sidebarCollapsed) === "1");
    syncResponsiveUi();

    refreshUI();
    renderTargetsList();
    render();
    loadLockedImage(mapUrl());
    await loadHotspotsFromRepo(hotspotsUrl());
  }

  init();
})();
