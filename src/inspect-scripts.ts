/**
 * Python script generators for VM UI inspection.
 *
 * Each function returns a Python script string that, when executed on the VM
 * via LDS /execute, prints structured JSON to stdout for the agent to parse.
 */

export type InspectMode =
  | "window_list"
  | "screen_info"
  | "element_at_point"
  | "element_tree"
  | "focused_element";

export type InspectFramework = "auto" | "uiautomation" | "pywinauto" | "jab";

export interface InspectParams {
  mode: InspectMode;
  x?: number;
  y?: number;
  windowTitle?: string;
  framework?: InspectFramework;
  depth?: number;
}

export function generateInspectScript(params: InspectParams): string {
  const fw = params.framework ?? "auto";

  if (fw === "jab") {
    return generateJabScript(params);
  }
  if (fw === "pywinauto") {
    return generatePywinautoScript(params);
  }
  // "auto" and "uiautomation" both use uiautomation
  return generateUiautomationScript(params);
}

// ─── uiautomation scripts ────────────────────────────────────

function generateUiautomationScript(params: InspectParams): string {
  switch (params.mode) {
    case "window_list":
      return `
import json, uiautomation as auto

results = []
root = auto.GetRootControl()
for win in root.GetChildren():
    try:
        rect = win.BoundingRectangle
        results.append({
            "name": win.Name or "",
            "controlType": win.ControlTypeName,
            "className": win.ClassName,
            "automationId": win.AutomationId,
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
            "size": f"{rect.width()}x{rect.height()}"
        })
    except Exception:
        pass
print(json.dumps({"windows": results, "count": len(results)}, indent=2))
`.trim();

    case "screen_info":
      return `
import json, ctypes

user32 = ctypes.windll.user32
w = user32.GetSystemMetrics(0)
h = user32.GetSystemMetrics(1)

try:
    import uiautomation as auto
    fg = auto.GetForegroundControl()
    fg_rect = fg.BoundingRectangle
    active = {
        "name": fg.Name or "",
        "controlType": fg.ControlTypeName,
        "rect": {"left": fg_rect.left, "top": fg_rect.top, "right": fg_rect.right, "bottom": fg_rect.bottom}
    }
except Exception:
    active = None

dpi = ctypes.windll.shcore.GetScaleFactorForDevice(0) if hasattr(ctypes.windll, 'shcore') else 100
print(json.dumps({
    "screenWidth": w,
    "screenHeight": h,
    "dpiScale": dpi,
    "activeWindow": active
}, indent=2))
`.trim();

    case "element_at_point":
      return `
import json, uiautomation as auto

x, y = ${params.x ?? 0}, ${params.y ?? 0}
try:
    ctrl = auto.ControlFromPoint(x, y)
    rect = ctrl.BoundingRectangle
    result = {
        "name": ctrl.Name or "",
        "controlType": ctrl.ControlTypeName,
        "automationId": ctrl.AutomationId,
        "className": ctrl.ClassName,
        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        "size": f"{rect.width()}x{rect.height()}",
        "center": {"x": rect.xcenter(), "y": rect.ycenter()},
        "isEnabled": ctrl.IsEnabled,
        "point": {"x": x, "y": y}
    }

    try:
        parent = ctrl.GetParentControl()
        if parent:
            result["parent"] = {"name": parent.Name or "", "controlType": parent.ControlTypeName}
    except Exception:
        pass

    print(json.dumps(result, indent=2))
except Exception as e:
    print(json.dumps({"error": f"No element found at ({x}, {y}): {e}", "point": {"x": x, "y": y}}, indent=2))
`.trim();

    case "element_tree": {
      const maxDepth = params.depth ?? 3;
      const titleFilter = params.windowTitle
        ? JSON.stringify(params.windowTitle)
        : "None";
      return `
import json, uiautomation as auto

MAX_DEPTH = ${maxDepth}
TITLE_FILTER = ${titleFilter}

def build_tree(ctrl, depth=0):
    if depth > MAX_DEPTH:
        return None
    try:
        rect = ctrl.BoundingRectangle
        node = {
            "name": ctrl.Name or "",
            "controlType": ctrl.ControlTypeName,
            "automationId": ctrl.AutomationId,
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        }
        children = []
        for child in ctrl.GetChildren():
            c = build_tree(child, depth + 1)
            if c:
                children.append(c)
        if children:
            node["children"] = children
        return node
    except Exception:
        return None

if TITLE_FILTER:
    win = auto.WindowControl(searchDepth=1, Name=TITLE_FILTER)
    if not win.Exists(1, 0):
        print(json.dumps({"error": f"Window '{TITLE_FILTER}' not found"}))
    else:
        tree = build_tree(win)
        print(json.dumps({"root": tree}, indent=2))
else:
    fg = auto.GetForegroundControl()
    tree = build_tree(fg)
    print(json.dumps({"root": tree, "windowName": fg.Name}, indent=2))
`.trim();
    }

    case "focused_element":
      return `
import json, uiautomation as auto

ctrl = auto.GetFocusedControl()
rect = ctrl.BoundingRectangle
result = {
    "name": ctrl.Name or "",
    "controlType": ctrl.ControlTypeName,
    "automationId": ctrl.AutomationId,
    "className": ctrl.ClassName,
    "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
    "size": f"{rect.width()}x{rect.height()}",
    "center": {"x": rect.xcenter(), "y": rect.ycenter()},
    "isEnabled": ctrl.IsEnabled
}

try:
    parent = ctrl.GetParentControl()
    if parent:
        result["parent"] = {"name": parent.Name or "", "controlType": parent.ControlTypeName}
except Exception:
    pass

print(json.dumps(result, indent=2))
`.trim();

    default:
      return `print("Unknown mode")`;
  }
}

