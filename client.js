// dsh-notemap client — header.actions slot entry via official slots API (React-rendered,
// survives React reconciliation, unlike raw DOM injection which React clears on rerender).
const react = require("react");
const jsx = require("react/jsx-runtime");

window.__ModuleLoader__.load({
  id: "@snow-the/dsh-notemap",
  factory: () => {
    const module = { exports: {} };

    // health marker: set as soon as this client executes (guide_boot uiChecks target)
    document.documentElement.setAttribute("data-notemap-mounted", "");

    const openNotemap = () => {
      const w = window.open("/notemap/", "_blank");
      if (!w) window.location.href = "/notemap/";
    };

    const HeaderButton = (props) => jsx.jsx("button", {
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
