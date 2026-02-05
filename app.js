(() => {
  // ---- CONFIG ----
  const QUIZZES = {
    map1: { id: "map1", tabId: "tabMap1", label: "Map Quiz", mapFile: "map.png", hotspotsFile: "hotspots.json" },
    map2: { id: "map2", tabId: "tabMap2", label: "Beat/Radio Quiz", mapFile: "map2.png", hotspotsFile: "hotspots2.json" }
  };
  let activeQuizId = "map1";
  const mapUrl = () => new URL(QUIZZES[activeQuizId].mapFile, window.location.href).toString();
  const hotspotsUrl = () => new URL(QUIZZES[activeQuizId].hotspotsFile, window.location.href).toString();


  // How close the cursor must be to a route to hover/highlight/click it (in pixels on the canvas)
  const ROUTE_HIT_TOL = 14;

  // ---------- storage ----------
  const lsKey = (kind) => `mapQuiz.${activeQuizId}.${kind}.v1`;

  const UI_KEYS = {
    sidebarCollapsed: "mapQuiz.sidebarCollapsed.v1"
  };

  // Zoom behavior (scroll wheel)
  const WRAP_PAD = 12;
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 6;
  const ZOOM_STEP_IN = 1.12;
  const ZOOM_STEP_OUT = 1 / ZOOM_STEP_IN;

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

  // Tabs (multi-map)
  const tabMap1Btn = document.getElementById("tabMap1");
  const tabMap2Btn = document.getElementById("tabMap2");


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

  function showRouteHoverTip(target, clientX, clientY) {
    if (!routeHoverTip || !target) return;
    const answered = state.answeredIds.has(target.id);
    const label = answered ? (target.answer || "") : "?";
    if (!label) return;

    routeHoverTip.textContent = label;
    routeHoverTip.classList.toggle("answered", answered);

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
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    localStorage.setItem(UI_KEYS.sidebarCollapsed, collapsed ? "1" : "0");
    if (toggleSidebarBtn) toggleSidebarBtn.textContent = collapsed ? "»" : "☰";

    applyCanvasDisplaySize();
    render();
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

  function getCanvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const y = (evt.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
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

  function hitTest(target, p) {
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
      return d <= ROUTE_HIT_TOL;
    }
    return false;
  }

  function findHoverTarget(p) {
    // Prefer nearest route/shape within tolerance
    let bestId = null;
    let bestDist = Infinity;

    for (const t of state.targets) {
      if (t.shape === "route") {
        const d = routeMinDistance(t.points, p);
        if (d <= ROUTE_HIT_TOL && d < bestDist) {
          bestDist = d;
          bestId = t.id;
        }
      } else {
        // circle/rect: only hover if hit (inside)
        if (hitTest(t, p)) {
          bestId = t.id;
          bestDist = 0;
          break;
        }
      }
    }
    return bestId;
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

  // ---------- events ----------

  // Sidebar collapse toggle (persisted)
  toggleSidebarBtn.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    setSidebarCollapsed(collapsed);
  });

  // Scroll-wheel zoom on the map (works in both Quiz/Edit)
  canvasWrap.addEventListener("wheel", (e) => {
    if (!state.imgLoaded) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP_IN : ZOOM_STEP_OUT;
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Re-fit canvas display on resize (keeps scroll position roughly stable)
  window.addEventListener("resize", () => {
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
    if (tabMap1Btn) {
      const on = activeQuizId === "map1";
      tabMap1Btn.classList.toggle("active", on);
      tabMap1Btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (tabMap2Btn) {
      const on = activeQuizId === "map2";
      tabMap2Btn.classList.toggle("active", on);
      tabMap2Btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  async function switchQuiz(nextId) {
    if (!QUIZZES[nextId] || nextId === activeQuizId) return;

    try { saveTargets(); } catch {}
    try { saveProgress(); } catch {}

    activeQuizId = nextId;
    setActiveTabUI();

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
    if (!state.imgLoaded) return;

    // Tooltip/hover only in Quiz mode and not during Reveal All
    if (state.mode !== "quiz" || state.showHotspots) {
      if (state.hoverId) state.hoverId = null;
      hideRouteHoverTip();
      render();
      return;
    }

    const p = getCanvasPoint(evt);
    const hover = findHoverTarget(p);

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
    if (state.hoverId) {
      state.hoverId = null;
      render();
    }
    hideRouteHoverTip();
  });

  canvas.addEventListener("mousedown", (evt) => {
    if (!state.imgLoaded) return;

    if (state.mode === "edit" && state.tool === "rect") {
      const p = getCanvasPoint(evt);
      state.rectDrag = { start: p, end: p };
      render();
    }
  });

  canvas.addEventListener("mousemove", (evt) => {
    if (!state.rectDrag) return;
    state.rectDrag.end = getCanvasPoint(evt);
    render();
  });

  // Double-click finishes a route draft (edit mode)
  canvas.addEventListener("dblclick", (evt) => {
    if (!state.imgLoaded) return;
    if (state.mode === "edit" && state.tool === "route") {
      finishRouteDraft();
    }
  });

  canvas.addEventListener("mouseup", (evt) => {
    if (!state.imgLoaded) return;
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
      // click whichever target is hit (routes use distance tolerance)
      const hit = state.targets.find(t => hitTest(t, p));
      if (!hit) return;
      if (state.answeredIds.has(hit.id)) return;
      askAnswerForTarget(hit);
    }
  });

  // ---------- init ----------
  async function init() {
    loadFromStorage();

    // Restore sidebar state
    setSidebarCollapsed(localStorage.getItem(UI_KEYS.sidebarCollapsed) === "1");

    refreshUI();
    renderTargetsList();
    render();
    loadLockedImage(mapUrl());
    await loadHotspotsFromRepo(hotspotsUrl());
  }

  init();
})();
