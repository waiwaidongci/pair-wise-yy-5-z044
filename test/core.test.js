const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/core.js");
const { createServer, createTransport } = require("../src/fakeServer.js");

const COLORS = 8;

function blankPlan(batchNo, cols = 8, rows = 6) {
  const p = C.createPlan({ cols, rows, colorCount: COLORS, batchNo: batchNo || "B0001", name: "测试纹样" });
  p.confirmedSnapshot = C.buildSnapshot(p.baseCells, cols, rows, COLORS, 1);
  return p;
}

function paint(plan, side, pairs) {
  return C.editCells(plan, side, pairs.map(([i, c]) => ({ index: i, color: c })));
}

/* ---------- 1. 同格两边都改：保留车间值，另一版留冲突 ---------- */

test("同一格两边都改且不同：保留车间值并登记冲突", () => {
  const p = blankPlan();
  paint(p, "workshop", [[0, 1]]);
  paint(p, "sample", [[0, 2]]);
  const m = C.mergePlan(p);
  assert.equal(m.cells[0], 1, "保留车间值");
  assert.equal(m.conflicts.length, 1);
  assert.deepEqual(m.conflicts[0], {
    index: 0, workshop: 1, sample: 2, resolution: null
  });
  assert.equal(C.hasOpenConflicts(p), true);
});

test("只一边改：直接取该边值，无冲突", () => {
  const p = blankPlan();
  paint(p, "sample", [[5, 3]]);
  const m = C.mergePlan(p);
  assert.equal(m.cells[5], 3);
  assert.equal(m.conflicts.length, 0);
});

test("两边改成相同值：无冲突", () => {
  const p = blankPlan();
  paint(p, "workshop", [[2, 4]]);
  paint(p, "sample", [[2, 4]]);
  const m = C.mergePlan(p);
  assert.equal(m.cells[2], 4);
  assert.equal(m.conflicts.length, 0);
});

test("冲突未处理不能确认，也不能生成交付包", () => {
  const p = blankPlan();
  paint(p, "workshop", [[0, 1]]);
  paint(p, "sample", [[0, 2]]);
  C.mergePlan(p);
  assert.throws(() => C.confirmPlan(p), (e) => e.code === "UNRESOLVED_CONFLICTS");
  // 先把冲突处理掉、确认后锁批次；再人为留冲突时验证交付包也被挡住
  C.resolveConflict(p, 0, "workshop");
  C.confirmPlan(p);
  const b = C.lockBatch(p, { 1: 100 });
  C.startBatch(b === p.batch ? b : b);
  // 新一轮冲突（未开织的下一批次场景）：重新构造未开织批次
  const p2 = blankPlan("B0002");
  paint(p2, "workshop", [[0, 1]]);
  paint(p2, "sample", [[0, 2]]);
  C.mergePlan(p2);
  C.lockBatch(p2, {});
  assert.throws(() => C.generatePackage(p2), (e) => e.code === "UNRESOLVED_CONFLICTS");
});

test("冲突裁决取打样值后可以确认，基线按裁决结果", () => {
  const p = blankPlan();
  paint(p, "workshop", [[0, 1]]);
  paint(p, "sample", [[0, 2]]);
  C.mergePlan(p);
  C.resolveConflict(p, 0, "sample");
  assert.equal(C.openConflicts(p).length, 0);
  C.confirmPlan(p);
  assert.equal(p.baseCells[0], 2);
  assert.equal(p.version, 2, "确认产生新一版");
  assert.equal(p.confirmed, true);
  assert.equal(p.workshop.touched.length, 0, "确认后两侧触痕清空");
});

test("合版后任意一侧再改：旧合版作废，需要重新合版", () => {
  const p = blankPlan();
  paint(p, "workshop", [[0, 1]]);
  C.mergePlan(p);
  paint(p, "sample", [[1, 3]]);
  assert.equal(p.pendingMerge, null, "新改动使旧 pendingMerge 失效");
  C.mergePlan(p);
  assert.equal(C.currentCells(p)[1], 3);
});

