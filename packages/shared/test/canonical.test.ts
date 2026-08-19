import { describe, it, expect } from "vitest";
import { canonicalJson, CanonicalizationError } from "../src/canonical.js";
import { contentHash } from "../src/hash.js";

describe("canonicalJson", () => {
  it("is insensitive to key insertion order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts keys at every depth", () => {
    const a = { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] };
    const b = { a: [{ c: 2, d: 1 }], z: { x: 2, y: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("preserves array order, which is semantically significant", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("omits undefined members like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("normalizes -0 so it cannot fork a hash", () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it("rejects values with no stable representation", () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ n: Infinity })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ b: 1n })).toThrow(CanonicalizationError);
  });

  it("rejects cycles instead of hanging", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(/circular/);
  });

  it("rejects exotic objects that would silently stringify to {}", () => {
    expect(() => canonicalJson({ m: new Map([["a", 1]]) })).toThrow(CanonicalizationError);
  });

  it("reports the path of the offending value", () => {
    expect(() => canonicalJson({ outer: { inner: [1, NaN] } })).toThrow(/outer\.inner\[1\]/);
  });
});

describe("contentHash", () => {
  it("is stable across key reordering", () => {
    expect(contentHash({ a: 1, b: [2, 3] })).toBe(contentHash({ b: [2, 3], a: 1 }));
  });

  it("changes when any value changes", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
