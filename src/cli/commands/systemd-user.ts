import { spawnSync } from "node:child_process";

export interface SystemdUserManager {
  available(): boolean;
  linger(): boolean | undefined;
}

export const systemdUserManager: SystemdUserManager = {
  available() {
    if (process.platform !== "linux") return false;
    return (
      spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], {
        stdio: "ignore",
      }).status === 0
    );
  },
  linger() {
    const user = process.env.USER;
    if (user === undefined || user === "") return undefined;
    const result = spawnSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim() === "yes";
  },
};
