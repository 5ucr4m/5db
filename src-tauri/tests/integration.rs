//! End-to-end tests of the RPC surface against the docker fixtures in
//! `docker/` (`docker compose -f docker/docker-compose.yml up -d`).

use fivedb_lib::rpc::{AppState, dispatch};
use serde_json::{Value, json};

fn state() -> AppState {
    let dir = std::env::temp_dir().join(format!("5db-test-{}", uuid_like()));
    AppState::new(dir).expect("store")
}

fn uuid_like() -> String {
    format!("{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')'], "")
}

async fn call(s: &AppState, method: &str, params: Value) -> Value {
    match dispatch(s, method, params).await {
        Ok(v) => v,
        Err(e) => panic!("{method} failed: {}", serde_json::to_string(&e).unwrap()),
    }
}

async fn pg_conn(s: &AppState) -> String {
    let saved = call(
        s,
        "connections.save",
        json!({ "name": "Shop", "kind": "postgres", "host": "127.0.0.1", "port": 54329,
                "user": "fivedb", "password": "fivedb", "database": "shop", "sslMode": "disable" }),
    )
    .await;
    saved["id"].as_str().unwrap().to_string()
}

async fn redis_conn(s: &AppState) -> String {
    let saved = call(
        s,
        "connections.save",
        json!({ "name": "Cache", "kind": "redis", "host": "127.0.0.1", "port": 63799, "password": "fivedb" }),
    )
    .await;
    saved["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn connections_persist_and_test() {
    let s = state();
    let id = pg_conn(&s).await;
    let list = call(&s, "connections.list", json!({})).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id);

    let ok = call(
        &s,
        "connections.test",
        json!({ "kind": "postgres", "host": "127.0.0.1", "port": 54329, "user": "fivedb", "password": "fivedb", "database": "shop" }),
    )
    .await;
    assert!(ok["version"].as_str().unwrap().contains("PostgreSQL"));

    let bad = dispatch(
        &s,
        "connections.test",
        json!({ "kind": "postgres", "host": "127.0.0.1", "port": 54329, "user": "fivedb", "password": "nope", "database": "shop" }),
    )
    .await;
    assert!(bad.unwrap_err().message.contains("password"));

    let r = call(
        &s,
        "connections.test",
        json!({ "kind": "redis", "host": "127.0.0.1", "port": 63799, "password": "fivedb" }),
    )
    .await;
    assert_eq!(r["pong"], "PONG");

    call(&s, "connections.delete", json!({ "id": id })).await;
    assert_eq!(
        call(&s, "connections.list", json!({})).await.as_array().unwrap().len(),
        0
    );
}

#[tokio::test]
async fn introspection() {
    let s = state();
    let id = pg_conn(&s).await;
    let info = call(&s, "pg.connect", json!({ "connectionId": id })).await;
    assert_eq!(info["database"], "shop");

    let dbs = call(&s, "pg.databases", json!({ "connectionId": id })).await;
    assert!(dbs.as_array().unwrap().iter().any(|d| d["name"] == "shop"));

    let objs = call(&s, "pg.objects", json!({ "connectionId": id })).await;
    let names: Vec<String> = objs["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            format!(
                "{}.{}:{}",
                o["schema"].as_str().unwrap(),
                o["name"].as_str().unwrap(),
                o["kind"].as_str().unwrap()
            )
        })
        .collect();
    for expected in [
        "public.customers:table",
        "public.orders:table",
        "public.vip_customers:view",
        "public.sales_by_status:matview",
        "analytics.daily_visits:table",
    ] {
        assert!(names.contains(&expected.to_string()), "missing {expected} in {names:?}");
    }
    assert_eq!(objs["schemas"][0], "public");
    let fns = objs["functions"].as_array().unwrap();
    assert!(fns.iter().any(|f| f["name"] == "customer_order_count"));
    // Extension functions (pgcrypto) are hidden.
    assert!(
        !fns.iter()
            .any(|f| f["name"] == "gen_random_uuid" || f["name"] == "crypt")
    );

    let st = call(
        &s,
        "pg.structure",
        json!({ "connectionId": id, "schema": "public", "table": "orders" }),
    )
    .await;
    let cols = st["columns"].as_array().unwrap();
    assert_eq!(cols[0]["name"], "id");
    assert_eq!(cols[0]["isPk"], true);
    let status = cols.iter().find(|c| c["name"] == "status").unwrap();
    assert_eq!(status["enumValues"].as_array().unwrap().len(), 5);
    assert_eq!(st["foreignKeys"][0]["refTable"], "customers");
    assert!(st["indexes"].as_array().unwrap().len() >= 3);

    let cust = call(
        &s,
        "pg.structure",
        json!({ "connectionId": id, "schema": "public", "table": "customers" }),
    )
    .await;
    assert!(
        cust["referencedBy"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["table"] == "orders")
    );
    assert_eq!(cust["comment"], "People who buy things");

    let view = call(
        &s,
        "pg.structure",
        json!({ "connectionId": id, "schema": "public", "table": "vip_customers" }),
    )
    .await;
    assert!(view["viewDefinition"].as_str().unwrap().contains("is_vip"));

    let comp = call(&s, "pg.completion", json!({ "connectionId": id })).await;
    assert!(comp.as_array().unwrap().iter().any(|t| t["table"] == "products"));
}

