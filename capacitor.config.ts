import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.progressfityj.app",
  appName: "ProgressFit",
  webDir: "out",
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon_config_sample",
      iconColor: "#2563eb",
      sound: "default",
    },
  },
};

export default config;
