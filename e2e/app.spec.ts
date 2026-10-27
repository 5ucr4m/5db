import { expect, type Page, test } from "@playwright/test";

// End-to-end flows against the docker fixtures (`pnpm db:up`).
// Tests share one bridge, so each starts from an empty connection list.

const BRIDGE = "http://127.0.0.1:1430/rpc";
const PG_URL = "postgres://fivedb:fivedb@127.0.0.1:54329/shop?sslmode=disable";
const REDIS_URL = "redis://:fivedb@127.0.0.1:63799/0";

async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json()) as { ok: boolean; data: T; error?: { message: string } };
  if (!body.ok) throw new Error(body.error?.message);
  return body.data;
}

async function resetConnections() {
  const list = await rpc<{ id: string }[]>("connections.list");
  for (const c of list) await rpc("connections.delete", { id: c.id });
}

async function addConnection(page: Page, url: string, name: string, env?: string) {
  await page
    .getByRole("button", { name: /new connection|add your first connection/i })
    .first()
    .click();
  await page.getByPlaceholder(/postgres:\/\/user|redis:\/\/:password/).fill(url);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  if (env) await page.getByRole("dialog").getByRole("button", { name: env, exact: true }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("dialog").getByText(/PostgreSQL \d+|Redis \d+/)).toBeVisible();
  await page.getByRole("button", { name: "Save and connect" }).click();
  // Wait until the workspace is connected and its sidebar is populated.
  await expect(page.locator("aside").getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('aside input[placeholder$=" objects"]').or(page.locator("aside").getByText(/of \d+ keys/))).toBeVisible();
}

const grid = (page: Page) => page.locator("main .font-mono.text-\\[12px\\]:visible").first();

test.beforeEach(async ({ page }) => {
  await resetConnections();
  // Restore fixture rows that edit tests change.
  const pg = await rpc<{ id: string }>("connections.save", {
    name: "fixture",
    kind: "postgres",
    host: "127.0.0.1",
    port: 54329,
    user: "fivedb",
    password: "fivedb",
    database: "shop",
    sslMode: "disable",
  });
  await rpc("pg.execute", {
    connectionId: pg.id,
    record: false,
    sql: "UPDATE customers SET name = 'Bruno Souza' WHERE id = 1; DELETE FROM products WHERE title LIKE 'E2E%';",
  });
  await rpc("connections.delete", { id: pg.id });
  const rd = await rpc<{ id: string }>("connections.save", {
    name: "fixture",
    kind: "redis",
    host: "127.0.0.1",
    port: 63799,
    password: "fivedb",
  });
  await rpc("redis.command", { connectionId: rd.id, args: ["HSET", "user:7", "name", "User7"] });
  await rpc("redis.command", { connectionId: rd.id, args: ["DEL", "e2e:temp"] });
  await rpc("connections.delete", { id: rd.id });
  await page.goto("/");
});

test("first run, connection test and persistence", async ({ page }) => {
  await expect(page.getByText("In one quiet window.")).toBeVisible();
  await page.getByRole("button", { name: /add your first connection/i }).click();
  // Bad password surfaces the server message.
  await page.getByPlaceholder(/postgres:\/\/user/).fill("postgres://fivedb:wrong@127.0.0.1:54329/shop");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Broken");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Could not connect")).toBeVisible();
  await expect(page.getByText(/password authentication failed/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await addConnection(page, PG_URL, "Shop local");
  await expect(page.getByText("shop", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /customers/ }).first()).toBeVisible();

  // Saved: reload the app and the connection is still there, reopened where
  // it was left rather than back on the home screen.
  await page.reload();
  // The name also exists on the hidden home screen, so look in the sidebar.
  await expect(page.locator("aside").getByText("Shop local", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /customers/ }).first()).toBeVisible();
});