/* ---------- 2. 批次锁定：列数/行数/容量，超额排队写缺口 ---------- */

test("批次锁定列数行数与色线容量；超容量排队并逐色号写缺口", () => {
  const p = blankPlan(undefined, 8, 6); // 48 格
  paint(p, "workshop", Array.from({ length: 10 }, (_, i) => [i, 1]));
  paint(p, "sample", Array.from({ length: 6 }, (_, i) => [20 + i, 2]));
  C.mergePlan(p);
  C.confirmPlan(p);
  const b = C.lockBatch(p, { 1: 4, 2: 10 }); // 色1需10容4 缺6；色2需6容10 不缺
  assert.equal(b.status, "queued");
  assert.deepEqual(b.lockedDims, { cols: 8, rows: 6 });
  assert.equal(b.shortfall.total, 6);
  assert.deepEqual(b.shortfall.perColor[1], { color: 1, need: 10, capacity: 4, gap: 6 });
  assert.deepEqual(b.shortfall.perColor[2], { color: 2, need: 6, capacity: 10, gap: 0 });
  assert.throws(() => C.startBatch(b), (e) => e.code === "NOT_LOCKED");
  assert.throws(() => C.generatePackage(p), (e) => e.code === "BATCH_QUEUED");
});

test("容量补足后排队批次转锁定，可以开织", () => {
  const p = blankPlan(undefined, 8, 6);
  paint(p, "workshop", Array.from({ length: 10 }, (_, i) => [i, 1]));
  C.mergePlan(p); C.confirmPlan(p);
  const b = C.lockBatch(p, { 1: 4 });
  assert.equal(b.status, "queued");
  C.recheckBatch(b, { 1: 10 });
  assert.equal(b.status, "locked");
  C.startBatch(b);
  assert.equal(b.status, "weaving");
  assert.ok(b.snapshot, "开织冻结快照");
  assert.equal(b.snapshot.usage[1], 10);
  assert.ok(b.snapshot.checksum.startsWith("s"));
});

test("null/负数容量视为不限", () => {
  const p = blankPlan(undefined, 8, 6);
  const b = C.lockBatch(p, { 0: null });
  assert.equal(b.status, "locked");
  assert.equal(b.shortfall.total, 0);
});

/* ---------- 3. 色号变化 -> 统计/断线/交付包失效重算；开织批次保留快照 ---------- */

test("任一格色号变化触发 revision 增加与交付包失效（未开织）", () => {
  const p = blankPlan(undefined, 8, 6);
  paint(p, "workshop", [[0, 1]]);
  C.mergePlan(p); C.confirmPlan(p);
  const b = C.lockBatch(p, {});
  const pkg1 = C.generatePackage(p);
  assert.equal(b.packages.length, 1);
  const revBefore = p.revision;
  paint(p, "workshop", [[1, 2]]);
  assert.equal(p.revision, revBefore + 1);
  const invalidated = C.invalidatePackagesOnEdit(p);
  assert.equal(invalidated, 1);
  assert.equal(b.packages.length, 0);
  // 统计/断线随当前网格重算
  const cells = C.currentCells(p); // 尚未合版 -> 基线
  // 基线仍是旧确认版；合版后新值进入统计
  C.mergePlan(p);
  const usage = C.computeUsage(C.currentCells(p), COLORS);
  assert.equal(usage[2], 1);
  const risk = C.computeRisk(C.currentCells(p), 8, 6);
  assert.ok("hasRisk" in risk && "note" in risk);
});

