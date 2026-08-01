export type Platform = "darwin" | "linux" | "win32" | "unsupported";

export function detectPlatform(platform: NodeJS.Platform): Platform {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "win32";
    default:
      return "unsupported";
  }
}
