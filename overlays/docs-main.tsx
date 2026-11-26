import { render } from "preact";

async function mount() {
  const root = document.getElementById("app");
  if (import.meta.env?.MODE === "desktop") {
    const [{ DesktopApp }, { installDesktopConnection }] = await Promise.all([
      import("../../apps/desktop/src/DesktopApp"),
      import("../../apps/desktop/src/ConnectionBanner"),
    ]);
    installDesktopConnection();
    if (root) render(<DesktopApp />, root);
  } else if (root) {
    const { DashboardApp } = await import("./app");
    render(<DashboardApp />, root);
  }
}

void mount();
