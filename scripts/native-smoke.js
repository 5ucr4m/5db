// Runs inside the real Tauri webview (debug build) and exercises the IPC bridge.
// Results are written to the app's own settings table under the key "smoke".
(async () => {
  const invoke = (method, params = {}) => window.__TAURI_INTERNALS__.invoke("rpc", { method, params });
  const out = { ok: false, steps: {} };
  const ids = [];
  try {
    out.steps.ui = document.body.innerText.includes("5db") && !!document.querySelector("nav[aria-label=Connections]");
    out.steps.engine = navigator.userAgent;
    const pg = await invoke("connections.save", { name: "smoke-pg", kind: "postgres", host: "127.0.0.1", port: 54329, user: "fivedb", password: "fivedb", database: "shop", sslMode: "disable" });
    ids.push(pg.id);
    out.steps.pgConnect = (await invoke("pg.connect", { connectionId: pg.id })).database;
    const page = await invoke("pg.rows", { connectionId: pg.id, schema: "public", table: "customers", limit: 5, sort: [{ column: "id", desc: true }] });
    out.steps.pgRows = { first: page.rows[0][0], total: page.total };
    const ex = await invoke("pg.execute", { connectionId: pg.id, sql: "SELECT 41 + 1 AS answer", record: false });
    out.steps.pgExecute = ex.results[0].rows[0][0];
    try {
      await invoke("pg.rows", { connectionId: pg.id, schema: "public", table: "nope" });
      out.steps.pgError = "no error";
    } catch (e) {
      out.steps.pgError = e.message;
    }
    const rd = await invoke("connections.save", { name: "smoke-redis", kind: "redis", host: "127.0.0.1", port: 63799, password: "fivedb" });
    ids.push(rd.id);
    const scan = await invoke("redis.scan", { connectionId: rd.id, pattern: "user:*", count: 1000 });
    out.steps.redisKeys = scan.keys.length;
    out.steps.redisGet = (await invoke("redis.get", { connectionId: rd.id, key: "leaderboard" })).value[0].member;
    out.ok = out.steps.ui && out.steps.pgConnect === "shop" && out.steps.pgRows.first === "5000" && out.steps.pgExecute === "42" && out.steps.redisKeys === 50;
  } catch (e) {
    out.error = String(e && e.message ? e.message : JSON.stringify(e));
  }
  for (const id of ids) await invoke("connections.delete", { id }).catch(() => {});
  await invoke("settings.set", { key: "smoke", value: out });
})();
