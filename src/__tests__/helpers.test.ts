import { describe, it, expect } from "vitest";
import { json, ok, text, safe, buildRpaProgram } from "../helpers.js";

describe("json", () => {
  it("serializes objects with 2-space indent", () => {
    expect(json({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("handles null", () => {
    expect(json(null)).toBe("null");
  });
});

describe("ok", () => {
  it("wraps data in MCP text content", () => {
    const result = ok({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ foo: "bar" });
  });
});

describe("text", () => {
  it("wraps a string in MCP text content", () => {
    const result = text("hello");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("hello");
  });
});

describe("safe", () => {
  it("returns ok() on success", async () => {
    const result = await safe(async () => ({ x: 1 }));
    expect(JSON.parse(result.content[0].text)).toEqual({ x: 1 });
  });

  it("returns text() with error message on failure", async () => {
    const result = await safe(async () => {
      throw new Error("boom");
    });
    expect(result.content[0].text).toBe("Error: boom");
  });
});

describe("buildRpaProgram", () => {
  it("generates cloudflare_tunnel pattern with lam.httpRequest", () => {
    const program = buildRpaProgram(
      'print("hello")',
      "cloudflare_tunnel",
      "test-step",
      "Test Step",
      "A test step",
    );
    expect(program).toContain("lam.httpRequest");
    expect(program).toContain("{{config.laminar_desktop_service_url}}/execute");
    expect(program).toContain("{{config.laminar_desktop_service_api_key}}");
    expect(program).toContain("{{config.laminar_desktop_service_id}}");
    expect(program).toContain('"flowId": "test-step"');
    expect(program).toContain('print("hello")');
    expect(program).toMatch(/^\(data\) =>/);
  });

  it("generates channel pattern with lam.rpa", () => {
    const program = buildRpaProgram(
      'print("hello")',
      "channel",
      "test-step",
      "Test Step",
      "A test step",
    );
    expect(program).toContain("lam.rpa");
    expect(program).toContain("{{config.channelId}}");
    expect(program).not.toContain("lam.httpRequest");
    expect(program).toMatch(/^\(data\) =>/);
  });

  it("escapes backticks and dollar signs in python script", () => {
    const program = buildRpaProgram(
      'f"value is ${x}" + `tick`',
      "cloudflare_tunnel",
      "id",
      "name",
      "desc",
    );
    expect(program).toContain("\\`");
    expect(program).toContain("\\$");
    // The escaped form \${x} should be present, not raw ${x}
    expect(program).toContain("\\${x}");
  });

  it("escapes double quotes in step name and description", () => {
    const program = buildRpaProgram(
      "pass",
      "cloudflare_tunnel",
      "id",
      'Step "with" quotes',
      'Desc "here"',
    );
    expect(program).toContain('Step \\"with\\" quotes');
    expect(program).toContain('Desc \\"here\\"');
  });
});