test("the open tabs come back after a restart", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.getByRole("button", { name: /^customers/ }).dblclick();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();

  // A query tab with text in it, which has to come back unexecuted.
  await page.keyboard.press("Meta+t");
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.type("SELECT 42 AS answer");
  await expect(editor).toContainText("SELECT 42");

  // Only the editor text is debounced, so give that snapshot time to land.
  await page.waitForTimeout(900);
  await page.reload();

  // Both tabs are back, the query text with them, and nothing ran on its own.
  await expect(page.getByRole("button", { name: /customers/ }).first()).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("SELECT 42");
  await expect(page.getByText("Run a query to see results")).toBeVisible();
});

test("browse, sort, search, filter and paginate a table", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.getByRole("button", { name: /^customers/ }).dblclick();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();

  // Sort descending by clicking the id header twice.
  const idHeader = page.locator("[title^='id · bigint']");
  await idHeader.click();
  await idHeader.click();
  await expect(page.getByText("id", { exact: true }).first()).toBeVisible();
  await expect(grid(page).locator("text=5000").first()).toBeVisible();

  // Pagination.
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("501–1,000 of 5,000")).toBeVisible();

  // Search across all columns.
  await page.locator('input[placeholder^="Search every column"]:visible').fill("user4242@");
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  await page.locator('input[placeholder^="Search every column"]:visible').fill("");

  // Structured filter: country = PT, is_vip true.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const row = page.locator("main select").first();
  await row.selectOption("country");
  await page.locator("main select").nth(1).selectOption("eq");
  await page.locator("main input[placeholder='value']").fill("PT");
  await expect(page.getByText("1–500 of 834")).toBeVisible();
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.locator("main select").nth(2).selectOption("is_vip");
  await expect(page.getByText(/1–76 of 76/)).toBeVisible();
  // Switch to OR
  await page.getByRole("button", { name: "any", exact: true }).click();
  await expect(page.getByText(/of 1,212/)).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();

  // Structure and DDL views.
  await page.getByRole("button", { name: "Structure", exact: true }).click();
  await expect(page.getByText("People who buy things")).toBeVisible();
  await expect(page.getByRole("button", { name: /public\.orders/ })).toBeVisible();
  await page.getByRole("button", { name: "DDL", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText('CREATE TABLE "public"."customers"');
});

test("edit cells, insert and delete rows in one transaction", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.getByRole("button", { name: /^customers/ }).dblclick();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();

  // Edit the name of row 1 by double-clicking and typing.
  const nameCell = grid(page).getByText("Bruno Souza", { exact: true }).first();
  await nameCell.dblclick();
  const editor = page.locator("main input.h-\\[28px\\]");
  await editor.fill("Bruno Edited");
  await editor.press("Enter");
  await expect(page.getByText("1 unsaved change")).toBeVisible();
  await page.getByRole("button", { name: "Review SQL" }).click();
  await expect(page.getByText(/UPDATE "public"."customers" SET "name" = 'Bruno Edited' WHERE "id" = '1'/)).toBeVisible();
  await page.getByRole("dialog").getByText("Close", { exact: true }).click();
  await page.keyboard.press("Meta+s");
  await expect(page.getByText("Saved 1 change to customers")).toBeVisible();
  await expect(grid(page).getByText("Bruno Edited")).toBeVisible();

  // Insert a product with defaults, then delete it.
  await page.getByRole("button", { name: /^products/ }).dblclick();
  await expect(page.getByText(/of 300/)).toBeVisible();
  await page.getByRole("button", { name: "Row", exact: true }).click();
  await expect(page.getByText("DEFAULT").first()).toBeVisible();
  await page.getByRole("button", { name: "Row details (⌘I)" }).click();
  // The new row is selected; fill it through the row inspector.
  await expect(page.getByText("New row")).toBeVisible();
  const titleField = page.getByPlaceholder("DEFAULT").nth(2);
  await titleField.fill("E2E mug");
  await titleField.blur();
  const priceField = page.getByPlaceholder("DEFAULT").nth(2);
  await priceField.fill("19.90");
  await priceField.blur();
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByText(/Saved 1 change to products/)).toBeVisible();
  await expect(page.getByText(/of 301/)).toBeVisible();

  // Failing save keeps the staged change and reports which one failed.
  await page.locator('input[placeholder^="Search every column"]:visible').fill("E2E mug");
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  const price = grid(page).getByText("19.90");
  await price.dblclick();
  await page.locator("main input.h-\\[28px\\]").fill("-5");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+s");
  await expect(page.getByText(/Change #1 failed: .*check constraint/)).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();

  // Delete the row via the context menu.
  await price.click({ button: "right" });
  await page.getByRole("button", { name: "Delete row" }).click();
  await expect(page.getByText("1 deleted")).toBeVisible();
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByText("0 rows")).toBeVisible();
});

