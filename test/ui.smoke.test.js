/* 浏览器层冒烟：在 jsdom 里加载 index.html + 三个脚本，驱动真实 UI 走完整链路。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function bootDom() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  for (const f of ["src/core.js", "src/fakeServer.js", "src/app.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    window.eval(code);
  }
  return window;
}

function click(win, id) {
  const el = win.document.getElementById(id);
  el.dispatchEvent(new win.Event("click", { bubbles: true }));
  return el;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("UI 冒烟：撞色冲突→裁决→确认→锁批排队→补容量→开织→交付包→断网恢复", async () => {
  const win = bootDom();
  const doc = win.document;
  const Core = win.BrocadeCore;

  // 启动即自动建方案
  let state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  const planId = state.currentPlanId;
  assert.match(state.plans[planId].batchNo, /^B\d{4}$/);
  const batchNo = state.plans[planId].batchNo;

  // 在车间稿涂一格色1
  doc.querySelectorAll("#viewSeg button")[0].dispatchEvent(new win.Event("click"));
  const cell0 = doc.querySelector(".cell[data-i='0']");
  cell0.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  win.dispatchEvent(new win.Event("pointerup", { bubbles: true }));
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].workshop.cells[0], 1);

  // 切打样稿，取色2，把同一格涂色2（撞色），再涂另一格
  doc.querySelectorAll("#viewSeg button")[1].dispatchEvent(new win.Event("click"));
  doc.querySelector(".swatch[data-color='2']").dispatchEvent(new win.Event("click"));
  doc.querySelector(".cell[data-i='0']").dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  doc.querySelector(".cell[data-i='1']").dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  win.dispatchEvent(new win.Event("pointerup", { bubbles: true }));

  // 合版：保留车间值，出现 1 处冲突
  click(win, "mergeBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].pendingMerge.cells[0], 1, "保留车间值");
  assert.equal(state.plans[planId].pendingMerge.conflicts.length, 1);
  assert.equal(doc.querySelectorAll(".cell.conflict").length, 1, "红框标出冲突");

  // 冲突未处理时确认失败（alert 在 jsdom 默认未实现，stub 掉）
  win.alert = () => {};
  click(win, "confirmBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.ok(state.plans[planId].pendingMerge, "未确认，合版仍在");

  // 裁决：采用打样值
  const resolveBtn = doc.querySelector("[data-resolve='0|sample']");
  assert.ok(resolveBtn);
  resolveBtn.dispatchEvent(new win.Event("click", { bubbles: true }));
  assert.equal(doc.querySelectorAll(".cell.conflict").length, 0);
  assert.equal(doc.querySelectorAll(".cell.resolved").length, 1);

  // 确认新版 V2
  click(win, "confirmBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].version, 2);
  assert.equal(state.plans[planId].baseCells[0], 2);

  // 锁定批次：色2容量给 0 制造缺口（当前色2用2格）
  const cap2 = doc.querySelector("[data-cap='2']");
  cap2.value = "0";
  cap2.dispatchEvent(new win.Event("input"));
  click(win, "lockBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.status, "queued");
  assert.equal(state.plans[planId].batch.shortfall.total, 2);
  assert.ok(doc.querySelector("#batchPanel").textContent.includes("缺口"));

  // 排队时生成交付包被挡（confirm 里 alert 已 stub）
  click(win, "pkgBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.packages.length, 0);

  // 容量补足 10，重算 -> locked
  doc.querySelector("#batchPanel [data-cap='2']").value = "10";
  click(win, "recheckBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.status, "locked");

  // 开织 -> 快照冻结
  click(win, "startBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.status, "weaving");
  assert.ok(state.plans[planId].batch.snapshot.checksum);
  const frozenChecksum = state.plans[planId].batch.snapshot.checksum;

  // 生成交付包（冻结版）
  click(win, "pkgBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.packages.length, 1);
  assert.equal(state.plans[planId].batch.packages[0].frozen, true);

  // 开织后车间再改格：交付包仍在，快照不变
  doc.querySelectorAll("#viewSeg button")[0].dispatchEvent(new win.Event("click"));
  doc.querySelector(".cell[data-i='10']").dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  win.dispatchEvent(new win.Event("pointerup", { bubbles: true }));
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.plans[planId].batch.snapshot.checksum, frozenChecksum);
  assert.equal(state.plans[planId].batch.packages.length, 1, "开织批次的交付包保留");

  // 断网 + 重复回传只认首次：先拿当前 outbox 条数
  const before = state.outbox.length;
  click(win, "toggleNetBtn"); // 断网
  // 直接走仓储补一条会因同 key 判重/或入队 pending；用重复回传按钮验证判重提示不抛
  click(win, "dupBtn");
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.ok(state.outbox.length >= before);

  // 恢复联网并按批次号恢复（串行发送，每条 120ms）
  click(win, "recoverBtn");
  await wait(1200);
  state = JSON.parse(win.localStorage.getItem(Core.STATE_KEY));
  assert.equal(state.outbox.filter((r) => r.status !== "acked").length, 0, "全部回传确认");
  assert.ok(state.outbox.every((r) => r.batchNo === batchNo));

  // 重新打开页面：把持久态灌入新窗口的 localStorage，验证恢复与批次号延续
  const snapshot = win.localStorage.getItem(Core.STATE_KEY);
  const win2 = bootDom();
  win2.localStorage.setItem(Core.STATE_KEY, snapshot);
  const Core2 = win2.BrocadeCore;
  const Srv2 = win2.BrocadeServer;
  const repo2 = new Core2.Repository({
    transport: Srv2.createTransport(Srv2.createServer()),
    storage: win2.localStorage
  });
  const state2 = repo2.state;
  assert.equal(state2.plans[planId].batch.batchNo, batchNo);
  assert.equal(state2.plans[planId].batch.snapshot.checksum, frozenChecksum);
  assert.equal(state2.currentPlanId, planId);
  assert.equal(state2.outbox.filter((r) => r.status !== "acked").length, 0);

  // 旧稿迁移：无批次号旧稿 -> 分配下一批次号，首版
  win2.localStorage.setItem(Core.LEGACY_KEY, JSON.stringify({ cols: 8, rows: 6, cells: Array(48).fill(0) }));
  const migrated = repo2.bootstrapLegacy(8);
  assert.ok(migrated);
  assert.equal(migrated.batchNo, "B0002", "批次号序列延续");
  assert.equal(migrated.version, 1, "旧稿迁成首版");
  assert.equal(state2.outbox.some((r) => r.kind === "plan.migrate" && r.batchNo === "B0002"), true);
});
