import { describe, it, expect } from "vitest";
import { computeDiff } from "../diff.js";

describe("computeDiff", () => {
  it("shows no changes for identical strings", () => {
    const diff = computeDiff("hello\nworld", "hello\nworld", "A", "B");
    expect(diff).not.toContain("+");
    expect(diff).not.toContain("-");
  });

  it("shows additions", () => {
    const diff = computeDiff("line1", "line1\nline2", "A", "B");
    expect(diff).toContain("+ line2");
  });

  it("shows removals", () => {
    const diff = computeDiff("line1\nline2", "line1", "A", "B");
    expect(diff).toContain("- line2");
  });

  it("uses provided labels", () => {
    const diff = computeDiff("a", "b", "Old", "New");
    expect(diff).toContain("Old");
    expect(diff).toContain("New");
  });
});