test("foreign key navigation opens the referenced row", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.getByRole("button", { name: /^orders/ }).dblclick();
  await expect(page.getByText("1–500 of 20,000")).toBeVisible();
  const cell = grid(page).locator("text=/^8$/").first();
  await cell.hover();
  await page.locator('[title="Open customers where id = 8"]').first().click();
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  await expect(page.getByText("user8@example.com")).toBeVisible();
});

test("SQL editor: run, errors, multiple results, history and saved queries", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.keyboard.press("Meta+t");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.type("SELECT status, count(*) AS n FROM orders GROUP BY 1 ORDER BY 1;");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByRole("button", { name: "5 rows" })).toBeVisible();
  await expect(page.getByText("delivered").first()).toBeVisible();

  // Error with position.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("SELECT * FROM nope_table");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText('relation "nope_table" does not exist').first()).toBeVisible();
  await expect(page.getByText("SQLSTATE 42P01")).toBeVisible();
  await expect(page.locator(".cm-error-mark")).toHaveText("nope_table");

  // Several statements: command + rows.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("CREATE TEMP TABLE e2e(x int); INSERT INTO e2e VALUES (1),(2); SELECT sum(x) FROM e2e;");
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByRole("button", { name: "2 affected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 row" })).toBeVisible();

  // History shows past queries; clicking one loads it into the editor.
  const library = page.locator("main").getByText("SELECT status, count(*) AS n FROM orders GROUP BY 1 ORDER BY 1;");
  await expect(library).toBeVisible();
  await library.click();
  await expect(editor).toContainText("GROUP BY 1 ORDER BY 1");

  // Save it with a name, then find it in Saved and in the palette.
  await page.keyboard.press("Meta+s");
  await page.getByPlaceholder("Monthly revenue by status").fill("Orders by status");
  await page.getByRole("button", { name: "Save query" }).click();
  await expect(page.getByText("Saved “Orders by status”")).toBeVisible();
  await page.getByRole("button", { name: /Saved · 1/ }).click();
  await expect(page.getByText("Orders by status").last()).toBeVisible();

  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Jump to a table/).fill("orders by");
  await expect(page.getByRole("button", { name: "Orders by status", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Full history tab with search.
  await page.getByRole("button", { name: "Query history" }).click();
  await page.getByPlaceholder("Search the SQL of every query you ran").fill("nope_table");
  await expect(page.locator("pre", { hasText: "SELECT * FROM nope_table" })).toHaveCount(1);
});

test("the query plan renders as a tree, with and without ANALYZE", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.keyboard.press("Meta+t");
  await page.locator(".cm-content").click();
  await page.keyboard.type("SELECT c.name, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY 1");

  // Explain only plans, so there is a cost and no measured time.
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(page.getByText("Estimates only.")).toBeVisible();
  await expect(page.getByText(/Total cost/)).toBeVisible();
  await expect(page.getByText("Hash Join").or(page.getByText("Merge Join")).or(page.getByText("Nested Loop")).first()).toBeVisible();
  await expect(page.locator("main").getByText("customers", { exact: true }).first()).toBeVisible();

  // Analyze runs it, so execution time and actual row counts appear.
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Execution")).toBeVisible();
  await expect(page.getByText(/actual/).first()).toBeVisible();
  await expect(page.getByText("Estimates only.")).toHaveCount(0);
});

