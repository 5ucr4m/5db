import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, formatDuration, formatInt, formatTtl, relativeTime, tryPrettyJson, typeFamily } from "./format";

describe("typeFamily", () => {
  it("recognises the numeric types", () => {
    for (const t of ["int4", "integer", "bigint", "smallint", "numeric(10,2)", "double precision", "real", "money", "bigserial", "oid"])
      expect(typeFamily(t)).toBe("num");
  });

  it("recognises the text, time, bool, json, uuid and binary types", () => {
    expect(typeFamily("character varying(255)")).toBe("text");
    expect(typeFamily("citext")).toBe("text");
    expect(typeFamily("timestamp with time zone")).toBe("time");
    expect(typeFamily("interval")).toBe("time");
    expect(typeFamily("boolean")).toBe("bool");
    expect(typeFamily("jsonb")).toBe("json");
    expect(typeFamily("uuid")).toBe("uuid");
    expect(typeFamily("bytea")).toBe("binary");
  });

  it("does not mistake a type that merely starts like another for it", () => {
    expect(typeFamily("interval")).toBe("time");
    expect(typeFamily("int4range")).toBe("other");
    expect(typeFamily("timestamptz")).toBe("time");
  });

  it("detects arrays by suffix, by internal name and by category", () => {
    expect(typeFamily("text[]")).toBe("array");
    expect(typeFamily("_int4")).toBe("array");
    expect(typeFamily("whatever", "A")).toBe("array");
  });

  it("takes an array or enum category over the name", () => {
    expect(typeFamily("int4", "A")).toBe("array");
    expect(typeFamily("order_status", "E")).toBe("enum");
  });

  it("falls back to the catalog category for a type it does not know by name", () => {
    expect(typeFamily("mystery", "N")).toBe("num");
    expect(typeFamily("mystery", "D")).toBe("time");
    expect(typeFamily("mystery", "S")).toBe("text");
    expect(typeFamily("mystery", "B")).toBe("bool");
    expect(typeFamily("mystery")).toBe("other");
  });
});

describe("formatBytes", () => {
  it("keeps a decimal below 10 of a unit and drops it above", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("stops at the largest unit it knows", () => {
    expect(formatBytes(2 * 1024 ** 5)).toBe("2048 TB");
  });

  it("renders an unknown size as a dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatInt(null)).toBe("—");
    expect(formatInt(1234567)).toBe("1,234,567");
  });
});

describe("formatDuration", () => {
  it("picks the unit by magnitude", () => {
    expect(formatDuration(0.4)).toBe("<1 ms");
    expect(formatDuration(1)).toBe("1 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});

describe("formatTtl", () => {
  it("names the two sentinel values redis uses", () => {
    expect(formatTtl(-1)).toBe("No expiry");
    expect(formatTtl(-2)).toBe("Expired");
  });

  it("picks the unit by magnitude", () => {
    expect(formatTtl(30_000)).toBe("30s");
    expect(formatTtl(90_000)).toBe("1m 30s");
    expect(formatTtl(7_200_000)).toBe("2h 0m");
    expect(formatTtl(2 * 86_400_000 + 3_600_000)).toBe("2d 1h");
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const at = (iso: string, now: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    return relativeTime(iso);
  };

  it("describes the recent past in the coarsest useful unit", () => {
    expect(at("2026-01-01T12:00:00Z", "2026-01-01T12:00:10Z")).toBe("just now");
    expect(at("2026-01-01T12:00:00Z", "2026-01-01T12:05:00Z")).toBe("5 min ago");
    expect(at("2026-01-01T12:00:00Z", "2026-01-01T15:00:00Z")).toBe("3 h ago");
    expect(at("2026-01-01T12:00:00Z", "2026-01-04T12:00:00Z")).toBe("3 d ago");
  });

  it("falls back to a date past a month", () => {
    expect(at("2026-01-01T12:00:00Z", "2026-06-01T12:00:00Z")).toMatch(/\d/);
  });

  it("says never when there is no timestamp", () => {
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime(undefined)).toBe("never");
  });
});

describe("tryPrettyJson", () => {
  it("formats objects and arrays", () => {
    expect(tryPrettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(tryPrettyJson(" [1,2] ")).toBe("[\n  1,\n  2\n]");
  });

  it("declines anything that is not valid JSON object or array text", () => {
    expect(tryPrettyJson("not json")).toBeNull();
    expect(tryPrettyJson('{"a":')).toBeNull();
    expect(tryPrettyJson("42")).toBeNull();
    expect(tryPrettyJson('"a string"')).toBeNull();
    expect(tryPrettyJson("")).toBeNull();
  });
});
