/*
 * 手工织锦纹样可恢复排产台 —— 核心层（不依赖 DOM，浏览器与 Node 共用）
 *
 * 覆盖规则：
 *  1. 车间与打样间各自改一版；合版时同一格两边都改过 -> 保留车间值，另一版留冲突。
 *  2. 冲突未处理：不能确认，也不能生成交付包。
 *  3. 批次锁定经向列数、纬向行数、各色线容量；用量超容量即排队，并写明每个色号缺口。
 *  4. 任一格色号变化 -> 用色统计 / 断线风险 / 交付包失效全部重算；已开织批次保留原快照。
 *  5. 回传队列以批次号为幂等键：断网/写入中断后按批次号恢复，重复回传只认首次。
 *  6. 旧方案（无批次号）迁入 -> 分配首批次号，记为首版（version = 1）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BrocadeCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------- 基础工具 ------------------------------- */

  function assert(cond, code, message) {
    if (!cond) {
      const err = new Error(message || code);
      err.code = code;
      throw err;
    }
  }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(value[k]);
    }).join(",") + "}";
  }

  // djb2，仅作快照指纹，非加密用途
  function checksum(value) {
    const str = stableStringify(value);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return "s" + (h >>> 0).toString(36) + "_" + str.length.toString(36);
  }

  function nowIso() { return new Date().toISOString(); }

  function padNo(n) { return "B" + String(n).padStart(4, "0"); }

  function makeCells(cols, rows, fill) { return Array(cols * rows).fill(fill == null ? 0 : fill); }

  function clampDims(cols, rows) {
    cols = Number(cols); rows = Number(rows);
    assert(Number.isInteger(cols) && cols >= 6 && cols <= 36, "BAD_DIMS", "经向列数须为 6-36 的整数");
    assert(Number.isInteger(rows) && rows >= 6 && rows <= 32, "BAD_DIMS", "纬向行数须为 6-32 的整数");
    return [cols, rows];
  }

  function computeUsage(cells, colorCount) {
    const usage = Array(colorCount).fill(0);
    for (const v of cells) if (v >= 0 && v < colorCount) usage[v]++;
    return usage;
  }

  // 换色过密的纬行即断线风险行；阈值沿用原排版台 0.62
  function computeRisk(cells, cols, rows) {
    const riskRows = [];
    for (let y = 0; y < rows; y++) {
      let switches = 0;
      for (let x = 1; x < cols; x++) {
        if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
      }
      if (switches > cols * 0.62) riskRows.push(y + 1);
    }
    return {
      riskRows: riskRows,
      hasRisk: riskRows.length > 0,
      note: riskRows.length ? "第" + riskRows.join("、") + "行换色过密，可能断线" : "暂无明显断线风险"
    };
  }

  function buildSnapshot(cells, cols, rows, colorCount, version) {
    const usage = computeUsage(cells, colorCount);
    const risk = computeRisk(cells, cols, rows);
    return {
      version: version,
      cols: cols,
      rows: rows,
      cells: cells.slice(),
      usage: usage,
      risk: risk,
      checksum: checksum({ v: version, c: cols, r: rows, cells: cells }),
      capturedAt: nowIso()
    };
  }

  /* ------------------------------- 纹样方案 ------------------------------- */

  /**
   * 新建方案：分配批次号、首版。
   */
  function createPlan(input) {
    input = input || {};
    const dims = clampDims(input.cols || 18, input.rows || 14);
    const colorCount = input.colorCount || 8;
    const cols = dims[0], rows = dims[1];
    const ts = nowIso();
    return {
      id: input.id || ("P" + Math.abs(hash(ts + Math.random())).toString(36)),
      name: input.name || "未命名纹样",
      batchNo: input.batchNo, // 由仓库分配
      version: 1,
      revision: 0,
      cols: cols,
      rows: rows,
      colorCount: colorCount,
      baseCells: makeCells(cols, rows, 0),       // 已确认基线
      workshop: { cells: makeCells(cols, rows, 0), touched: [] },
      sample: { cells: makeCells(cols, rows, 0), touched: [] },
      pendingMerge: null,                        // { cells, touched, conflicts:[{index,workshop,sample,resolution}], mergedRevision }
      confirmed: true,                          // 无未合入改动即视为已确认
      confirmedSnapshot: null,
      updatedAt: ts
    };
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
  }

  /**
   * 旧方案迁移：无批次号的旧稿分配首批次号，按首版处理。
   * @param legacy { cols, rows, cells, name? }  旧 zfl31Pattern 结构
   */
  function migrateLegacy(legacy, batchNo, colorCount) {
    assert(legacy && Array.isArray(legacy.cells), "BAD_LEGACY", "旧方案缺少 cells");
    const dims = clampDims(legacy.cols, legacy.rows);
    const cols = dims[0], rows = dims[1];
    colorCount = colorCount || 8;
    let cells = legacy.cells;
    if (cells.length !== cols * rows) {
      // 尺寸对不上时重铺，避免索引错位
      cells = makeCells(cols, rows, 0);
    }
    cells = cells.map(function (v) { return (Number.isInteger(v) && v >= 0 && v < colorCount) ? v : 0; });
    const plan = createPlan({
      id: legacy.id,
      name: legacy.name || "迁移自旧排版台",
      cols: cols, rows: rows, colorCount: colorCount, batchNo: batchNo
    });
    plan.baseCells = cells.slice();
    plan.confirmedSnapshot = buildSnapshot(cells, cols, rows, colorCount, 1);
    plan.migratedFromLegacy = true;
    return plan;
  }

  /**
   * 在一侧连续涂色。每次调用产生一个新版本号（revision+1）—— 任一格色号变化即触发重算。
   * @param side "workshop" | "sample"
   * @param changes [{index,color}]
   * @returns {{changed:number[], revision:number}}
   */
  function editCells(plan, side, changes) {
    assert(side === "workshop" || side === "sample", "BAD_SIDE", "侧别须为 workshop/sample");
    const sideObj = plan[side];
    const changed = [];
    const touchSet = new Set(sideObj.touched);
    for (const ch of changes) {
      const i = Number(ch.index), color = Number(ch.color);
      assert(Number.isInteger(i) && i >= 0 && i < plan.cols * plan.rows, "BAD_INDEX", "格号越界");
      assert(Number.isInteger(color) && color >= 0 && color < plan.colorCount, "BAD_COLOR", "色号越界");
      if (sideObj.cells[i] === color) continue;
      sideObj.cells[i] = color;
      touchSet.add(i);
      changed.push(i);
    }
    if (changed.length) {
      plan.revision += 1;
      sideObj.touched = Array.from(touchSet).sort(function (a, b) { return a - b; });
      plan.confirmed = false;
      plan.pendingMerge = null; // 有新改动，原合版结果作废，需要重新合版
      plan.updatedAt = nowIso();
    }
    return { changed: changed, revision: plan.revision };
  }

  /**
   * 合版：
   *  - 两边都改过且值不同 -> 保留车间值，另一版留冲突（待人工裁决）；
   *  - 只一边改过 -> 取该边值；
   *  - 两边同值 -> 直接取值；
   *  - 都没改 -> 基线值。
   */
  function mergePlan(plan) {
    const n = plan.cols * plan.rows;
    const cells = new Array(n);
    const wTouched = new Set(plan.workshop.touched);
    const sTouched = new Set(plan.sample.touched);
    const conflicts = [];
    for (let i = 0; i < n; i++) {
      const w = wTouched.has(i), s = sTouched.has(i);
      if (w && s) {
        if (plan.workshop.cells[i] === plan.sample.cells[i]) {
          cells[i] = plan.workshop.cells[i];
        } else {
          cells[i] = plan.workshop.cells[i]; // 同格两边都改：保留车间值
          conflicts.push({ index: i, workshop: plan.workshop.cells[i], sample: plan.sample.cells[i], resolution: null });
        }
      } else if (w) {
        cells[i] = plan.workshop.cells[i];
      } else if (s) {
        cells[i] = plan.sample.cells[i];
      } else {
        cells[i] = plan.baseCells[i];
      }
    }
    const touched = Array.from(new Set(Array.from(wTouched).concat(Array.from(sTouched)))).sort(function (a, b) { return a - b; });
    plan.pendingMerge = {
      cells: cells,
      touched: touched,
      conflicts: conflicts,
      mergedRevision: plan.revision
    };
    plan.updatedAt = nowIso();
    return plan.pendingMerge;
  }

  function requireMerge(plan) {
    assert(plan.pendingMerge, "NO_MERGE", "请先合版");
    assert(plan.pendingMerge.mergedRevision === plan.revision, "STALE_MERGE", "合版后又有改动，请重新合版");
    return plan.pendingMerge;
  }

  /**
   * 处理冲突：keep = "workshop" | "sample" | 自定义 color 整数。
   */
  function resolveConflict(plan, index, keep) {
    const m = requireMerge(plan);
    const c = m.conflicts.find(function (x) { return x.index === index; });
    assert(c, "NO_CONFLICT", "该格没有待处理冲突");
    let color;
    if (keep === "workshop") color = c.workshop;
    else if (keep === "sample") color = c.sample;
    else {
      color = Number(keep);
      assert(Number.isInteger(color) && color >= 0 && color < plan.colorCount, "BAD_COLOR", "色号越界");
    }
    c.resolution = { choose: keep, color: color, resolvedAt: nowIso() };
    m.cells[index] = color;
    plan.updatedAt = nowIso();
    return c;
  }

  function openConflicts(plan) {
    if (!plan.pendingMerge || plan.pendingMerge.mergedRevision !== plan.revision) return [];
    return plan.pendingMerge.conflicts.filter(function (c) { return !c.resolution; });
  }

  function hasOpenConflicts(plan) { return openConflicts(plan).length > 0; }

  /**
   * 确认合版：冲突全部处理后才能确认；确认产生新一版（version+1）基线与快照。
   */
  function confirmPlan(plan) {
    const m = requireMerge(plan);
    const open = m.conflicts.filter(function (c) { return !c.resolution; });
    assert(!open.length, "UNRESOLVED_CONFLICTS", "还有 " + open.length + " 处冲突未处理，不能确认");
    plan.baseCells = m.cells.slice();
    plan.workshop = { cells: m.cells.slice(), touched: [] };
    plan.sample = { cells: m.cells.slice(), touched: [] };
    plan.version += 1;
    plan.confirmed = true;
    plan.confirmedSnapshot = buildSnapshot(plan.baseCells, plan.cols, plan.rows, plan.colorCount, plan.version);
    plan.pendingMerge = null;
    plan.updatedAt = nowIso();
    return plan;
  }

  /** 当前展示用网格：优先最新合版结果，否则基线 */
  function currentCells(plan) {
    if (plan.pendingMerge && plan.pendingMerge.mergedRevision === plan.revision) return plan.pendingMerge.cells;
    return plan.baseCells;
  }

  /* ------------------------------- 织造批次 ------------------------------- */

  function normalizeCapacities(input, colorCount) {
    const caps = {};
    for (let i = 0; i < colorCount; i++) {
      const raw = input ? input[i] : undefined;
      if (raw === null || raw === undefined || raw === "" || Number(raw) < 0) caps[i] = null; // 不限
      else caps[i] = Math.max(0, Math.floor(Number(raw)));
    }
    return caps;
  }

  /**
   * 锁定批次：经向列数、纬向行数、色线容量写死。
   * 以给定网格用量比对容量，超出 -> 状态 queued，逐色号写明缺口。
   */
  function lockBatch(plan, capacities, cells, seq) {
    assert(plan.batchNo, "NO_BATCH_NO", "方案缺少批次号");
    assert(!plan.batch || plan.batch.status === "weaving" || plan.batch.status === "closed",
      "BATCH_OPEN", "已有未开织的锁定批次，不能重复锁定");
    const dims = clampDims(plan.cols, plan.rows);
    cells = cells || currentCells(plan);
    assert(cells.length === dims[0] * dims[1], "BAD_CELLS", "网格尺寸与批次不一致");
    const caps = normalizeCapacities(capacities, plan.colorCount);
    const usage = computeUsage(cells, plan.colorCount);
    const shortfall = measureShortfall(usage, caps);
    const nextSeq = seq || (plan.batchSeq = (plan.batchSeq || 0) + 1);
    const batch = {
      batchNo: plan.batchNo,
      seq: nextSeq,
      status: shortfall.total > 0 ? "queued" : "locked",
      lockedDims: { cols: dims[0], rows: dims[1] },
      capacities: caps,
      plannedUsage: usage.slice(),
      shortfall: shortfall,
      lockedCells: cells.slice(),
      lockedRevision: plan.revision,
      lockedVersion: plan.version,
      snapshot: null,                 // 开织时冻结
      packages: [],
      lockedAt: nowIso()
    };
    plan.batch = batch;
    plan.updatedAt = nowIso();
    return batch;
  }

  /**
   * 缺口表：per color {need, capacity, gap}，gap>0 即超容量。
   */
  function measureShortfall(usage, capacities) {
    const perColor = usage.map(function (need, i) {
      const cap = capacities[i] == null ? null : capacities[i];
      return { color: i, need: need, capacity: cap, gap: cap == null ? 0 : Math.max(0, need - cap) };
    });
    return { perColor: perColor, total: perColor.reduce(function (s, x) { return s + x.gap; }, 0) };
  }

  /**
   * 容量调整后重新比对（排队中批次的容量补足后自动转锁定）。
   */
  function recheckBatch(batch, capacities) {
    if (capacities) batch.capacities = normalizeCapacities(capacities, Object.keys(batch.capacities).length);
    if (batch.status === "weaving" || batch.status === "closed") return batch; // 已开织不动
    batch.shortfall = measureShortfall(batch.plannedUsage, batch.capacities);
    batch.status = batch.shortfall.total > 0 ? "queued" : "locked";
    return batch;
  }

  /**
   * 开织：冻结快照。此后网格任何变化都不影响该批次（保留原快照）。
   */
  function startBatch(batch) {
    assert(batch.status === "locked", "NOT_LOCKED",
      batch.status === "queued" ? "批次仍在排队（色线容量有缺口），不能开织" : "批次当前状态不能开织");
    batch.status = "weaving";
    batch.startedAt = nowIso();
    batch.snapshot = buildSnapshot(batch.lockedCells, batch.lockedDims.cols, batch.lockedDims.rows,
      batch.plannedUsage.length, batch.lockedVersion);
    return batch;
  }

  function closeBatch(batch) {
    assert(batch.status === "weaving", "NOT_WEAVING", "只有开织中的批次可以收尾");
    batch.status = "closed";
    batch.closedAt = nowIso();
    return batch;
  }

  /**
   * 方案确认新一版后刷新未开织批次：尺寸/用量重比，缺口重算，交付包失效。
   * 已开织批次走冻结快照，不受影响。
   */
  function refreshBatchAfterConfirm(plan) {
    const b = plan.batch;
    if (!b || b.status === "weaving" || b.status === "closed") return b;
    b.lockedDims = { cols: plan.cols, rows: plan.rows };
    b.lockedCells = plan.baseCells.slice();
    b.lockedRevision = plan.revision;
    b.lockedVersion = plan.version;
    b.plannedUsage = computeUsage(plan.baseCells, plan.colorCount);
    b.shortfall = measureShortfall(b.plannedUsage, b.capacities);
    b.status = b.shortfall.total > 0 ? "queued" : "locked";
    b.packages = []; // 旧版交付包失效
    return b;
  }

  /**
   * 任一格色号变化：未开织批次的交付包全部失效（已开织保留）。
   */
  function invalidatePackagesOnEdit(plan) {
    const b = plan.batch;
    if (!b || b.status === "weaving" || b.status === "closed") return 0;
    const n = b.packages.length;
    b.packages = [];
    return n;
  }

  /* ------------------------------- 交付包 ------------------------------- */

  /**
   * 生成交付包门槛：
   *   已确认 / 无未处理冲突 / 合版未过期 / 批次未排队（无容量缺口）/ 尺寸与锁定一致。
   * 已开织批次的包始终从冻结快照出，后续改格不会使其失效。
   */
  function generatePackage(plan) {
    const b = plan.batch;
    assert(b, "NO_BATCH", "还没有锁定批次");
    if (b.status === "weaving" || b.status === "closed") {
      assert(b.snapshot, "NO_SNAPSHOT", "开织批次缺少快照");
      const frozen = buildPackageFromSnapshot(b, plan.name, true);
      b.packages.push(frozen);
      return frozen;
    }
    assert(!hasOpenConflicts(plan), "UNRESOLVED_CONFLICTS", "冲突未处理，不能生成交付包");
    if (plan.pendingMerge && plan.pendingMerge.mergedRevision === plan.revision) {
      assert(false, "NOT_CONFIRMED", "合版结果尚未确认，不能生成交付包");
    }
    assert(b.status !== "queued", "BATCH_QUEUED", "批次排队中（色线缺口 " + b.shortfall.total + " 格），缺口补齐后才能生成交付包");
    const dimsMatch = b.lockedDims.cols === plan.cols && b.lockedDims.rows === plan.rows;
    assert(dimsMatch, "DIMS_CHANGED", "网格尺寸与批次锁定值不一致，请重新锁定批次");
    const live = currentCells(plan);
    const usage = computeUsage(live, plan.colorCount);
    const shortfall = measureShortfall(usage, b.capacities);
    assert(shortfall.total === 0, "BATCH_QUEUED", "当前用量超出色线容量，缺口 " + shortfall.total + " 格");
    const pkg = {
      id: "PKG-" + b.batchNo + "-V" + plan.version + "-" + (b.packages.length + 1),
      batchNo: b.batchNo,
      planId: plan.id,
      planName: plan.name,
      version: plan.version,
      revision: plan.revision,
      dims: { cols: plan.cols, rows: plan.rows },
      cells: live.slice(),
      usage: usage,
      risk: computeRisk(live, plan.cols, plan.rows),
      capacities: b.capacities,
      checksum: checksum({ b: b.batchNo, v: plan.version, cells: live }),
      frozen: false,
      createdAt: nowIso()
    };
    b.packages.push(pkg);
    return pkg;
  }

  function buildPackageFromSnapshot(batch, planName, frozen) {
    const s = batch.snapshot;
    return {
      id: "PKG-" + batch.batchNo + "-V" + s.version + "-" + (batch.packages.length + 1),
      batchNo: batch.batchNo,
      planName: planName || "",
      version: s.version,
      revision: batch.lockedRevision,
      dims: { cols: s.cols, rows: s.rows },
      cells: s.cells.slice(),
      usage: s.usage.slice(),
      risk: s.risk,
      capacities: batch.capacities,
      checksum: s.checksum,
      frozen: !!frozen,
      createdAt: nowIso()
    };
  }

  /* --------------------------- 回传队列 / 恢复 --------------------------- */

  /**
   * 以批次号为幂等键。同一批次号 + kind + 可选鉴别号 dedup（如批次序号、交付包号）只认首次：
   *   首次：登记 pending；完全相同的重复：返回既有记录（dup=true）；
   *   键相同但内容不同：拒绝（冲突），避免旧稿盖新稿。
   */
  function outboxSubmit(outbox, rec) {
    assert(rec && rec.batchNo, "NO_BATCH_NO", "回传记录必须带批次号");
    assert(rec.kind, "BAD_RECORD", "回传记录缺少 kind");
    const key = rec.batchNo + "::" + rec.kind + (rec.dedup != null ? "#" + rec.dedup : "");
    const existing = outbox.find(function (r) { return r.key === key; });
    if (existing) {
      const samePayload = stableStringify(existing.payload) === stableStringify(rec.payload || {});
      if (samePayload) return { record: existing, duplicate: true, accepted: false };
      const err = new Error("批次号 " + rec.batchNo + " 已有不同的" + rec.kind + "回传，重复回传只认首次");
      err.code = "DUPLICATE_BATCH_NO";
      err.existing = existing;
      throw err;
    }
    const record = {
      key: key,
      id: rec.id || ("TX" + Math.abs(hash(key + nowIso() + Math.random())).toString(36)),
      batchNo: rec.batchNo,
      kind: rec.kind,
      dedup: rec.dedup == null ? null : rec.dedup,
      payload: rec.payload || {},
      status: "pending", // pending -> sent -> acked；失败回 pending
      attempts: 0,
      firstSeen: nowIso(),
      lastError: null,
      sentAt: null,
      ackedAt: null
    };
    outbox.push(record);
    return { record: record, duplicate: false, accepted: true };
  }

  function sendOne(record, transport) {
    record.attempts += 1;
    return Promise.resolve().then(function () {
      return transport.send({
        batchNo: record.batchNo, kind: record.kind, dedup: record.dedup, payload: record.payload, id: record.id
      });
    }).then(function (ack) {
      record.status = "acked";
      record.ack = ack;
      record.ackedAt = nowIso();
      record.lastError = null;
      return record;
    }).catch(function (err) {
      record.status = "pending"; // 断网/写入中断：保留 pending，等待按批次号恢复
      record.lastError = { code: err.code || "SEND_FAILED", message: err.message, at: nowIso() };
      throw err;
    });
  }

  /** 恢复发送：按 firstSeen 顺序只补发 pending；acked/sent 不重发（只认首次） */
  function outboxFlush(outbox, transport) {
    const pending = outbox
      .filter(function (r) { return r.status === "pending"; })
      .sort(function (a, b) { return a.firstSeen < b.firstSeen ? -1 : 1; });
    const results = [];
    return pending.reduce(function (p, r) {
      return p.then(function () {
        r.status = "sent";
        r.sentAt = nowIso();
        return sendOne(r, transport).then(function () {
          results.push({ key: r.key, ok: true });
        }).catch(function (err) {
          results.push({ key: r.key, ok: false, error: err.code || "SEND_FAILED" });
        });
      });
    }, Promise.resolve()).then(function () {
      return {
        recovered: pending.length,
        acked: results.filter(function (x) { return x.ok; }).length,
        stillPending: results.filter(function (x) { return !x.ok; }).length,
        results: results
      };
    });
  }

  function recoveryReport(outbox) {
    return {
      total: outbox.length,
      pending: outbox.filter(function (r) { return r.status === "pending"; }).length,
      sent: outbox.filter(function (r) { return r.status === "sent"; }).length,
      acked: outbox.filter(function (r) { return r.status === "acked"; }).length,
      pendingBatchNos: outbox.filter(function (r) { return r.status === "pending"; }).map(function (r) { return r.batchNo; })
    };
  }

  /* ------------------------- 内存仓储（浏览器 localStorage） ------------------------- */

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); }
    };
  }

  const STATE_KEY = "brocade.scheduling.v1";
  const LEGACY_KEY = "zfl31Pattern";

  /**
   * 仓储负责持久化、批次号序列、旧稿迁移、回传队列恢复。
   * storage 失败（写中断）时调用方仍保留内存态，恢复后 flush 即可。
   */
  function Repository(options) {
    options = options || {};
    this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
    this.transport = options.transport || null;
    let state = this._read();
    if (!state) {
      state = { batchSeq: 0, plans: {}, currentPlanId: null, outbox: [] };
      this._write(state);
    }
    this.state = state;
  }

  Repository.prototype._read = function () {
    try {
      const raw = this.storage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  };

  Repository.prototype._write = function () {
    this.storage.setItem(STATE_KEY, stableStringify(this.state));
  };

  Repository.prototype._nextBatchNo = function () {
    this.state.batchSeq += 1;
    return padNo(this.state.batchSeq);
  };

  Repository.prototype.save = function () { this._write(); return this.state; };

  Repository.prototype.listPlans = function () {
    return Object.keys(this.state.plans).map((id) => this.state.plans[id])
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  };

  Repository.prototype.get = function (id) {
    return this.state.plans[id || this.state.currentPlanId] || null;
  };

  Repository.prototype.current = function () { return this.get(this.state.currentPlanId); };

  Repository.prototype.put = function (plan, makeCurrent) {
    this.state.plans[plan.id] = plan;
    if (makeCurrent || !this.state.currentPlanId) this.state.currentPlanId = plan.id;
    this._write();
    return plan;
  };

  Repository.prototype.newPlan = function (input) {
    input = input || {};
    input.batchNo = this._nextBatchNo();
    const plan = createPlan(input);
    this.state.plans[plan.id] = plan;
    this.state.currentPlanId = plan.id;
    this._write();
    this.submitOutbox({ batchNo: plan.batchNo, kind: "plan.create", payload: { planId: plan.id, version: 1 } });
    return plan;
  };

  /**
   * 旧方案迁移：无批次号 -> 分配首批次号，首版。迁移结果进回传队列。
   */
  Repository.prototype.bootstrapLegacy = function (colorCount) {
    let raw = null;
    try { raw = JSON.parse(this.storage.getItem(LEGACY_KEY) || "null"); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.cells)) return null;
    const batchNo = this._nextBatchNo();
    const plan = migrateLegacy(raw, batchNo, colorCount || 8);
    this.state.plans[plan.id] = plan;
    this.state.currentPlanId = plan.id;
    this._write();
    this.submitOutbox({ batchNo: batchNo, kind: "plan.migrate", payload: { planId: plan.id, version: 1 } });
    return plan;
  };

  /* 回传 */
  Repository.prototype.outbox = function () { return this.state.outbox; };

  Repository.prototype.submitOutbox = function (rec) {
    const r = outboxSubmit(this.state.outbox, rec);
    this._write();
    return r;
  };

  Repository.prototype.recover = function () {
    assert(this.transport, "NO_TRANSPORT", "未配置回传通道");
    return outboxFlush(this.state.outbox, this.transport).then((report) => { this._write(); return report; });
  };

  Repository.prototype.recoveryReport = function () { return recoveryReport(this.state.outbox); };

  /* ------------------------------- 导出 ------------------------------- */

  return {
    // 工具
    stableStringify: stableStringify,
    checksum: checksum,
    computeUsage: computeUsage,
    computeRisk: computeRisk,
    buildSnapshot: buildSnapshot,
    measureShortfall: measureShortfall,
    normalizeCapacities: normalizeCapacities,
    // 方案
    createPlan: createPlan,
    migrateLegacy: migrateLegacy,
    editCells: editCells,
    mergePlan: mergePlan,
    resolveConflict: resolveConflict,
    openConflicts: openConflicts,
    hasOpenConflicts: hasOpenConflicts,
    confirmPlan: confirmPlan,
    currentCells: currentCells,
    // 批次
    lockBatch: lockBatch,
    recheckBatch: recheckBatch,
    startBatch: startBatch,
    closeBatch: closeBatch,
    refreshBatchAfterConfirm: refreshBatchAfterConfirm,
    invalidatePackagesOnEdit: invalidatePackagesOnEdit,
    // 交付包
    generatePackage: generatePackage,
    // 回传恢复
    outboxSubmit: outboxSubmit,
    outboxFlush: outboxFlush,
    sendOne: sendOne,
    recoveryReport: recoveryReport,
    // 仓储
    Repository: Repository,
    memoryStorage: memoryStorage,
    STATE_KEY: STATE_KEY,
    LEGACY_KEY: LEGACY_KEY
  };
});
