import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { HealthDashboard } from "./src/ui/HealthDashboard";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "codebase-health",
    title: "Codebase health",
    icon: "SecurityCheck",
    path: "codebase-health",
    component: HealthDashboard,
  });
});
