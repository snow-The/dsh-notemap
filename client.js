// dsh-notemap client — floating draggable window (no full-screen lock).
// Persists position/size in localStorage; drag via title bar, resize via SE handle.
// require() must live INSIDE the factory (factory receives require as parameter).
window.__ModuleLoader__.load({
  id: "@snow-the/dsh-notemap",
  factory: (require) => {
    const module = { exports: {} };
    const react = require("react");
    const jsx = require("react/jsx-runtime");

    document.documentElement.setAttribute("data-notemap-mounted", "");

    const DIALOG_ID = "notemap-dialog-root";
    const LS_KEY = "dsh.notemap.rect";
    const MIN_W = 320, MIN_H = 240;

    function loadRect() {
      try {
        const r = JSON.parse(localStorage.getItem(LS_KEY) || "null");
        if (r && typeof r.left === "number" && typeof r.top === "number" && r.w >= MIN_W && r.h >= MIN_H) return r;
      } catch { /* fall through */ }
      return { left: Math.max(8, window.innerWidth - 600), top: 88, w: 560, h: 420 };
    }
    function saveRect(r) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch { /* ignore */ }
    }

    const openNotemap = () => {
      let root = document.getElementById(DIALOG_ID);
      if (root) { root.style.display = "flex"; return; }
      const rect = loadRect();
      root = document.createElement("div");
      root.id = DIALOG_ID;
      root.style.cssText = "position:fixed;z-index:9998;font-family:system-ui,sans-serif;";
      root.style.left = rect.left + "px";
      root.style.top = rect.top + "px";
      root.style.width = rect.w + "px";
      root.style.height = rect.h + "px";
      root.style.display = "flex";
      root.style.flexDirection = "column";
      root.style.background = "var(--ds-bg, #1a1a1e)";
      root.style.border = "1px solid var(--ds-border, rgba(128,128,128,.4))";
      root.style.borderRadius = "12px";
      root.style.boxShadow = "0 12px 40px rgba(0,0,0,.45)";
      root.style.overflow = "hidden";

      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--ds-border, rgba(128,128,128,.25));flex:none;cursor:grab;user-select:none;";
      bar.title = "拖拽移动窗口";
      bar.innerHTML = '<span style="font-size:13px;font-weight:600;flex:1;color:inherit;">🧠 知识图谱 · notemap</span>';
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.style.cssText = "border:1px solid var(--ds-border, rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:8px;width:26px;height:26px;font-size:15px;cursor:pointer;line-height:1;";
      close.addEventListener("click", () => { root.style.display = "none"; });
      bar.appendChild(close);

      const frame = document.createElement("iframe");
      frame.src = "/notemap/";
      frame.style.cssText = "flex:1;border:0;width:100%;height:100%;background:#fff;";

      const grip = document.createElement("div");
      grip.style.cssText = "position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:se-resize;";
      grip.title = "拖拽调整大小";

      root.appendChild(bar);
      root.appendChild(frame);
      root.appendChild(grip);

      // ---- drag via title bar ----
      let dragging = null;
      bar.addEventListener("pointerdown", (e) => {
        if (e.target === close) return;
        dragging = { dx: e.clientX - root.offsetLeft, dy: e.clientY - root.offsetTop, moved: false };
        bar.setPointerCapture(e.pointerId);
      });
      bar.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const l = Math.min(Math.max(0, e.clientX - dragging.dx), window.innerWidth - 40);
        const t = Math.min(Math.max(0, e.clientY - dragging.dy), window.innerHeight - 40);
        root.style.left = l + "px";
        root.style.top = t + "px";
        dragging.moved = true;
      });
      bar.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        const wasMoved = dragging.moved;
        dragging = null;
        if (!wasMoved) return;
        saveRect({ left: root.offsetLeft, top: root.offsetTop, w: root.offsetWidth, h: root.offsetHeight });
      });

      // ---- resize via SE grip ----
      let resizing = null;
      grip.addEventListener("pointerdown", (e) => {
        resizing = { x: e.clientX, y: e.clientY, w: root.offsetWidth, h: root.offsetHeight };
        grip.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      grip.addEventListener("pointermove", (e) => {
        if (!resizing) return;
        const w = Math.max(MIN_W, Math.min(window.innerWidth - root.offsetLeft, resizing.w + (e.clientX - resizing.x)));
        const h = Math.max(MIN_H, Math.min(window.innerHeight - root.offsetTop, resizing.h + (e.clientY - resizing.y)));
        root.style.width = w + "px";
        root.style.height = h + "px";
      });
      grip.addEventListener("pointerup", () => {
        if (!resizing) return;
        resizing = null;
        saveRect({ left: root.offsetLeft, top: root.offsetTop, w: root.offsetWidth, h: root.offsetHeight });
      });

      document.body.appendChild(root);
    };

    const HeaderButton = () => jsx.jsx("button", {
      type: "button",
      "data-notemap-anchor": "true",
      title: "打开知识图谱(可拖拽小窗口)",
      "aria-label": "打开知识图谱",
      onClick: openNotemap,
      style: {
        display: "inline-flex", alignItems: "center", gap: "4px",
        padding: "2px 8px", border: "1px solid var(--ds-border, #444)",
        borderRadius: "6px", background: "transparent", color: "inherit",
        fontSize: "12px", cursor: "pointer", lineHeight: "1.6",
      },
      children: "图谱",
    });

    module.exports.inject = ["slots"];

    module.exports.apply = (ctx) => {
      try {
        ctx.slots.inject("conversation.session.header.actions", () =>
          ctx.slots.register({
            name: "conversation.session.header.actions",
            id: "notemap-open",
            order: 20,
          }, () => HeaderButton())
        );
      } catch (e) {
        console.warn("[notemap] slots injection failed:", e);
      }
    };

    return module.exports;
  }
});