test("已开织批次保留原快照：后续改格不影响其用量与交付包", () => {
  const p = blankPlan(undefined, 8, 6);
  paint(p, "workshop", Array.from({ length: 5 }, (_, i) => [i, 1]));
  C.mergePlan(p); C.confirmPlan(p);
  const b = C.lockBatch(p, { 1: 100 });
  C.startBatch(b);
  const frozenUsage = b.snapshot.usage.slice();
  const frozenCells = b.snapshot.cells.slice();

  // 开织后车间继续改格并确认新版
  paint(p, "workshop", [[30, 2], [31, 2]]);
  C.mergePlan(p); C.confirmPlan(p);
  C.refreshBatchAfterConfirm(p); // 对开织批次无操作
  assert.deepEqual(b.snapshot.usage, frozenUsage);
  assert.deepEqual(b.snapshot.cells, frozenCells);
  assert.equal(b.status, "weaving");

  // 从开织批次出交付包：冻结版内容
  const pkg = C.generatePackage(p);
  assert.equal(pkg.frozen, true);
  assert.equal(pkg.usage[1], 5);
  assert.equal(pkg.usage[2], 0);
  assert.equal(pkg.cells[30], 0);
});

test("未开织批次在方案确认新版后刷新缺口并使旧交付包失效", () => {
  const p = blankPlan(undefined, 8, 6);
  paint(p, "workshop", Array.from({ length: 4 }, (_, i) => [i, 1]));
  C.mergePlan(p); C.confirmPlan(p);
  const b = C.lockBatch(p, { 1: 10, 2: 10 });
  C.generatePackage(p);
  assert.equal(b.packages.length, 1);
  paint(p, "workshop", Array.from({ length: 20 }, (_, i) => [i, 2]));
  C.mergePlan(p); C.confirmPlan(p);
  C.refreshBatchAfterConfirm(p);
  assert.equal(b.packages.length, 0, "旧版交付包失效");
  assert.equal(b.plannedUsage[2], 20);
  assert.equal(b.status, "queued", "新用量超容量 -> 排队");
  assert.equal(b.shortfall.perColor[2].gap, 10);
});

test("断线风险：换色超过 62% 的纬行被标出", () => {
  const p = blankPlan(undefined, 10, 6);
  const changes = [];
  for (let x = 0; x < 10; x++) changes.push([1 * 10 + x, x % 2]); // 第2行 0101010101 交替
  paint(p, "workshop", changes);
  C.mergePlan(p);
  const risk = C.computeRisk(C.currentCells(p), 10, 6);
  assert.deepEqual(risk.riskRows, [2]);
});

/* ---------- 4. 回传：批次号幂等、断网/写入中断恢复 ---------- */

test("重复回传只认首次：相同内容判重，不同内容拒绝", async () => {
  const server = createServer();
  const transport = createTransport(server);
  const outbox = [];
  C.outboxSubmit(outbox, { batchNo: "B0007", kind: "batch.lock", payload: { v: 1 } });
  const dup = C.outboxSubmit(outbox, { batchNo: "B0007", kind: "batch.lock", payload: { v: 1 } });
  assert.equal(dup.duplicate, true);
  assert.equal(outbox.length, 1);
  assert.throws(
    () => C.outboxSubmit(outbox, { batchNo: "B0007", kind: "batch.lock", payload: { v: 999 } }),
    (e) => e.code === "DUPLICATE_BATCH_NO"
  );
  // 不同 kind 允许
  C.outboxSubmit(outbox, { batchNo: "B0007", kind: "package.generate", payload: { id: "P1" } });
  assert.equal(outbox.length, 2);
  await C.outboxFlush(outbox, transport);
  assert.equal(server.count(), 2);
  // 服务端侧同样只认首次
  const r = await server.receive({ batchNo: "B0007", kind: "batch.lock", payload: { v: 1 } });
  assert.equal(r.duplicate, true);
  assert.equal(server.count(), 2);
});