#[tokio::test]
async fn browse_filter_sort_page() {
    let s = state();
    let id = pg_conn(&s).await;
    let base = json!({ "connectionId": id, "schema": "public", "table": "customers" });

    let mut req = base.clone();
    req["limit"] = json!(50);
    let page = call(&s, "pg.rows", req).await;
    assert_eq!(page["rows"].as_array().unwrap().len(), 50);
    assert_eq!(page["total"], 5000);
    assert_eq!(page["rows"][0][0], "1");
    assert_eq!(page["editable"], true);

    // second page, sorted descending
    let mut req = base.clone();
    req["limit"] = json!(10);
    req["offset"] = json!(10);
    req["sort"] = json!([{ "column": "id", "desc": true }]);
    let page = call(&s, "pg.rows", req).await;
    assert_eq!(page["rows"][0][0], "4990");

    // typed comparison + text filter, AND
    let mut req = base.clone();
    req["filters"] = json!([
        { "column": "country", "op": "eq", "value": "PT" },
        { "column": "is_vip", "op": "is_true" },
        { "column": "id", "op": "between", "value": "1", "value2": "1000" }
    ]);
    let page = call(&s, "pg.rows", req).await;
    let expected = (1..=1000).filter(|g| g % 6 == 2 && g % 11 == 0).count();
    assert_eq!(page["total"], expected as i64);

    // OR mode, IN, null checks, contains on jsonb, raw where, search
    let mut req = base.clone();
    req["filters"] =
        json!([{ "column": "id", "op": "in", "value": "1, 2, 3" }, { "column": "id", "op": "eq", "value": "4999" }]);
    req["matchMode"] = json!("or");
    assert_eq!(call(&s, "pg.rows", req).await["total"], 4);

    let mut req = base.clone();
    req["filters"] = json!([{ "column": "birthday", "op": "is_null" }]);
    assert_eq!(call(&s, "pg.rows", req).await["total"], 1000);

    let mut req = base.clone();
    req["filters"] = json!([{ "column": "metadata", "op": "contains", "value": "\"plan\": \"team\"" }]);
    let n = call(&s, "pg.rows", req).await["total"].as_i64().unwrap();
    assert_eq!(n, (1..=5000).filter(|g| g % 3 == 2).count() as i64);

    let mut req = base.clone();
    req["rawWhere"] = json!("id % 100 = 0");
    assert_eq!(call(&s, "pg.rows", req).await["total"], 50);

    let mut req = base.clone();
    req["search"] = json!("user4242@");
    assert_eq!(call(&s, "pg.rows", req).await["total"], 1);

    // LIKE wildcards in user input are literal
    let mut req = base.clone();
    req["filters"] = json!([{ "column": "email", "op": "contains", "value": "%" }]);
    assert_eq!(call(&s, "pg.rows", req).await["total"], 0);

    // enum + timestamptz filters
    let mut req = json!({ "connectionId": id, "schema": "public", "table": "orders" });
    req["filters"] = json!([{ "column": "status", "op": "in", "value": "paid,shipped" }]);
    assert_eq!(call(&s, "pg.rows", req).await["total"], 8000);

    // bad column is rejected
    let mut req = base.clone();
    req["filters"] = json!([{ "column": "nope", "op": "eq", "value": "1" }]);
    assert!(dispatch(&s, "pg.rows", req).await.is_err());

    // views browse but are not editable
    let v = call(
        &s,
        "pg.rows",
        json!({ "connectionId": id, "schema": "public", "table": "vip_customers" }),
    )
    .await;
    assert_eq!(v["editable"], false);
    assert!(v["total"].as_i64().unwrap() > 0);

    // other schemas
    let d = call(
        &s,
        "pg.rows",
        json!({ "connectionId": id, "schema": "analytics", "table": "daily_visits" }),
    )
    .await;
    assert_eq!(d["total"], 91);
}

