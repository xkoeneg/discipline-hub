import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.disciplinehub.app",
  appName: "Discipline Hub",
  webDir: "dist",
  // Behind the web page; avoids a white flash while the app starts.
  backgroundColor: "#0b0b0c",
  plugins: {
    SystemBars: {
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
      style: "DARK",
    },
  },
};

export default config;