// ─── pywinauto scripts ───────────────────────────────────────

function generatePywinautoScript(params: InspectParams): string {
  switch (params.mode) {
    case "window_list":
      return `
import json
from pywinauto import Desktop

desktop = Desktop(backend="uia")
results = []
for win in desktop.windows():
    try:
        rect = win.rectangle()
        results.append({
            "name": win.window_text() or "",
            "controlType": win.friendly_class_name(),
            "className": win.class_name(),
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
            "size": f"{rect.width()}x{rect.height()}",
            "visible": win.is_visible(),
            "enabled": win.is_enabled()
        })
    except Exception:
        pass
print(json.dumps({"windows": results, "count": len(results)}, indent=2))
`.trim();

    case "screen_info":
      return `
import json, ctypes

user32 = ctypes.windll.user32
w = user32.GetSystemMetrics(0)
h = user32.GetSystemMetrics(1)

from pywinauto import Desktop
desktop = Desktop(backend="uia")
active = None
try:
    fg = desktop.top_window()
    rect = fg.rectangle()
    active = {
        "name": fg.window_text(),
        "className": fg.class_name(),
        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom}
    }
except Exception:
    pass

print(json.dumps({"screenWidth": w, "screenHeight": h, "activeWindow": active}, indent=2))
`.trim();

    case "element_at_point":
      return `
import json
from pywinauto import Desktop

x, y = ${params.x ?? 0}, ${params.y ?? 0}
desktop = Desktop(backend="uia")
elem = desktop.from_point(x, y)
rect = elem.rectangle()
result = {
    "name": elem.window_text() or "",
    "controlType": elem.friendly_class_name(),
    "className": elem.class_name(),
    "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
    "size": f"{rect.width()}x{rect.height()}",
    "enabled": elem.is_enabled(),
    "point": {"x": x, "y": y}
}
print(json.dumps(result, indent=2))
`.trim();

    case "element_tree": {
      const maxDepth = params.depth ?? 3;
      const titleFilter = params.windowTitle
        ? JSON.stringify(params.windowTitle)
        : "None";
      return `
import json
from pywinauto import Desktop

MAX_DEPTH = ${maxDepth}
TITLE_FILTER = ${titleFilter}

def build_tree(ctrl, depth=0):
    if depth > MAX_DEPTH:
        return None
    try:
        rect = ctrl.rectangle()
        node = {
            "name": ctrl.window_text() or "",
            "controlType": ctrl.friendly_class_name(),
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        }
        children = []
        for child in ctrl.children():
            c = build_tree(child, depth + 1)
            if c:
                children.append(c)
        if children:
            node["children"] = children
        return node
    except Exception:
        return None

desktop = Desktop(backend="uia")
if TITLE_FILTER:
    try:
        win = desktop.window(title=TITLE_FILTER)
        tree = build_tree(win)
        print(json.dumps({"root": tree}, indent=2))
    except Exception as e:
        print(json.dumps({"error": f"Window '{TITLE_FILTER}' not found: {e}"}))
else:
    win = desktop.top_window()
    tree = build_tree(win)
    print(json.dumps({"root": tree, "windowName": win.window_text()}, indent=2))
`.trim();
    }

    case "focused_element":
      return `
import json
from pywinauto import Desktop

desktop = Desktop(backend="uia")
try:
    win = desktop.top_window()
    focused = win.get_focus()
    rect = focused.rectangle()
    result = {
        "name": focused.window_text() or "",
        "controlType": focused.friendly_class_name(),
        "className": focused.class_name(),
        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        "size": f"{rect.width()}x{rect.height()}",
        "enabled": focused.is_enabled()
    }
    print(json.dumps(result, indent=2))
except Exception as e:
    print(json.dumps({"error": f"Could not get focused element: {e}"}))
`.trim();

    default:
      return `print("Unknown mode")`;
  }
}

