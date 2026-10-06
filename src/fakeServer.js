/*
 * 内存服务端与可中断通道（演示/测试用）：
 *  - 服务端按 批次号+kind 去重，重复回传只认首次；
 *  - 通道可切换离线（断网）、可设置下 N 次写入失败（写入中断）；
 *  - 恢复联网后由 core.outboxFlush 按批次号补发。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BrocadeServer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function createServer() {
    const received = new Map(); // key -> first record
    const log = [];
    return {
      received: received,
      log: log,
      receive: function (rec) {
        const key = rec.batchNo + "::" + rec.kind + (rec.dedup != null ? "#" + rec.dedup : "");
        if (received.has(key)) {
          const first = received.get(key);
          const samePayload = JSON.stringify(first.payload) === JSON.stringify(rec.payload);
          if (samePayload) {
            return { accepted: false, duplicate: true, key: key, note: "重复回传，只认首次" };
          }
          const err = new Error("批次号 " + rec.batchNo + " 已存在不同的" + rec.kind + "首传，拒绝覆盖");
          err.code = "DUPLICATE_BATCH_NO";
          throw err;
        }
        const stored = {
          id: rec.id, batchNo: rec.batchNo, kind: rec.kind,
          payload: rec.payload, receivedAt: new Date().toISOString()
        };
        received.set(key, stored);
        log.push(stored);
        return { accepted: true, duplicate: false, key: key, serverId: "S" + (log.length).toString().padStart(5, "0") };
      },
      has: function (batchNo, kind) { return received.has(batchNo + "::" + kind); },
      count: function () { return received.size; }
    };
  }

  function createTransport(server) {
    return {
      online: true,
      failNext: 0,       // 接下来 N 次发送报写入中断
      send: function (rec) {
        const self = this;
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (!self.online) {
              const err = new Error("网络离线，写入中断");
              err.code = "OFFLINE";
              return reject(err);
            }
            if (self.failNext > 0) {
              self.failNext -= 1;
              const err = new Error("服务端写入中断");
              err.code = "WRITE_INTERRUPTED";
              return reject(err);
            }
            try { resolve(server.receive(rec)); }
            catch (e) { reject(e); }
          }, 120);
        });
      },
      setOffline: function () { this.online = false; return this; },
      setOnline: function () { this.online = true; return this; },
      interrupt: function (n) { this.failNext = n || 1; return this; }
    };
  }

  return { createServer: createServer, createTransport: createTransport };
});
