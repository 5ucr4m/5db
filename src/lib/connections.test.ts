import { describe, expect, it } from "vitest";
import { blankConnection, byGroup, connectionSummary, monogram, parseConnectionUrl } from "./connections";

describe("parseConnectionUrl — postgres", () => {
  it("reads every part of a full URL", () => {
    expect(parseConnectionUrl("postgres://alice:s3cret@db.example.com:5433/shop?sslmode=require")).toEqual({
      kind: "postgres",
      host: "db.example.com",
      port: 5433,
      user: "alice",
      password: "s3cret",
      database: "shop",
      sslMode: "require",
      sslRootCert: "",
    });
  });

  it("accepts the postgresql:// spelling", () => {
    expect(parseConnectionUrl("postgresql://h/db")?.kind).toBe("postgres");
  });

  it("fills in the defaults a bare URL leaves out", () => {
    const c = parseConnectionUrl("postgres://localhost/mydb");
    expect(c).toMatchObject({ port: 5432, user: "postgres", database: "mydb", password: "", sslMode: "prefer" });
  });

  it("defaults the database when the path is empty", () => {
    expect(parseConnectionUrl("postgres://localhost")?.database).toBe("postgres");
  });

  it("decodes a percent-encoded password", () => {
    expect(parseConnectionUrl("postgres://u:p%40ss%2Fword@h/db")?.password).toBe("p@ss/word");
  });

  it("keeps every sslmode it supports, verify-ca included", () => {
    expect(parseConnectionUrl("postgres://h/db?sslmode=verify-ca")?.sslMode).toBe("verify-ca");
    expect(parseConnectionUrl("postgres://h/db?sslmode=verify-full")?.sslMode).toBe("verify-full");
    expect(parseConnectionUrl("postgres://h/db?sslmode=disable")?.sslMode).toBe("disable");
  });

  it("reads a CA bundle path out of the query string", () => {
    expect(parseConnectionUrl("postgres://h/db?sslmode=verify-full&sslrootcert=/etc/ssl/rds.pem")?.sslRootCert).toBe("/etc/ssl/rds.pem");
  });

  it("ignores an sslmode it does not know", () => {
    expect(parseConnectionUrl("postgres://h/db?sslmode=banana")?.sslMode).toBe("prefer");
  });
});

describe("parseConnectionUrl — redis", () => {
  it("reads password-only auth and the db index from the path", () => {
    expect(parseConnectionUrl("redis://:fivedb@127.0.0.1:63799/3")).toEqual({
      kind: "redis",
      host: "127.0.0.1",
      port: 63799,
      user: "",
      password: "fivedb",
      redisDb: 3,
      tls: false,
      tlsInsecure: false,
    });
  });

  it("turns on TLS for rediss:// and defaults the port", () => {
    expect(parseConnectionUrl("rediss://cache.example.com")).toMatchObject({ tls: true, port: 6379, redisDb: 0 });
  });

  it("keeps an ACL username", () => {
    expect(parseConnectionUrl("redis://reader:pw@h/0")?.user).toBe("reader");
  });

  it("ignores a path that is not a db index", () => {
    expect(parseConnectionUrl("redis://h/not-a-number")?.redisDb).toBe(0);
  });
});

describe("parseConnectionUrl — rejections", () => {
  it("returns null for anything it cannot own", () => {
    expect(parseConnectionUrl("mysql://h/db")).toBeNull();
    expect(parseConnectionUrl("db.example.com:5432")).toBeNull();
    expect(parseConnectionUrl("")).toBeNull();
    expect(parseConnectionUrl("   ")).toBeNull();
    expect(parseConnectionUrl("postgres://")).toBeNull();
  });

  it("tolerates surrounding whitespace, which is how URLs arrive from a paste", () => {
    expect(parseConnectionUrl("  postgres://h/db\n")?.host).toBe("h");
  });
});

describe("blankConnection", () => {
  it("defaults the port and credentials per kind", () => {
    expect(blankConnection("postgres")).toMatchObject({ port: 5432, user: "postgres", database: "postgres" });
    expect(blankConnection("redis")).toMatchObject({ port: 6379, user: "", database: "" });
  });

  it("defaults to verifying TLS and to no statement timeout", () => {
    expect(blankConnection("redis").tlsInsecure).toBe(false);
    expect(blankConnection("postgres").statementTimeoutMs).toBe(0);
  });
});

describe("connectionSummary", () => {
  const base = blankConnection("postgres");

  it("shows user@host:port/database", () => {
    expect(connectionSummary({ ...base, host: "h", port: 5432, user: "alice", database: "shop" })).toBe("alice@h:5432/shop");
  });

  it("omits the user when there is none", () => {
    expect(connectionSummary({ ...base, host: "h", user: "", database: "shop" })).toBe("h:5432/shop");
  });

  it("names the bastion when the connection is tunnelled", () => {
    expect(connectionSummary({ ...base, host: "h", user: "", database: "shop", sshEnabled: true, sshHost: "bastion" })).toBe(
      "h:5432 via bastion/shop",
    );
  });

  it("shows the db index for redis", () => {
    expect(connectionSummary({ ...blankConnection("redis"), host: "h", redisDb: 2 })).toBe("h:6379 · db 2");
  });
});

describe("monogram", () => {
  it("takes the initials of the first two words", () => {
    expect(monogram("Shop local")).toBe("SL");
    expect(monogram("my_app-db")).toBe("MA");
  });

  it("takes two letters from a single word", () => {
    expect(monogram("shop")).toBe("SH");
    expect(monogram("a")).toBe("A");
  });

  it("never returns an empty label", () => {
    expect(monogram("")).toBe("?");
    expect(monogram("   ")).toBe("?");
    expect(monogram("__")).toBe("?");
  });
});

describe("byGroup", () => {
  const c = (name: string, group?: string) => ({ name, group });

  it("keeps groups alphabetical and leaves the ungrouped ones last", () => {
    const out = byGroup([c("a", "Work"), c("b"), c("c", "Analytics"), c("d", "Work")]);
    expect(out.map((g) => g.group)).toEqual(["Analytics", "Work", ""]);
    expect(out[1].items.map((i) => i.name)).toEqual(["a", "d"]);
    expect(out[2].items.map((i) => i.name)).toEqual(["b"]);
  });

  it("treats whitespace and a missing group as the same thing", () => {
    expect(byGroup([c("a", "  "), c("b"), c("c", "")]).map((g) => g.group)).toEqual([""]);
  });

  it("preserves the order within a group, which is the user's own ordering", () => {
    const out = byGroup([c("z", "G"), c("a", "G")]);
    expect(out[0].items.map((i) => i.name)).toEqual(["z", "a"]);
  });

  it("returns nothing for an empty list", () => {
    expect(byGroup([])).toEqual([]);
  });
});