// ─── Java Access Bridge scripts ──────────────────────────────

function generateJabScript(params: InspectParams): string {
  switch (params.mode) {
    case "window_list":
      return `
import json, queue, threading, ctypes, time
from ctypes import byref, wintypes
from JABWrapper.jab_wrapper import JavaAccessBridgeWrapper

GetMessage = ctypes.windll.user32.GetMessageW
TranslateMessage = ctypes.windll.user32.TranslateMessage
DispatchMessage = ctypes.windll.user32.DispatchMessageW

def pump_bg(pipe):
    try:
        jab = JavaAccessBridgeWrapper(ignore_callbacks=True)
        pipe.put(jab)
        msg = byref(wintypes.MSG())
        while GetMessage(msg, 0, 0, 0) > 0:
            TranslateMessage(msg)
            DispatchMessage(msg)
    except Exception as e:
        pipe.put(None)

pipe = queue.Queue()
t = threading.Thread(target=pump_bg, daemon=True, args=[pipe])
t.start()
jab = pipe.get()
if not jab:
    print(json.dumps({"error": "Failed to initialize Java Access Bridge"}))
else:
    time.sleep(0.1)
    windows = jab.get_windows()
    results = []
    for w in windows:
        results.append({"title": w.title, "hwnd": w.hwnd})
    jab.shutdown()
    print(json.dumps({"javaWindows": results, "count": len(results)}, indent=2))
`.trim();

    case "screen_info":
      // JAB doesn't have screen info; fall back to basic ctypes
      return `
import json, ctypes

user32 = ctypes.windll.user32
w = user32.GetSystemMetrics(0)
h = user32.GetSystemMetrics(1)
print(json.dumps({"screenWidth": w, "screenHeight": h, "note": "JAB does not provide screen DPI info"}, indent=2))
`.trim();

    case "element_at_point": {
      const x = params.x ?? 0;
      const y = params.y ?? 0;
      return `
import json, queue, threading, ctypes, time
from ctypes import byref, wintypes
from JABWrapper.jab_wrapper import JavaAccessBridgeWrapper

GetMessage = ctypes.windll.user32.GetMessageW
TranslateMessage = ctypes.windll.user32.TranslateMessage
DispatchMessage = ctypes.windll.user32.DispatchMessageW

def pump_bg(pipe):
    try:
        jab = JavaAccessBridgeWrapper(ignore_callbacks=True)
        pipe.put(jab)
        msg = byref(wintypes.MSG())
        while GetMessage(msg, 0, 0, 0) > 0:
            TranslateMessage(msg)
            DispatchMessage(msg)
    except Exception as e:
        pipe.put(None)

pipe = queue.Queue()
t = threading.Thread(target=pump_bg, daemon=True, args=[pipe])
t.start()
jab = pipe.get()
if not jab:
    print(json.dumps({"error": "Failed to initialize Java Access Bridge"}))
else:
    time.sleep(0.1)
    x, y = ${x}, ${y}
    windows = jab.get_windows()
    found = False
    for w in windows:
        try:
            vm_id, root_ctx = jab.get_accessible_context_from_hwnd(w.hwnd)
            jab.set_context(vm_id, root_ctx)
            elem_ctx = jab.get_accessible_context_at(root_ctx, x, y)
            if elem_ctx and elem_ctx.value:
                info = jab.get_context_info(elem_ctx)
                result = {
                    "name": info.name, "role": info.role, "description": info.description,
                    "states": info.states, "x": info.x, "y": info.y,
                    "width": info.width, "height": info.height,
                    "indexInParent": info.indexInParent, "childrenCount": info.childrenCount,
                    "window": w.title, "point": {"x": x, "y": y}
                }
                print(json.dumps(result, indent=2))
                found = True
                break
        except Exception:
            continue
    if not found:
        print(json.dumps({"error": "No Java element found at cursor position", "point": {"x": x, "y": y}}))
    jab.shutdown()
`.trim();
    }

    case "element_tree": {
      const maxDepth = params.depth ?? 3;
      const titleFilter = params.windowTitle
        ? JSON.stringify(params.windowTitle)
        : "None";
      return `
import json, queue, threading, ctypes, time
from ctypes import byref, wintypes
from JABWrapper.jab_wrapper import JavaAccessBridgeWrapper

GetMessage = ctypes.windll.user32.GetMessageW
TranslateMessage = ctypes.windll.user32.TranslateMessage
DispatchMessage = ctypes.windll.user32.DispatchMessageW

MAX_DEPTH = ${maxDepth}
TITLE_FILTER = ${titleFilter}

def pump_bg(pipe):
    try:
        jab = JavaAccessBridgeWrapper(ignore_callbacks=True)
        pipe.put(jab)
        msg = byref(wintypes.MSG())
        while GetMessage(msg, 0, 0, 0) > 0:
            TranslateMessage(msg)
            DispatchMessage(msg)
    except Exception as e:
        pipe.put(None)

def build_tree(jab, ctx, depth=0):
    if depth > MAX_DEPTH:
        return None
    try:
        info = jab.get_context_info(ctx)
        node = {"name": info.name, "role": info.role, "x": info.x, "y": info.y, "width": info.width, "height": info.height}
        children = []
        for i in range(info.childrenCount):
            try:
                child_ctx = jab.get_accessible_child_from_context(ctx, i)
                c = build_tree(jab, child_ctx, depth + 1)
                if c:
                    children.append(c)
            except Exception:
                pass
        if children:
            node["children"] = children
        return node
    except Exception:
        return None

pipe = queue.Queue()
t = threading.Thread(target=pump_bg, daemon=True, args=[pipe])
t.start()
jab = pipe.get()
if not jab:
    print(json.dumps({"error": "Failed to initialize Java Access Bridge"}))
else:
    time.sleep(0.1)
    windows = jab.get_windows()
    target = None
    for w in windows:
        if TITLE_FILTER is None or TITLE_FILTER.lower() in w.title.lower():
            target = w
            break
    if not target:
        print(json.dumps({"error": f"No matching Java window found (filter={TITLE_FILTER})"}))
    else:
        vm_id, root_ctx = jab.get_accessible_context_from_hwnd(target.hwnd)
        jab.set_context(vm_id, root_ctx)
        tree = build_tree(jab, root_ctx)
        print(json.dumps({"root": tree, "window": target.title}, indent=2))
    jab.shutdown()
`.trim();
    }

    case "focused_element":
      return `
import json, queue, threading, ctypes, time
from ctypes import byref, wintypes
from JABWrapper.jab_wrapper import JavaAccessBridgeWrapper

GetMessage = ctypes.windll.user32.GetMessageW
TranslateMessage = ctypes.windll.user32.TranslateMessage
DispatchMessage = ctypes.windll.user32.DispatchMessageW

def pump_bg(pipe):
    try:
        jab = JavaAccessBridgeWrapper(ignore_callbacks=True)
        pipe.put(jab)
        msg = byref(wintypes.MSG())
        while GetMessage(msg, 0, 0, 0) > 0:
            TranslateMessage(msg)
            DispatchMessage(msg)
    except Exception as e:
        pipe.put(None)

def find_focused(jab, ctx, window_title, max_depth=20):
    try:
        info = jab.get_context_info(ctx)
        if 'focused' in (info.states or '').lower():
            return {
                "name": info.name, "role": info.role,
                "x": info.x, "y": info.y, "width": info.width, "height": info.height,
                "states": info.states, "window": window_title
            }
        if max_depth > 0:
            for i in range(info.childrenCount):
                try:
                    child_ctx = jab.get_accessible_child_from_context(ctx, i)
                    result = find_focused(jab, child_ctx, window_title, max_depth - 1)
                    if result:
                        return result
                except Exception:
                    pass
    except Exception:
        pass
    return None

pipe = queue.Queue()
t = threading.Thread(target=pump_bg, daemon=True, args=[pipe])
t.start()
jab = pipe.get()
if not jab:
    print(json.dumps({"error": "Failed to initialize Java Access Bridge"}))
else:
    time.sleep(0.1)
    windows = jab.get_windows()
    found = None
    for w in windows:
        try:
            vm_id, root_ctx = jab.get_accessible_context_from_hwnd(w.hwnd)
            jab.set_context(vm_id, root_ctx)
            found = find_focused(jab, root_ctx, w.title)
            if found:
                break
        except Exception:
            continue
    if found:
        print(json.dumps(found, indent=2))
    else:
        print(json.dumps({"info": "No focused Java element found. Listing windows instead."}))
    jab.shutdown()
`.trim();

    default:
      return `print("Unknown mode")`;
  }
}
