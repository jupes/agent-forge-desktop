import { render } from "preact";
import { DashboardApp } from "./app";
import { DesktopApp } from "../../apps/desktop/src/DesktopApp";
import { installDesktopConnection } from "../../apps/desktop/src/ConnectionBanner";

const desktop = import.meta.env?.MODE === "desktop";
if (desktop) installDesktopConnection();
const root = document.getElementById("app");
if (root) render(desktop ? <DesktopApp /> : <DashboardApp />, root);
