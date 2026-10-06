/* DOM 控制层：所有业务规则都调 BrocadeCore，本文件只负责界面与交互。 */
(function () {
  "use strict";
  const Core = window.BrocadeCore;
  const Srv = window.BrocadeServer;

  const COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];
  const COLOR_COUNT = COLORS.length;
  const KIND_LABEL = {
    "plan.create": "方案建立",
    "plan.migrate": "旧稿迁入",
    "batch.lock": "批次锁定",
    "batch.start": "开织",
    "batch.recheck": "容量调整",
    "package.generate": "交付包生成"
  };

  const el = (id) => document.getElementById(id);
  const gridEl = el("grid"), paletteEl = el("palette"), statsEl = el("stats");
  const conflictsEl = el("conflicts"), conflictCountEl = el("conflictCount");
  const packagesEl = el("packages"), batchPanelEl = el("batchPanel");
  const planSelectEl = el("planSelect"), planMetaEl = el("planMeta"), outboxLogEl = el("outboxLog");

  const server = Srv.createServer();
  const transport = Srv.createTransport(server);
  let repo = new Core.Repository({ transport });

  let view = "workshop";
  let activeColor = 1;
  let dragging = false;
  let logLines = [];

  /* ------------------------------- 日志 ------------------------------- */
  function log(msg, cls) {
    const t = new Date().toLocaleTimeString();
    logLines.push((cls ? "<span class='" + cls + "'>" : "") + "[" + t + "] " + msg + (cls ? "</span>" : ""));
    if (logLines.length > 60) logLines.shift();
    outboxLogEl.innerHTML = logLines.join("\n");
    outboxLogEl.scrollTop = outboxLogEl.scrollHeight;
  }

  /* ------------------------------- 启动 ------------------------------- */
  function boot() {
    // 旧稿（无批次号）自动迁成首版
    if (!repo.current() && localStorage.getItem(Core.LEGACY_KEY)) {
      const migrated = repo.bootstrapLegacy(COLOR_COUNT);
      if (migrated) log("旧方案缺批次号，已迁入 " + migrated.batchNo + "（首版 V1）", "ok2");
    }
    if (!repo.current()) {
      const p = repo.newPlan({ name: "新纹样 " + new Date().toLocaleDateString(), cols: 18, rows: 14, colorCount: COLOR_COUNT });
      log("建立方案 " + p.batchNo + " V1");
    }
    renderAll();
  }

  /* ------------------------------- 渲染 ------------------------------- */
  function renderAll() {
    renderPlanSelect();
    renderMeta();
    renderPalette();
    renderGrid();
    renderStats();
    renderConflicts();
    renderBatch();
    renderPackages();
    renderOutbox();
    renderNet();
  }

  function renderPlanSelect() {
    const plans = repo.listPlans();
    const cur = repo.current();
    planSelectEl.innerHTML = plans.map((p) =>
      "<option value='" + p.id + "'" + (cur && p.id === cur.id ? " selected" : "") + ">" +
      p.batchNo + " · V" + p.version + " · " + escapeHtml(p.name) + "</option>"
    ).join("");
  }

  function renderMeta() {
    const p = repo.current();
    if (!p) { planMetaEl.innerHTML = ""; return; }
    const status = statusBadge(p);
    planMetaEl.innerHTML =
      "<b>批次号</b><span>" + p.batchNo + "</span>" +
      "<b>版本</b><span>V" + p.version + "（rev " + p.revision + "）</span>" +
      "<b>网格</b><span>经" + p.cols + "列 × 纬" + p.rows + "行</span>" +
      "<b>状态</b><span>" + status + "</span>";
  }

  function statusBadge(p) {
    if (p.batch && p.batch.status === "weaving") return "<span class='badge weaving'>开织中（快照已冻结）</span>";
    if (Core.hasOpenConflicts(p)) return "<span class='badge conflict'>有未处理冲突</span>";
    if (!p.confirmed) return "<span class='badge merged'>待确认合版</span>";
    return "<span class='badge confirmed'>已确认</span>";
  }

  function renderPalette() {
    paletteEl.innerHTML = COLORS.map((c, i) =>
      "<button class='swatch " + (i === activeColor ? "active" : "") + "' data-color='" + i +
      "' style='background:" + c + "' title='色线" + i + "'><span>" + i + "</span></button>"
    ).join("");
    paletteEl.querySelectorAll("[data-color]").forEach((b) =>
      b.onclick = () => { activeColor = Number(b.dataset.color); renderPalette(); });
  }

  function viewCells(p) {
    if (view === "workshop") return p.workshop.cells;
    if (view === "sample") return p.sample.cells;
    return Core.currentCells(p);
  }

  function renderGrid() {
    const p = repo.current();
    el("viewHint").innerHTML = viewHintText(p);
    const cells = viewCells(p);
    const wTouched = new Set(p.workshop.touched), sTouched = new Set(p.sample.touched);
    const conflictMap = new Map((p.pendingMerge ? p.pendingMerge.conflicts : []).map((c) => [c.index, c]));
    gridEl.style.gridTemplateColumns = "repeat(" + p.cols + ", 1fr)";
    gridEl.innerHTML = cells.map((v, i) => {
      const cls = ["cell"];
      let inner = "";
      if (view !== "merged") cls.push("view");
      if (view === "workshop" && wTouched.has(i)) { cls.push("touched-w"); inner = "<span class='tick'>车</span>"; }
      if (view === "sample" && sTouched.has(i)) { cls.push("touched-s"); inner = "<span class='tick'>样</span>"; }
      if (view === "merged") {
        const w = wTouched.has(i), s = sTouched.has(i);
        if (w && s) cls.push("touched-b");
        else if (w) cls.push("touched-w");
        else if (s) cls.push("touched-s");
        const c = conflictMap.get(i);
        if (c) cls.push(c.resolution ? "resolved" : "conflict");
      }
      return "<div class='" + cls.join(" ") + "' data-i='" + i +
        "' style='background:" + COLORS[v] + "' title='第" + (i + 1) + "格 / 色" + v + "'>" + inner + "</div>";
    }).join("");
    gridEl.querySelectorAll(".cell").forEach((cEl) => {
      cEl.onpointerdown = () => { if (view === "merged") return; dragging = true; paint(Number(cEl.dataset.i)); };
      cEl.onpointerenter = () => { if (dragging && view !== "merged") paint(Number(cEl.dataset.i)); };
    });
    window.onpointerup = () => { dragging = false; };
  }

  function viewHintText(p) {
    if (view === "workshop") return "车间稿：拖动连续填色（蓝框＝车间改过的格）。改动会让已确认结论与交付包失效。";
    if (view === "sample") return "打样间稿：拖动连续填色（橙框＝打样改过的格）。";
    const open = Core.openConflicts(p).length;
    return "合版视图：同格两边都改时<b class='warning'>保留车间值</b>，红框为待处理冲突（" + open +
      "），绿框为已裁决。冲突未处理不会生成交付包。";
  }

  function paint(index) {
    const p = repo.current();
    const res = Core.editCells(p, view, [{ index, color: activeColor }]);
    if (res.changed.length) {
      const n = Core.invalidatePackagesOnEdit(p);
      repo.save();
      if (n) log(p.batchNo + "：色号变化，" + n + " 个旧交付包已失效，统计/断线重算", "err");
      renderAll();
    }
  }

  /* ---------------- 统计（随当前网格重算；开织批次另显冻结快照） ---------------- */
  function renderStats() {
    const p = repo.current();
    const cells = Core.currentCells(p);
    const usage = Core.computeUsage(cells, COLOR_COUNT);
    const risk = Core.computeRisk(cells, p.cols, p.rows);
    const b = p.batch;
    statsEl.innerHTML =
      "<div class='muted'>当前" + (view === "merged" ? "合版" : view === "workshop" ? "车间" : "打样") + "网格用量：</div>" +
      usage.map((n, i) => {
        let extra = "";
        if (b) {
          const cap = b.capacities[i];
          if (cap != null) {
            const gap = Math.max(0, n - cap);
            extra = gap > 0
              ? "<span class='gap'>缺 " + gap + "</span>"
              : "<span class='cap'>容" + cap + "</span>";
          } else extra = "<span class='cap'>容量不限</span>";
        }
        return "<div class='stat'><span><span class='chip' style='background:" + COLORS[i] + "'></span> 色线" + i +
          " <b>" + n + "</b></span><span>" + extra + "</span></div>";
      }).join("") +
      (risk.hasRisk
        ? "<p class='warning'>⚠ " + risk.note + "</p>"
        : "<p class='ok'>✓ " + risk.note + "</p>") +
      (b && b.snapshot
        ? "<p class='muted'>开织批次冻结快照 V" + b.snapshot.version + " 用量：" +
          b.snapshot.usage.map((n, i) => n ? "色" + i + "×" + n : "").filter(Boolean).join("，") +
          "（" + b.snapshot.checksum + "）</p>"
        : "");
  }

  /* ------------------------------- 冲突 ------------------------------- */
  function renderConflicts() {
    const p = repo.current();
    const all = p.pendingMerge ? p.pendingMerge.conflicts : [];
    const open = all.filter((c) => !c.resolution);
    conflictCountEl.style.display = open.length ? "inline-block" : "none";
    conflictCountEl.textContent = open.length ? open.length + " 处未处理" : "";
    if (!all.length) {
      conflictsEl.className = "muted";
      conflictsEl.innerHTML = "无冲突。车间/打样改完后点「合版」。";
      return;
    }
    conflictsEl.className = "";
    conflictsEl.innerHTML = all.map((c) => {
      const done = !!c.resolution;
      return "<div class='conflict-row " + (done ? "resolved" : "") + "'>" +
        "第 " + (c.index + 1) + " 格：车间 <span class='chip' style='background:" + COLORS[c.workshop] + "'></span>色" + c.workshop +
        " ／ 打样 <span class='chip' style='background:" + COLORS[c.sample] + "'></span>色" + c.sample +
        (done
          ? "<div class='ok'>已保留：<span class='chip' style='background:" + COLORS[c.resolution.color] + "'></span>色" + c.resolution.color + "</div>"
          : "<div class='opts'>" +
            "<button class='small' data-resolve='" + c.index + "|workshop'>保留车间值 色" + c.workshop + "</button>" +
            "<button class='small secondary' data-resolve='" + c.index + "|sample'>采用打样值 色" + c.sample + "</button>" +
            "</div>") +
        "</div>";
    }).join("");
    conflictsEl.querySelectorAll("[data-resolve]").forEach((btn) =>
      btn.onclick = () => {
        const [i, keep] = btn.dataset.resolve.split("|");
        Core.resolveConflict(repo.current(), Number(i), keep);
        repo.save();
        log("冲突裁决：第" + (Number(i) + 1) + "格保留" + (keep === "workshop" ? "车间" : "打样") + "值");
        renderAll();
      });
  }

  /* ------------------------------- 批次 ------------------------------- */
  function renderBatch() {
    const p = repo.current();
    const b = p.batch;
    if (!b) {
      batchPanelEl.innerHTML =
        "<div class='muted'>尚无锁定批次。确认新版后锁定经向列数、纬向行数与色线容量。</div>" +
        "<label>各色线容量（空＝不限）</label>" + capacityInputs(null) +
        "<button id='lockBtn' style='margin-top:8px'>锁定批次</button>";
      bindLock();
      return;
    }
    const badge = "<span class='badge " + b.status + "'>" + statusText(b.status) + "</span>";
    let queued = "";
    if (b.status === "queued") {
      const gaps = b.shortfall.perColor.filter((x) => x.gap > 0)
        .map((x) => "<span class='chip' style='background:" + COLORS[x.color] + "'></span>色" + x.color +
          " 需" + x.need + "/容" + x.capacity + " <span class='gap'>缺" + x.gap + "</span>").join("；");
      queued = "<p class='warning'>⚠ 超色线容量，批次排队。缺口：" + gaps + "</p>";
    }
    batchPanelEl.innerHTML =
      "<div style='display:flex;justify-content:space-between;align-items:center'>" +
      "<b>" + b.batchNo + "（第" + b.seq + "批）</b>" + badge + "</div>" +
      "<div class='meta'><b>锁定网格</b><span>经" + b.lockedDims.cols + "列 × 纬" + b.lockedDims.rows + "行" +
      "（基于 V" + b.lockedVersion + "）</span></div>" +
      queued +
      "<label>色线容量（空＝不限；改后点调整重算）</label>" + capacityInputs(b) +
      "<div class='toolbar' style='margin-top:8px'>" +
      "<button id='recheckBtn' class='secondary small'>调整容量重算</button>" +
      (b.status === "locked" ? "<button id='startBtn' class='small'>开织（冻结快照）</button>" : "") +
      (b.status === "weaving" ? "<button id='closeBtn' class='secondary small'>批次收尾</button>" : "") +
      "</div>" +
      (b.snapshot ? "<p class='muted'>已开织，快照 " + b.snapshot.checksum + " 保留原用量/断线结论，后续改格不影响。</p>" : "");
    const rb = el("recheckBtn");
    if (rb) rb.onclick = () => recheck();
    const sb = el("startBtn");
    if (sb) sb.onclick = () => start();
    const cb = el("closeBtn");
    if (cb) cb.onclick = () => closeBatch();
  }

  function capacityInputs(b) {
    return "<table class='caps'><tr>" + Array.from({ length: COLOR_COUNT }, (_, i) =>
      "<td><span class='chip' style='background:" + COLORS[i] + "'></span>色" + i +
      "</td>").join("") + "</tr><tr>" + Array.from({ length: COLOR_COUNT }, (_, i) =>
      "<td><input type='number' min='0' data-cap='" + i + "' value='" +
      (b && b.capacities[i] != null ? b.capacities[i] : "") + "' placeholder='—'></td>").join("") +
      "</tr></table>";
  }

  function readCapacities() {
    const caps = {};
    batchPanelEl.querySelectorAll("[data-cap]").forEach((inp) => {
      caps[inp.dataset.cap] = inp.value === "" ? null : Number(inp.value);
    });
    return caps;
  }

  function bindLock() {
    const btn = el("lockBtn");
    if (!btn) return;
    btn.onclick = () => {
      const p = repo.current();
      if (!p.confirmed) {
        // 允许直接基于最新改动锁定，但必须先合版且无冲突
        if (!p.pendingMerge) Core.mergePlan(p);
        if (Core.hasOpenConflicts(p)) { alert("还有冲突未处理，不能锁定批次"); return; }
        Core.confirmPlan(p);
      }
      const b = Core.lockBatch(p, readCapacities());
      repo.save();
      repo.submitOutbox({ batchNo: b.batchNo, kind: "batch.lock", dedup: b.seq, payload: { seq: b.seq, dims: b.lockedDims, version: b.lockedVersion } });
      log(b.batchNo + " 批次锁定：经" + b.lockedDims.cols + "×纬" + b.lockedDims.rows +
        (b.status === "queued" ? "，超容量排队，缺口 " + b.shortfall.total : "，容量满足"), b.status === "queued" ? "err" : "ok2");
      renderAll();
    };
  }

  function recheck() {
    const p = repo.current();
    p.batch.recheckSeq = (p.batch.recheckSeq || 0) + 1;
    Core.recheckBatch(p.batch, readCapacities());
    repo.save();
    repo.submitOutbox({
      batchNo: p.batchNo, kind: "batch.recheck",
      dedup: p.batch.seq + "-" + p.batch.recheckSeq,
      payload: { seq: p.batch.seq, status: p.batch.status, gap: p.batch.shortfall.total }
    });
    log(p.batchNo + " 容量重算 -> " + statusText(p.batch.status) +
      (p.batch.shortfall.total ? "（缺口 " + p.batch.shortfall.total + "）" : ""),
      p.batch.status === "queued" ? "err" : "ok2");
    renderAll();
  }

  function start() {
    const p = repo.current();
    Core.startBatch(p.batch);
    repo.save();
    repo.submitOutbox({ batchNo: p.batchNo, kind: "batch.start", dedup: p.batch.seq, payload: { seq: p.batch.seq, checksum: p.batch.snapshot.checksum } });
    log(p.batchNo + " 已开织，快照冻结：" + p.batch.snapshot.checksum, "ok2");
    renderAll();
  }

  function closeBatch() {
    const p = repo.current();
    Core.closeBatch(p.batch);
    // 收尾后允许下一批：保留历史，把批次移入 history
    p.batchHistory = p.batchHistory || [];
    p.batchHistory.push(p.batch);
    p.batch = null;
    repo.save();
    log("批次收尾，可锁定下一批");
    renderAll();
  }

  function statusText(s) {
    return { queued: "排队（容量缺口）", locked: "已锁定待开织", weaving: "开织中", closed: "已收尾" }[s] || s;
  }

  /* ------------------------------- 交付包 ------------------------------- */
  function renderPackages() {
    const p = repo.current();
    const b = p.batch;
    const list = b ? b.packages : [];
    packagesEl.innerHTML =
      "<button id='pkgBtn' class='small' " + (!b ? "disabled" : "") + ">生成交付包</button>" +
      "<p class='muted' style='margin:6px 0'>冲突未处理或批次排队时不生成；已开织批次出冻结版交付包。</p>" +
      (list.length ? list.map((k) =>
        "<div class='conflict-row " + (k.frozen ? "resolved" : "") + "'><b>" + k.id + "</b>" +
        " <span class='badge " + (k.frozen ? "weaving" : "confirmed") + "'>" + (k.frozen ? "冻结版（开织快照）" : "当前版") + "</span>" +
        "<div class='muted'>V" + k.version + " · 经" + k.dims.cols + "×纬" + k.dims.rows + " · " + k.checksum + "</div>" +
        "<div class='muted'>用量：" + k.usage.map((n, i) => n ? "色" + i + "×" + n : "").filter(Boolean).join("，") + "</div>" +
        (k.risk.hasRisk ? "<div class='warning'>⚠ " + k.risk.note + "</div>" : "<div class='ok'>✓ " + k.risk.note + "</div>") +
        "</div>").join("") : "<div class='muted'>尚无交付包。</div>");
    el("pkgBtn").onclick = makePackage;
  }

  function makePackage() {
    const p = repo.current();
    try {
      const pkg = Core.generatePackage(p);
      repo.save();
      repo.submitOutbox({ batchNo: pkg.batchNo, kind: "package.generate", dedup: pkg.id, payload: { id: pkg.id, checksum: pkg.checksum, frozen: pkg.frozen } });
      log("交付包 " + pkg.id + " 已生成" + (pkg.frozen ? "（冻结版）" : ""), "ok2");
      renderAll();
    } catch (e) {
      log("交付包被拦截：" + e.message, "err");
      alert(e.message);
    }
  }

  /* ------------------------------- 合版/确认 ------------------------------- */
  el("mergeBtn").onclick = () => {
    const p = repo.current();
    const m = Core.mergePlan(p);
    repo.save();
    log("合版完成：" + m.conflicts.length + " 处同格双改（保留车间值），" +
      (m.conflicts.length ? "其中 " + Core.openConflicts(p).length + " 处待裁决" : "无冲突"),
      m.conflicts.length ? "err" : "ok2");
    view = "merged";
    document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("active", b.dataset.view === "merged"));
    renderAll();
  };

  el("confirmBtn").onclick = () => {
    const p = repo.current();
    try {
      const hadBatch = !!p.batch && p.batch.status !== "weaving" && p.batch.status !== "closed";
      Core.confirmPlan(p);
      if (hadBatch) Core.refreshBatchAfterConfirm(p);
      repo.save();
      log(p.batchNo + " 确认新版 V" + p.version + "；统计/断线按新网格重算" + (hadBatch ? "，未开织批次缺口与交付包重算" : "，开织批次保留原快照"), "ok2");
      renderAll();
    } catch (e) {
      log("确认被拦截：" + e.message, "err");
      alert(e.message);
    }
  };

  document.querySelectorAll("#viewSeg button").forEach((b) =>
    b.onclick = () => {
      view = b.dataset.view;
      document.querySelectorAll("#viewSeg button").forEach((x) => x.classList.toggle("active", x === b));
      renderGrid(); renderStats(); renderConflicts();
    });

  /* ------------------------------- 方案管理 ------------------------------- */
  planSelectEl.onchange = () => { repo.state.currentPlanId = planSelectEl.value; repo.save(); renderAll(); };

  el("newPlanBtn").onclick = () => {
    const cols = 18, rows = 14;
    const p = repo.newPlan({ name: "纹样 " + new Date().toLocaleTimeString(), cols, rows, colorCount: COLOR_COUNT });
    log("建立方案 " + p.batchNo + " V1");
    renderAll();
  };

  el("importLegacyBtn").onclick = () => {
    // 造一份“旧稿”：无批次号的 zfl31Pattern 结构
    const cells = Array(18 * 14).fill(0);
    for (let i = 0; i < 40; i++) cells[10 + i] = 2;
    localStorage.setItem(Core.LEGACY_KEY, JSON.stringify({ cols: 18, rows: 14, cells }));
    const p = repo.bootstrapLegacy(COLOR_COUNT);
    if (p) { log("旧稿迁入 " + p.batchNo + " V1", "ok2"); renderAll(); }
  };

  el("resetDemoBtn").onclick = () => {
    if (!confirm("清空本机全部排产数据？")) return;
    localStorage.removeItem(Core.STATE_KEY);
    localStorage.removeItem(Core.LEGACY_KEY);
    location.reload();
  };

  el("exportBtn").onclick = () => {
    const p = repo.current();
    const data = {
      batchNo: p.batchNo, version: p.version, revision: p.revision,
      cols: p.cols, rows: p.rows, cells: Core.currentCells(p),
      usage: Core.computeUsage(Core.currentCells(p), COLOR_COUNT),
      risk: Core.computeRisk(Core.currentCells(p), p.cols, p.rows),
      batch: p.batch ? {
        status: p.batch.status, lockedDims: p.batch.lockedDims, capacities: p.batch.capacities,
        shortfall: p.batch.shortfall, snapshot: p.batch.snapshot,
        packages: p.batch.packages
      } : null
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "brocade-" + p.batchNo + "-v" + p.version + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ------------------------------- 网络/恢复 ------------------------------- */
  function renderNet() {
    el("netDot").className = "dot " + (transport.online ? "on" : "off");
    el("netText").textContent = transport.online ? "通道在线" : "通道离线（回传将挂起）";
    el("toggleNetBtn").textContent = transport.online ? "断开网络" : "恢复联网";
  }

  el("toggleNetBtn").onclick = () => {
    if (transport.online) { transport.setOffline(); log("网络已断开，之后的回传保留为 pending"); }
    else { transport.setOnline(); log("网络恢复，可点「按批次号恢复同步」补发"); }
    renderNet();
  };

  el("interruptBtn").onclick = () => { transport.interrupt(1); log("下一次写入将中断（pending 保留，可恢复）"); };

  el("recoverBtn").onclick = () => {
    const before = Core.recoveryReport(repo.outbox());
    transport.setOnline();
    repo.recover().then((r) => {
      log("按批次号恢复：扫描 " + before.pending + " 条待发，确认 " + r.acked + " 条，仍待发 " + r.stillPending + " 条",
        r.stillPending ? "err" : "ok2");
      renderAll();
    }).catch((e) => log("恢复失败：" + e.message, "err"));
  };

  el("dupBtn").onclick = () => {
    const p = repo.current();
    if (p.batch) {
      // 旧稿晚回：同一批次号 + 同一批次序号的锁定回传，但内容已不同 -> 拒绝覆盖
      const dedup = p.batch.seq;
      try {
        repo.submitOutbox({ batchNo: p.batchNo, kind: "batch.lock", dedup, payload: { stale: true, at: Date.now() } });
        log("不应出现：旧稿重复回传被接受", "err");
      } catch (e) {
        log("旧稿晚回被拒：" + p.batchNo + " 第" + dedup + "批已有首传，重复回传只认首次", "err");
        alert(e.message);
      }
    } else {
      // 还没锁批：同一条回传连续回两次，第二次命中判重
      const payload = { seq: 1, dims: { cols: p.cols, rows: p.rows } };
      repo.submitOutbox({ batchNo: p.batchNo, kind: "batch.lock", dedup: 1, payload });
      const again = repo.submitOutbox({ batchNo: p.batchNo, kind: "batch.lock", dedup: 1, payload });
      log(again.duplicate ? "重复回传命中判重：只认首次，未重复入队" : "已登记首传", again.duplicate ? "ok2" : "");
    }
    renderAll();
  };

  function renderOutbox() {
    const box = repo.outbox();
    if (!box.length) { outboxLogEl.textContent = "（空）"; return; }
    const rep = Core.recoveryReport(box);
    const head = "共" + rep.total + " 待发" + rep.pending + " 已确认" + rep.acked;
    const rows = box.map((r) => {
      const icon = r.status === "acked" ? "✓" : r.status === "sent" ? "…" : "⏳";
      const err = r.lastError ? " <span class='err'>" + r.lastError.code + "</span>" : "";
      return icon + " " + r.batchNo + " " + (KIND_LABEL[r.kind] || r.kind) +
        "（试" + r.attempts + "次）" + err;
    });
    outboxLogEl.innerHTML = "<b>" + head + "</b>\n" + rows.join("\n");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  boot();
})();