test("断网后恢复：pending 按批次号补发，已确认的不重发", async () => {
  const server = createServer();
  const transport = createTransport(server).setOffline();
  const outbox = [];
  C.outboxSubmit(outbox, { batchNo: "B0001", kind: "batch.lock", payload: { a: 1 } });
  C.outboxSubmit(outbox, { batchNo: "B0002", kind: "batch.lock", payload: { a: 2 } });
  const report1 = await C.outboxFlush(outbox, transport);
  assert.equal(report1.stillPending, 2);
  assert.equal(server.count(), 0);
  assert.deepEqual(C.recoveryReport(outbox).pendingBatchNos, ["B0001", "B0002"]);

  transport.setOnline();
  const report2 = await C.outboxFlush(outbox, transport);
  assert.equal(report2.recovered, 2, "两条 pending 按批次号补发并确认");
  assert.equal(report2.acked, 2);
  assert.equal(report2.stillPending, 0);
  assert.equal(server.count(), 2);
  assert.ok(server.has("B0001", "batch.lock"));

  // 再触发一次恢复：没有待发记录，不会重发（只认首次）
  const report3 = await C.outboxFlush(outbox, transport);
  assert.equal(report3.recovered, 0);
  assert.equal(server.count(), 2);
});

test("写入中断（服务端偶发失败）后重试成功，且只认首次", async () => {
  const server = createServer();
  const transport = createTransport(server).interrupt(1); // 第一次失败
  const outbox = [];
  C.outboxSubmit(outbox, { batchNo: "B0009", kind: "batch.start", payload: {} });
  const r1 = await C.outboxFlush(outbox, transport);
  assert.equal(r1.stillPending, 1);
  assert.equal(outbox[0].attempts, 1);
  assert.equal(outbox[0].lastError.code, "WRITE_INTERRUPTED");
  const r2 = await C.outboxFlush(outbox, transport);
  assert.equal(r2.acked, 1);
  assert.equal(outbox[0].attempts, 2);
  assert.equal(server.count(), 1);
});

/* ---------- 5. 仓储：批次号分配、旧稿迁首版、持久化恢复 ---------- */

test("同一批次号的下一批用序号鉴别；旧稿晚回仍被首次挡住", async () => {
  const server = createServer();
  const transport = createTransport(server);
  const outbox = [];
  C.outboxSubmit(outbox, { batchNo: "B0021", kind: "batch.lock", dedup: 1, payload: { v: 1 } });
  C.outboxSubmit(outbox, { batchNo: "B0021", kind: "batch.start", dedup: 1, payload: {} });
  // 收尾后第二批：序号 2 不与首批判重
  C.outboxSubmit(outbox, { batchNo: "B0021", kind: "batch.lock", dedup: 2, payload: { v: 2 } });
  assert.equal(outbox.length, 3);
  // 首批锁定的旧稿晚回：同键不同内容 -> 拒绝
  assert.throws(
    () => C.outboxSubmit(outbox, { batchNo: "B0021", kind: "batch.lock", dedup: 1, payload: { v: 9 } }),
    (e) => e.code === "DUPLICATE_BATCH_NO"
  );
  // 完全相同的重放：只认首次
  const dup = C.outboxSubmit(outbox, { batchNo: "B0021", kind: "batch.lock", dedup: 2, payload: { v: 2 } });
  assert.equal(dup.duplicate, true);
  await C.outboxFlush(outbox, transport);
  assert.equal(server.count(), 3);
});

test("Repository 分配递增批次号并持久化", () => {
  const repo = new C.Repository({ storage: C.memoryStorage() });
  const p1 = repo.newPlan({ name: "甲", cols: 8, rows: 6 });
  const p2 = repo.newPlan({ name: "乙", cols: 8, rows: 6 });
  assert.equal(p1.batchNo, "B0001");
  assert.equal(p2.batchNo, "B0002");
  assert.equal(p1.version, 1);

  // 重新打开：同一份持久态继续分配
  const repo2 = new C.Repository({ storage: repo.storage });
  const p3 = repo2.newPlan({ name: "丙", cols: 8, rows: 6 });
  assert.equal(p3.batchNo, "B0003");
  assert.equal(repo2.get(p1.id).name, "甲");
});

