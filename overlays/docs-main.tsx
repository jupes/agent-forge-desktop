import { render } from "preact";
import { installDesktopConnection } from "../../apps/desktop/src/ConnectionBanner";
import { DesktopApp } from "../../apps/desktop/src/DesktopApp";
import { DashboardApp } from "./app";

const desktop = import.meta.env?.MODE === "desktop";
if (desktop) installDesktopConnection();
const root = document.getElementById("app");
if (root) render(desktop ? <DesktopApp /> : <DashboardApp />, root);
