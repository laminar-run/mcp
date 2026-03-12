import { describe, it, expect } from "vitest";
import { generateInspectScript } from "../inspect-scripts.js";

describe("generateInspectScript", () => {
  describe("uiautomation (auto)", () => {
    it("generates window_list script", () => {
      const script = generateInspectScript({ mode: "window_list" });
      expect(script).toContain("import json, uiautomation as auto");
      expect(script).toContain("GetRootControl");
      expect(script).toContain("print(json.dumps");
    });

    it("generates screen_info script", () => {
      const script = generateInspectScript({ mode: "screen_info" });
      expect(script).toContain("GetSystemMetrics");
      expect(script).toContain("screenWidth");
    });

    it("generates element_at_point script with coordinates", () => {
      const script = generateInspectScript({
        mode: "element_at_point",
        x: 100,
        y: 200,
      });
      expect(script).toContain("x, y = 100, 200");
      expect(script).toContain("ControlFromPoint");
    });

    it("generates element_tree script with depth", () => {
      const script = generateInspectScript({
        mode: "element_tree",
        depth: 5,
      });
      expect(script).toContain("MAX_DEPTH = 5");
      expect(script).toContain("build_tree");
    });

    it("generates element_tree script with window title", () => {
      const script = generateInspectScript({
        mode: "element_tree",
        windowTitle: "Open Dental",
      });
      expect(script).toContain('"Open Dental"');
      expect(script).toContain("WindowControl");
    });

    it("generates focused_element script", () => {
      const script = generateInspectScript({ mode: "focused_element" });
      expect(script).toContain("GetFocusedControl");
    });
  });

  describe("pywinauto", () => {
    it("generates window_list script", () => {
      const script = generateInspectScript({
        mode: "window_list",
        framework: "pywinauto",
      });
      expect(script).toContain("from pywinauto import Desktop");
      expect(script).toContain('backend="uia"');
    });
  });

  describe("jab", () => {
    it("generates window_list script", () => {
      const script = generateInspectScript({
        mode: "window_list",
        framework: "jab",
      });
      expect(script).toContain("JavaAccessBridgeWrapper");
    });
  });
});