#[tokio::test]
async fn staged_edits_are_atomic() {
    let s = state();
    let id = pg_conn(&s).await;
    let t = |changes: Value| json!({ "connectionId": id, "schema": "public", "table": "products", "changes": changes });

    // insert with defaults, then update and delete by pk
    call(
        &s,
        "pg.apply",
        t(json!([{ "kind": "insert", "values": { "title": "Test item", "price": "9.99", "tags": "{a,b}" } }])),
    )
    .await;
    let mut find = json!({ "connectionId": id, "schema": "public", "table": "products" });
    find["filters"] = json!([{ "column": "title", "op": "eq", "value": "Test item" }]);
    let row = call(&s, "pg.rows", find.clone()).await;
    let pid = row["rows"][0][0].as_str().unwrap().to_string();
    assert_eq!(row["rows"][0][5], "{a,b}");

    call(&s, "pg.apply", t(json!([{ "kind": "update", "key": { "pk": { "id": pid } }, "values": { "price": "12.50", "description": null } }]))).await;
    let row = call(&s, "pg.rows", find.clone()).await;
    assert_eq!(row["rows"][0][3], "12.50");
    assert_eq!(row["rows"][0][6], Value::Null);

    // a failing change rolls back the whole batch
    let err = dispatch(
        &s,
        "pg.apply",
        t(json!([
            { "kind": "update", "key": { "pk": { "id": pid } }, "values": { "title": "Renamed" } },
            { "kind": "update", "key": { "pk": { "id": pid } }, "values": { "price": "-1" } }
        ])),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("Change #2"), "{}", err.message);
    assert_eq!(call(&s, "pg.rows", find.clone()).await["total"], 1);

    call(
        &s,
        "pg.apply",
        t(json!([{ "kind": "delete", "key": { "pk": { "id": pid } } }])),
    )
    .await;
    assert_eq!(call(&s, "pg.rows", find).await["total"], 0);

    // tables without a primary key are edited by ctid
    let log = call(
        &s,
        "pg.rows",
        json!({ "connectionId": id, "schema": "public", "table": "audit_log" }),
    )
    .await;
    let ctid = log["rowIds"][0].as_str().unwrap().to_string();
    let marker = format!("edited-{}", std::process::id());
    call(
        &s,
        "pg.apply",
        json!({ "connectionId": id, "schema": "public", "table": "audit_log",
                "changes": [{ "kind": "update", "key": { "ctid": ctid }, "values": { "actor": marker } }] }),
    )
    .await;
    let mut f = json!({ "connectionId": id, "schema": "public", "table": "audit_log" });
    f["filters"] = json!([{ "column": "actor", "op": "eq", "value": marker }]);
    assert_eq!(call(&s, "pg.rows", f).await["total"], 1);
}