test("notifications: listen on a channel and see a NOTIFY arrive", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Jump to a table/).fill("notifications");
  await page.getByText("Notifications (LISTEN / NOTIFY)").click();
  await expect(page.getByText("Not listening on any channel.")).toBeVisible();

  await page.getByPlaceholder("channel to listen on").fill("e2e_orders");
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page.getByText("Not listening on any channel.")).toHaveCount(0);

  // The sender goes out on another connection, which is how a real NOTIFY
  // reaches the listener.
  await page.getByPlaceholder("payload (optional)").fill('{"id":42}');
  await page.getByRole("button", { name: "Notify" }).click();
  await expect(page.getByText('"id": 42')).toBeVisible();
  await expect(page.getByText(/pid \d+/)).toBeVisible();

  // Stopping the channel empties the list again.
  await page.getByRole("button", { name: "Stop listening on e2e_orders" }).click();
  await expect(page.getByText("Not listening on any channel.")).toBeVisible();
});

test("connections are grouped in the list", async ({ page }) => {
  // Seeded directly: this is about how the list renders groups, not about the
  // form, which the first test already covers.
  await rpc("connections.save", {
    name: "Shop prod",
    kind: "postgres",
    group: "Commerce",
    host: "127.0.0.1",
    port: 54329,
    user: "fivedb",
    password: "fivedb",
    database: "shop",
    sslMode: "disable",
  });
  await rpc("connections.save", {
    name: "Analytics",
    kind: "postgres",
    group: "Reporting",
    host: "127.0.0.1",
    port: 54329,
    user: "fivedb",
    password: "fivedb",
    database: "shop",
    sslMode: "disable",
  });
  await rpc("connections.save", { name: "Cache", kind: "redis", host: "127.0.0.1", port: 63799, password: "fivedb" });
  await page.reload();

  // Groups alphabetical, the ungrouped ones last under their own heading.
  await expect(page.getByRole("heading", { name: "Commerce" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reporting" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ungrouped" })).toBeVisible();
  await expect(page.getByText("Shop prod")).toBeVisible();
  await expect(page.getByText("Cache")).toBeVisible();

  // Searching by group name finds its connections.
  await page.getByPlaceholder("Find a connection").fill("Reporting");
  await expect(page.getByText("Analytics")).toBeVisible();
  await expect(page.getByText("Shop prod")).toHaveCount(0);
});

test("cancel a long running query", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.keyboard.press("Meta+t");
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("SELECT pg_sleep(20)");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText(/Running ·/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("canceling statement due to user request").first()).toBeVisible();
});

test("production connections confirm destructive statements", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop prod", "Production");
  await expect(page.locator("div.h-\\[3px\\].env-stripe-prod")).toBeVisible();
  await page.keyboard.press("Meta+t");
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("DELETE FROM audit_log");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("Run on production?")).toBeVisible();
  await expect(page.getByText(/deletes every row/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Run a query to see results")).toBeVisible();
});