test("旧方案缺批次号：迁移成首批次号首版", () => {
  const storage = C.memoryStorage();
  const cols = 6, rows = 6;
  const cells = Array(cols * rows).fill(0);
  cells[0] = 1; cells[7] = 2;
  storage.setItem(C.LEGACY_KEY, JSON.stringify({ cols, rows, cells }));
  const repo = new C.Repository({ storage });
  const plan = repo.bootstrapLegacy(COLORS);
  assert.ok(plan, "完成迁移");
  assert.equal(plan.batchNo, "B0001");
  assert.equal(plan.version, 1);
  assert.equal(plan.migratedFromLegacy, true);
  assert.deepEqual(plan.baseCells[0], 1);
  assert.ok(plan.confirmedSnapshot, "迁移即首版快照");
  assert.equal(plan.confirmedSnapshot.usage[2], 1);
  // 迁移记录进入回传队列
  assert.equal(repo.outbox()[0].kind, "plan.migrate");
  assert.equal(repo.outbox()[0].batchNo, "B0001");
});

test("Repository.recover 按批次号恢复未确认回传", async () => {
  const server = createServer();
  const transport = createTransport(server).setOffline();
  const storage = C.memoryStorage();
  const repo = new C.Repository({ storage, transport });
  const p = repo.newPlan({ cols: 8, rows: 6 });
  repo.submitOutbox({ batchNo: p.batchNo, kind: "batch.lock", payload: { caps: {} } });
  await repo.recover();
  assert.equal(server.count(), 0);
  transport.setOnline();
  const report = await repo.recover();
  // plan.create + batch.lock 共两条
  assert.equal(report.acked, 2);
  assert.equal(server.count(), 2);
  // 持久化中状态已更新
  const reopened = new C.Repository({ storage, transport });
  assert.equal(reopened.recoveryReport().pending, 0);
});

test("批次收尾后再锁定：批次序号自增", () => {
  const p = blankPlan("B0030", 8, 6);
  const b1 = C.lockBatch(p, {});
  assert.equal(b1.seq, 1);
  C.startBatch(b1); C.closeBatch(b1);
  p.batchHistory = p.batchHistory || [];
  p.batchHistory.push(p.batch);
  p.batch = null;
  const b2 = C.lockBatch(p, {});
  assert.equal(b2.seq, 2, "同一批次号下一批序号为 2");
  assert.equal(b2.batchNo, "B0030");
});

/* ---------- 6. 端到端小流程 ---------- */

test("端到端：双端改格 -> 冲突 -> 裁决确认 -> 锁批 -> 缺口补齐 -> 开织 -> 交付包", () => {
  const p = blankPlan("B0100", 10, 8);
  // 车间：边框色1；打样：中心区色2，且与车间在同一格撞色
  const w = [];
  for (let i = 0; i < 80; i++) { const x = i % 10, y = Math.floor(i / 10); if (x === 0 || y === 0) w.push([i, 1]); }
  w.push([44, 1]); // 中心点车间给色1
  paint(p, "workshop", w);
  paint(p, "sample", [[44, 2], [45, 2], [54, 2], [55, 2]]); // 中心 2x2，44 撞色

  const m = C.mergePlan(p);
  assert.equal(m.cells[44], 1, "车间值优先");
  assert.equal(C.openConflicts(p).length, 1);
  C.resolveConflict(p, 44, "sample");
  C.confirmPlan(p);
  assert.equal(p.version, 2);

  // 容量故意收紧：色1 边框约 19 格，给 10 -> 缺
  const b = C.lockBatch(p, { 1: 10, 2: 10 });
  assert.equal(b.status, "queued");
  assert.ok(b.shortfall.perColor[1].gap > 0);
  C.recheckBatch(b, { 1: 100, 2: 100 });
  assert.equal(b.status, "locked");
  C.startBatch(b);
  const pkg = C.generatePackage(p);
  assert.equal(pkg.frozen, true);
  assert.equal(pkg.batchNo, "B0100");
  assert.equal(pkg.dims.cols, 10);
  assert.equal(pkg.dims.rows, 8);
});
