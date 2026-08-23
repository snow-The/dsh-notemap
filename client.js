// dsh-notemap client — header.actions slot entry via official slots API (React-rendered).
// require() must live INSIDE the factory (factory receives require as parameter).
window.__ModuleLoader__.load({
  id: "@snow-the/dsh-notemap",
  factory: (require) => {
    const module = { exports: {} };
    const react = require("react");
    const jsx = require("react/jsx-runtime");

    document.documentElement.setAttribute("data-notemap-mounted", "");

    const openNotemap = () => {
      const w = window.open("/notemap/", "_blank");
      if (!w) window.location.href = "/notemap/";
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