test("redis: browse keys, inspect every type, edit and use the console", async ({ page }) => {
  await addConnection(page, REDIS_URL, "Cache");
  await expect(page.getByText(/of \d+ keys/)).toBeVisible();

  // Tree groups by namespace.
  await page.getByRole("button", { name: /^user 50$/ }).click();
  await expect(page.getByRole("button", { name: /^HASH 1$/ })).toBeVisible();
  await page.getByPlaceholder("user:* or any text").fill("user:7");
  await page.getByRole("button", { name: "HASH user:7" }).click();
  await expect(page.getByRole("heading", { name: "user:7" })).toBeVisible();
  await expect(page.getByText("user7@example.com")).toBeVisible();

  // Edit a hash field.
  await page.getByText("User7", { exact: true }).dblclick();
  const ta = page.locator("main textarea").first();
  await ta.fill("Seven");
  await ta.press("Enter");
  await expect(page.getByText("Seven", { exact: true })).toBeVisible();

  // Pattern search and other types.
  await page.getByPlaceholder("user:* or any text").fill("leaderboard");
  await page.getByRole("button", { name: /ZSET leaderboard/ }).click();
  await expect(page.getByText("carla")).toBeVisible();
  await page.getByPlaceholder("user:* or any text").fill("config");
  await page.getByRole("button", { name: /config:feature_flags/ }).click();
  await expect(page.locator("main textarea")).toHaveValue(/"darkMode": true/);

  // TTL is shown for expiring keys.
  await page.getByPlaceholder("user:* or any text").fill("session:user:1*");
  await page.getByRole("button", { name: /^STR session:user:1 / }).click();
  await expect(page.getByText(/Expires in/)).toBeVisible();

  // New key, then remove it.
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByPlaceholder("user:42:profile").fill("e2e:temp");
  await page.getByRole("dialog").locator("input").nth(1).fill("hello");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "e2e:temp" })).toBeVisible();
  await page.getByRole("button", { name: "Delete key" }).click();
  await page.getByRole("button", { name: "Delete key" }).last().click();
  await expect(page.getByText("Deleted e2e:temp")).toBeVisible();

  // Console with history.
  await page.getByRole("button", { name: "Console", exact: true }).click();
  const input = page.getByPlaceholder("Type a Redis command");
  await input.fill("HGET user:7 name");
  await input.press("Enter");
  await expect(page.getByText('"Seven"')).toBeVisible();
  await input.fill("NOPE");
  await input.press("Enter");
  await expect(page.getByText(/\(error\) .*unknown command/i)).toBeVisible();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("NOPE");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("HGET user:7 name");

  // restore
  await input.fill("HSET user:7 name User7");
  await input.press("Enter");
  await expect(page.getByText("(integer) 0")).toBeVisible();

  // Server info.
  await page.getByRole("button", { name: "Server info" }).click();
  await expect(page.getByText("Hit rate")).toBeVisible();
});

test("several connections stay open side by side", async ({ page }) => {
  await addConnection(page, PG_URL, "Shop");
  await page.getByRole("button", { name: /^customers/ }).dblclick();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();
  await page.getByTitle("All connections").click();
  await page.getByRole("button", { name: "New connection" }).click();
  await page.getByPlaceholder(/postgres:\/\/user/).fill(REDIS_URL);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Cache");
  await page.getByRole("button", { name: "Save and connect" }).click();
  await expect(page.getByText(/of \d+ keys/)).toBeVisible();
  // Back to Postgres: the tab is still there.
  await page.getByTitle(/^Shop · /).click();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();
});

test("connect through an SSH tunnel", async ({ page }) => {
  await page.getByRole("button", { name: /add your first connection/i }).click();
  // "postgres" is only resolvable from inside the bastion.
  await page.getByPlaceholder(/postgres:\/\/user/).fill("postgres://fivedb:fivedb@postgres:5432/shop?sslmode=disable");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Behind bastion");
  await page.getByRole("button", { name: /SSH tunnel/ }).click();
  await page.getByRole("switch", { name: "Connect through SSH" }).click();
  await page.getByPlaceholder("bastion.example.com").fill("127.0.0.1");
  await page.getByRole("textbox", { name: "SSH port" }).fill("22229");
  await page.getByPlaceholder("ubuntu").fill("tunnel");
  await page.getByRole("textbox", { name: "SSH password" }).fill("wrong");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/rejected the credentials for user “tunnel”/)).toBeVisible();
  await page.getByRole("textbox", { name: "SSH password" }).fill("tunnel");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("dialog").getByText(/PostgreSQL \d+.* · via SSH/)).toBeVisible();
  await page.getByRole("button", { name: "Save and connect" }).click();
  await expect(page.locator("aside").getByText(/via 127\.0\.0\.1/)).toBeVisible();
  await page.getByRole("button", { name: /^customers/ }).dblclick();
  await expect(page.getByText("1–500 of 5,000")).toBeVisible();
});