#[tokio::test]
async fn sql_editor_and_history() {
    let s = state();
    let id = pg_conn(&s).await;
    let r = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "SELECT id, name, is_vip FROM customers ORDER BY id LIMIT 3" }),
    )
    .await;
    assert_eq!(r["results"][0]["rows"].as_array().unwrap().len(), 3);
    assert_eq!(r["results"][0]["columnTypes"], json!(["int8", "text", "bool"]));
    assert_eq!(r["history"]["rows"], 3);

    // multiple statements: command + result set
    let r = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "CREATE TEMP TABLE t(x int); INSERT INTO t SELECT generate_series(1,5); SELECT sum(x) FROM t;" }),
    )
    .await;
    let sets = r["results"].as_array().unwrap();
    assert_eq!(sets.len(), 3);
    assert_eq!(sets[1]["affected"], 5);
    assert_eq!(sets[2]["rows"][0][0], "15");

    // errors carry the position
    let r = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "SELECT * FROM nope" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "42P01");
    assert_eq!(r["error"]["position"], 15);

    // row cap truncates and stops the server
    let r = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "SELECT g FROM generate_series(1, 2000000) g", "maxRows": 1000 }),
    )
    .await;
    assert_eq!(r["results"][0]["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(r["results"][0]["truncated"], true);
    assert!(r["error"].is_null(), "{}", r["error"]);

    // the editor keeps its transaction across runs
    call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "BEGIN; UPDATE customers SET name = 'tx' WHERE id = 1" }),
    )
    .await;
    let other = call(
        &s,
        "pg.rows",
        json!({ "connectionId": id, "schema": "public", "table": "customers", "limit": 1 }),
    )
    .await;
    assert_ne!(other["rows"][0][1], "tx");
    call(&s, "pg.execute", json!({ "connectionId": id, "sql": "ROLLBACK" })).await;

    // cancel a long query from another task
    let s = std::sync::Arc::new(s);
    let s2 = s.clone();
    let id2 = id.clone();
    let run = tokio::spawn(async move {
        dispatch(
            &s2,
            "pg.execute",
            json!({ "connectionId": id2, "sql": "SELECT pg_sleep(10)" }),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    call(&s, "pg.cancel", json!({ "connectionId": id })).await;
    let r = run.await.unwrap().unwrap();
    assert_eq!(r["error"]["code"], "57014");

    // Cancelling right away, before the editor connection even exists, still works.
    let fresh = pg_conn(&s).await;
    let s3 = s.clone();
    let f2 = fresh.clone();
    let run = tokio::spawn(async move {
        dispatch(
            &s3,
            "pg.execute",
            json!({ "connectionId": f2, "sql": "SELECT pg_sleep(10)" }),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let started = std::time::Instant::now();
    call(&s, "pg.cancel", json!({ "connectionId": fresh })).await;
    let r = run.await.unwrap().unwrap();
    assert_eq!(r["error"]["code"], "57014");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));

    let hist = call(&s, "history.list", json!({ "connectionId": id })).await;
    assert!(hist.as_array().unwrap().len() >= 6);
    assert!(hist[0]["sql"].as_str().unwrap().contains("pg_sleep"));
    let found = call(
        &s,
        "history.list",
        json!({ "connectionId": id, "search": "generate_series(1, 2000000)" }),
    )
    .await;
    assert_eq!(found.as_array().unwrap().len(), 1);

    let saved = call(
        &s,
        "saved.save",
        json!({ "name": "Top customers", "sql": "SELECT 1", "connectionId": id }),
    )
    .await;
    assert_eq!(
        call(&s, "saved.list", json!({ "connectionId": id }))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&s, "saved.delete", json!({ "id": saved["id"] })).await;

    let act = call(&s, "pg.activity", json!({ "connectionId": id })).await;
    assert!(act.as_array().unwrap().iter().any(|a| a["application"] == "5db"));
}

#[tokio::test]
async fn redis_browse_and_edit() {
    let s = state();
    let id = redis_conn(&s).await;
    let info = call(&s, "redis.connect", json!({ "connectionId": id })).await;
    assert!(info["sections"]["server"]["redis_version"].is_string());
    assert_eq!(info["databases"], 16);

    let page = call(
        &s,
        "redis.scan",
        json!({ "connectionId": id, "pattern": "user:*", "count": 1000 }),
    )
    .await;
    assert_eq!(page["keys"].as_array().unwrap().len(), 50);
    assert_eq!(page["keys"][0]["type"], "hash");

    let typed = call(
        &s,
        "redis.scan",
        json!({ "connectionId": id, "keyType": "zset", "count": 1000 }),
    )
    .await;
    assert!(typed["keys"].as_array().unwrap().iter().all(|k| k["type"] == "zset"));

    let h = call(&s, "redis.get", json!({ "connectionId": id, "key": "user:7" })).await;
    assert_eq!(h["length"], 3);
    let z = call(&s, "redis.get", json!({ "connectionId": id, "key": "leaderboard" })).await;
    assert_eq!(z["value"][0]["member"], "diego");
    let st = call(&s, "redis.get", json!({ "connectionId": id, "key": "events:orders" })).await;
    assert_eq!(st["value"].as_array().unwrap().len(), 2);
    let l = call(&s, "redis.get", json!({ "connectionId": id, "key": "queue:emails" })).await;
    assert_eq!(l["value"][0], "welcome");
    let ttl = call(&s, "redis.get", json!({ "connectionId": id, "key": "session:user:1" })).await;
    assert!(ttl["ttlMs"].as_i64().unwrap() > 0);

    call(
        &s,
        "redis.command",
        json!({ "connectionId": id, "args": ["SET", "test:key", "hello world"] }),
    )
    .await;
    let v = call(&s, "redis.get", json!({ "connectionId": id, "key": "test:key" })).await;
    assert_eq!(v["value"], "hello world");
    let out = call(
        &s,
        "redis.console",
        json!({ "connectionId": id, "line": "SET test:key \"quoted value\" EX 100" }),
    )
    .await;
    assert_eq!(out["value"], "OK");
    let out = call(
        &s,
        "redis.console",
        json!({ "connectionId": id, "line": "GET test:key" }),
    )
    .await;
    assert_eq!(out["value"], "quoted value");
    call(
        &s,
        "redis.command",
        json!({ "connectionId": id, "args": ["DEL", "test:key"] }),
    )
    .await;
    assert!(
        dispatch(&s, "redis.get", json!({ "connectionId": id, "key": "test:key" }))
            .await
            .is_err()
    );

    // database switching
    let db1 = call(&s, "redis.scan", json!({ "connectionId": id, "db": 1 })).await;
    assert_eq!(db1["keys"][0]["key"], "cache:db1:hello");

    let err = dispatch(
        &s,
        "redis.console",
        json!({ "connectionId": id, "line": "NOTACOMMAND" }),
    )
    .await
    .unwrap_err();
    assert!(err.message.to_lowercase().contains("unknown"));
    let hist = call(&s, "history.list", json!({ "connectionId": id })).await;
    assert_eq!(hist.as_array().unwrap().len(), 3);
}

fn key_path() -> String {
    format!("{}/../docker/ssh/test_ed25519", env!("CARGO_MANIFEST_DIR"))
}

#[tokio::test]
async fn ssh_tunnels() {
    let s = state();
    // Postgres reached as "postgres:5432" from inside the bastion, by password.
    let pg = json!({ "name": "Tunnelled", "kind": "postgres", "host": "postgres", "port": 5432, "user": "fivedb",
        "password": "fivedb", "database": "shop", "sslMode": "disable",
        "sshEnabled": true, "sshHost": "127.0.0.1", "sshPort": 22229, "sshUser": "tunnel", "sshPassword": "tunnel" });
    let t = call(&s, "connections.test", pg.clone()).await;
    assert_eq!(t["viaSsh"], true);
    assert_eq!(t["database"], "shop");

    let id = call(&s, "connections.save", pg.clone()).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let rows = call(
        &s,
        "pg.rows",
        json!({ "connectionId": id, "schema": "public", "table": "customers", "limit": 3 }),
    )
    .await;
    assert_eq!(rows["total"], 5000);
    // The editor and writer connections share the same tunnel.
    let r = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "SELECT inet_server_port()" }),
    )
    .await;
    assert_eq!(r["results"][0]["rows"][0][0], "5432");

    // Redis through the same bastion, authenticating with a private key.
    let rd = json!({ "name": "Tunnelled cache", "kind": "redis", "host": "redis", "port": 6379, "password": "fivedb",
        "sshEnabled": true, "sshHost": "127.0.0.1", "sshPort": 22229, "sshUser": "tunnel", "sshKeyPath": key_path() });
    let rid = call(&s, "connections.save", rd).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let page = call(
        &s,
        "redis.scan",
        json!({ "connectionId": rid, "pattern": "user:*", "count": 1000 }),
    )
    .await;
    assert_eq!(page["keys"].as_array().unwrap().len(), 50);

    // Clear errors for the usual mistakes.
    let mut bad = pg.clone();
    bad["sshPassword"] = json!("wrong");
    let e = dispatch(&s, "connections.test", bad).await.unwrap_err();
    assert!(e.message.contains("rejected the credentials"), "{}", e.message);
    let mut bad = pg.clone();
    bad["host"] = json!("nowhere.invalid");
    let e = dispatch(&s, "connections.test", bad).await.unwrap_err();
    assert!(
        e.message.contains("forwarding to nowhere.invalid:5432"),
        "{}",
        e.message
    );
    let mut bad = pg.clone();
    bad["sshKeyPath"] = json!("/no/such/key");
    let e = dispatch(&s, "connections.test", bad).await.unwrap_err();
    assert!(e.message.contains("private key"), "{}", e.message);
}

