import { describe, expect, it } from "vitest";
import { toCsv, toJson, toMarkdown, toTsv } from "./export";

const cols = ["id", "name"];

describe("toCsv", () => {
  it("writes a header and one line per row, ending with a newline", () => {
    expect(toCsv(cols, [["1", "ana"]])).toBe("id,name\n1,ana\n");
  });

  it("quotes fields containing a comma, a quote or a newline, and doubles the quotes", () => {
    expect(toCsv(["a"], [["x,y"], ['he said "hi"'], ["two\nlines"]])).toBe('a\n"x,y"\n"he said ""hi"""\n"two\nlines"\n');
  });

  it("writes NULL as an empty field, distinct from a quoted empty string", () => {
    expect(toCsv(["a", "b"], [[null, ""]])).toBe("a,b\n,\n");
  });

  it("still emits the header for an empty result", () => {
    expect(toCsv(cols, [])).toBe("id,name\n");
  });
});

describe("toTsv", () => {
  it("replaces tabs and newlines so a cell cannot break the grid", () => {
    expect(toTsv(null, [["a\tb", "c\nd"]])).toBe("a b\tc d");
  });

  it("omits the header when asked to, which is what a cell-range copy wants", () => {
    expect(toTsv(null, [["1", "ana"]])).toBe("1\tana");
    expect(toTsv(cols, [["1", "ana"]])).toBe("id\tname\n1\tana");
  });

  it("writes NULL as empty", () => {
    expect(toTsv(null, [[null, "x"]])).toBe("\tx");
  });
});

describe("toJson", () => {
  it("emits an array of objects keyed by column, preserving null", () => {
    expect(JSON.parse(toJson(cols, [["1", null]]))).toEqual([{ id: "1", name: null }]);
  });

  it("emits an empty array for no rows", () => {
    expect(JSON.parse(toJson(cols, []))).toEqual([]);
  });
});

describe("toMarkdown", () => {
  it("writes a table with a separator row", () => {
    expect(toMarkdown(cols, [["1", "ana"]])).toBe("| id | name |\n| --- | --- |\n| 1 | ana |\n");
  });

  it("escapes pipes and flattens newlines so the table survives", () => {
    expect(toMarkdown(["a"], [["x|y"], ["two\nlines"]])).toBe("| a |\n| --- |\n| x\\|y |\n| two lines |\n");
  });

  it("writes NULL explicitly, since an empty cell would be ambiguous", () => {
    expect(toMarkdown(["a"], [[null]])).toBe("| a |\n| --- |\n| NULL |\n");
  });
});
