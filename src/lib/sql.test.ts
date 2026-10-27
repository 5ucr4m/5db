import { describe, expect, it } from "vitest";
import { destructiveReason, insertStatements, literal, quoteIdent, splitStatements, statementAt } from "./sql";

describe("quoteIdent / literal", () => {
  it("doubles embedded quotes", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(literal("O'Brien")).toBe("'O''Brien'");
  });

  it("renders null as NULL, not as a quoted empty string", () => {
    expect(literal(null)).toBe("NULL");
    expect(literal("")).toBe("''");
  });
});

describe("splitStatements", () => {
  it("splits on top-level semicolons and keeps offsets into the original text", () => {
    const sql = "SELECT 1; SELECT 2";
    const [a, b] = splitStatements(sql);
    expect([a.text, b.text]).toEqual(["SELECT 1;", "SELECT 2"]);
    expect(sql.slice(a.from, a.to)).toBe(a.text);
    expect(sql.slice(b.from, b.to)).toBe(b.text);
  });

  it("ignores semicolons inside single and double quotes", () => {
    expect(splitStatements("SELECT ';'")).toHaveLength(1);
    expect(splitStatements('SELECT "a;b" FROM t')).toHaveLength(1);
  });

  it("handles doubled quotes inside a string", () => {
    expect(splitStatements("SELECT 'it''s; fine'")).toHaveLength(1);
  });

  it("ignores semicolons inside a dollar-quoted body", () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()`;
    expect(splitStatements(sql).map((s) => s.text.slice(0, 15))).toEqual(["CREATE FUNCTION", "SELECT f()"]);
  });

  it("respects a tagged dollar quote", () => {
    expect(splitStatements("SELECT $tag$ a; b $tag$")).toHaveLength(1);
  });

  it("ignores semicolons inside line and block comments", () => {
    expect(splitStatements("SELECT 1 -- ; not a split\n")).toHaveLength(1);
    expect(splitStatements("SELECT /* ; */ 1")).toHaveLength(1);
  });

  it("drops comment-only and empty input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n  ")).toEqual([]);
    expect(splitStatements("-- just a note")).toEqual([]);
    expect(splitStatements(";;;")).toEqual([]);
    expect(splitStatements("/* just a note */")).toEqual([]);
    expect(splitStatements("SELECT 1;;")).toHaveLength(1);
  });

  it("does not lose a trailing statement without a semicolon", () => {
    expect(splitStatements("SELECT 1;\nSELECT 2;\nSELECT 3")).toHaveLength(3);
  });
});

describe("statementAt", () => {
  const sql = "SELECT 1;\nSELECT 2;\nSELECT 3";

  it("finds the statement containing the cursor", () => {
    expect(statementAt(sql, 3)?.text).toBe("SELECT 1;");
    expect(statementAt(sql, 13)?.text).toBe("SELECT 2;");
    expect(statementAt(sql, sql.length)?.text).toBe("SELECT 3");
  });

  it("falls back to the previous statement when the cursor sits in whitespace", () => {
    expect(statementAt("SELECT 1;\n\n\n", 11)?.text).toBe("SELECT 1;");
  });

  it("falls back to the first statement when the cursor precedes everything", () => {
    expect(statementAt("\n\n  SELECT 1;", 0)?.text).toBe("SELECT 1;");
  });

  it("returns null when there is nothing to run", () => {
    expect(statementAt("-- nothing here", 2)).toBeNull();
  });
});

describe("destructiveReason", () => {
  it("flags the statements that cannot be undone", () => {
    expect(destructiveReason("DROP TABLE users")).toMatch(/drops an object/);
    expect(destructiveReason("truncate orders")).toMatch(/truncates/);
    expect(destructiveReason("DELETE FROM orders")).toMatch(/every row/);
    expect(destructiveReason("UPDATE orders SET paid = true")).toMatch(/every row/);
    expect(destructiveReason("ALTER TABLE orders DROP COLUMN total")).toMatch(/drops a column/);
  });

  it("allows the scoped versions", () => {
    expect(destructiveReason("DELETE FROM orders WHERE id = 1")).toBeNull();
    expect(destructiveReason("UPDATE orders SET paid = true WHERE id = 1")).toBeNull();
    expect(destructiveReason("SELECT * FROM orders")).toBeNull();
    expect(destructiveReason("ALTER TABLE orders ADD COLUMN note text")).toBeNull();
  });

  it("does not take a WHERE from inside a comment as real", () => {
    expect(destructiveReason("DELETE FROM orders -- WHERE id = 1")).toMatch(/every row/);
    expect(destructiveReason("UPDATE orders SET paid = true /* WHERE id = 1 */")).toMatch(/every row/);
  });

  it("checks every statement in the batch, not just the first", () => {
    expect(destructiveReason("SELECT 1; DROP TABLE users")).toMatch(/drops an object/);
  });
});

describe("insertStatements", () => {
  it("quotes columns and escapes values", () => {
    expect(
      insertStatements(
        '"public"."t"',
        ["id", "na'me"],
        [
          ["1", "O'Brien"],
          ["2", null],
        ],
      ),
    ).toBe(
      `INSERT INTO "public"."t" ("id", "na'me") VALUES ('1', 'O''Brien');\n` +
        `INSERT INTO "public"."t" ("id", "na'me") VALUES ('2', NULL);\n`,
    );
  });
});