/// The CA that signed the test server's certificate, written by
/// `scripts/tls-certs.sh`.
fn test_ca() -> String {
    format!("{}/../docker/pg/ca.crt", env!("CARGO_MANIFEST_DIR"))
}

fn tls_cfg(ssl_mode: &str, root_cert: &str) -> Value {
    json!({ "kind": "postgres", "host": "127.0.0.1", "port": 54329, "user": "fivedb",
            "password": "fivedb", "database": "shop", "sslMode": ssl_mode, "sslRootCert": root_cert })
}

#[tokio::test]
async fn pg_tls_modes() {
    let s = state();

    // `require` encrypts but asks nothing of the certificate, so a private CA
    // the machine does not know is still accepted.
    let ok = call(&s, "connections.test", tls_cfg("require", "")).await;
    assert!(ok["version"].as_str().unwrap().contains("PostgreSQL"));

    // Verifying without being told about the CA has to fail: that is the whole
    // point of the mode.
    for mode in ["verify-ca", "verify-full"] {
        let err = dispatch(&s, "connections.test", tls_cfg(mode, ""))
            .await
            .expect_err(&format!("{mode} must reject an unknown CA"));
        let msg = serde_json::to_string(&err).unwrap();
        assert!(
            msg.to_lowercase().contains("certificate") || msg.to_lowercase().contains("tls"),
            "{mode} failed for the wrong reason: {msg}"
        );
    }

    // With the CA both verifying modes succeed; the server certificate carries
    // IP:127.0.0.1 in its SAN, which is what verify-full checks.
    for mode in ["verify-ca", "verify-full"] {
        let ok = call(&s, "connections.test", tls_cfg(mode, &test_ca())).await;
        assert!(
            ok["version"].as_str().unwrap().contains("PostgreSQL"),
            "{mode} should connect with the CA supplied"
        );
    }

    // A CA file that is not a certificate is reported, not silently ignored.
    let err = dispatch(&s, "connections.test", tls_cfg("verify-full", "/nonexistent/ca.pem"))
        .await
        .expect_err("a missing CA file must be an error");
    assert!(serde_json::to_string(&err).unwrap().contains("Could not read"));
}

#[tokio::test]
async fn pg_statement_timeout_is_enforced() {
    let s = state();
    let saved = call(
        &s,
        "connections.save",
        json!({ "name": "Slow", "kind": "postgres", "host": "127.0.0.1", "port": 54329, "user": "fivedb",
                "password": "fivedb", "database": "shop", "sslMode": "disable", "statementTimeoutMs": 300 }),
    )
    .await;
    let id = saved["id"].as_str().unwrap();

    // pg.execute reports a statement error inside its result, not as an RPC failure.
    let out = call(
        &s,
        "pg.execute",
        json!({ "connectionId": id, "sql": "SELECT pg_sleep(3)" }),
    )
    .await;
    // 57014 is query_canceled, which is how statement_timeout reports.
    assert_eq!(out["error"]["code"], "57014", "unexpected result: {out}");
    assert!(
        out["durationMs"].as_f64().unwrap() < 2000.0,
        "it should have stopped well before the 3s sleep"
    );

    // A quick statement on the same connection is unaffected.
    let ok = call(&s, "pg.execute", json!({ "connectionId": id, "sql": "SELECT 1" })).await;
    assert_eq!(ok["results"][0]["rows"][0][0], "1");
}
