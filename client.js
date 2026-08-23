// dsh-notemap client — header.actions slot entry via official slots API (React-rendered).
// require() must live INSIDE the factory (factory receives require as parameter).
window.__ModuleLoader__.load({
  id: "@snow-the/dsh-notemap",
  factory: (require) => {
    const module = { exports: {} };
    const react = require("react");
    const jsx = require("react/jsx-runtime");

    document.documentElement.setAttribute("data-notemap-mounted", "");

    // Embedded dialog (body-level overlay + iframe): React never touches nodes
    // attached directly to document.body, so the dialog survives reconciliation.
    const DIALOG_ID = "notemap-dialog-root";
    const openNotemap = () => {
      if (document.getElementById(DIALOG_ID)) {
        document.getElementById(DIALOG_ID).style.display = "flex";
        return;
      }
      const root = document.createElement("div");
      root.id = DIALOG_ID;
      root.style.cssText = "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font-family:system-ui,sans-serif;";
      const panel = document.createElement("div");
      panel.style.cssText = "position:relative;width:min(1080px,94vw);height:min(760px,92vh);background:var(--ds-bg, #1a1a1e);border:1px solid var(--ds-border, rgba(128,128,128,.4));border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ds-border, rgba(128,128,128,.25));flex:none;";
      bar.innerHTML = '<span style="font-size:13px;font-weight:600;flex:1;color:inherit;">无限画布 · notemap</span>';
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.style.cssText = "border:1px solid var(--ds-border, rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:8px;width:26px;height:26px;font-size:15px;cursor:pointer;line-height:1;";
      close.addEventListener("click", () => { root.style.display = "none"; });
      bar.appendChild(close);
      const frame = document.createElement("iframe");
      frame.src = "/notemap/";
      frame.style.cssText = "flex:1;border:0;width:100%;height:100%;background:#fff;";
      panel.appendChild(bar);
      panel.appendChild(frame);
      root.appendChild(panel);
      root.addEventListener("click", (e) => { if (e.target === root) root.style.display = "none"; });
      document.body.appendChild(root);
    };

    const HeaderButton = () => jsx.jsx("button", {
      type: "button",
      "data-notemap-anchor": "true",
      title: "打开图谱视图(notemap)",
      "aria-label": "打开图谱视图",
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