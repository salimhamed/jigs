import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

export interface SystemdUserManager {
  available(): boolean;
  linger(): boolean | undefined;
  scopeState(unit: string): string;
  stopScope(unit: string): void;
}

export const systemdUserManager: SystemdUserManager = {
  available() {
    if (process.platform !== "linux") return false;
    return (
      spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0 &&
      spawnSync("systemctl", ["--user", "show-environment"], {
        stdio: "ignore",
      }).status === 0
    );
  },
  linger() {
    let user: string;
    try {
      user = userInfo().username;
    } catch {
      return undefined;
    }
    const result = spawnSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim() === "yes";
  },
  scopeState(unit) {
    const result = spawnSync("systemctl", ["--user", "is-active", `${unit}.scope`], {
      encoding: "utf8",
    });
    const state = result.stdout.trim();
    if (state === "active" || state === "activating" || state === "deactivating") return "active";
    if (state === "inactive" || state === "failed") return "inactive";
    return "unknown";
  },
  stopScope(unit) {
    spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  },
};
