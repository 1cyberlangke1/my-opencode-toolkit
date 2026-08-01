import type { Platform } from "./platform";
import { detectPlatform } from "./platform";
import {
  sendLinuxNotification,
  sendMacosNotification,
  sendWindowsNotification,
} from "./send";

export interface NotificationContent {
  title: string;
  message: string;
}

export interface NotificationSender {
  send(content: NotificationContent): Promise<void>;
}

export function createNotificationSender(platform: NodeJS.Platform): NotificationSender {
  const detected: Platform = detectPlatform(platform);

  return {
    async send({ title, message }): Promise<void> {
      switch (detected) {
        case "win32":
          await sendWindowsNotification(title, message);
          break;
        case "darwin":
          await sendMacosNotification(title, message);
          break;
        case "linux":
          await sendLinuxNotification(title, message);
          break;
        case "unsupported":
          break;
      }
    },
  };
}
