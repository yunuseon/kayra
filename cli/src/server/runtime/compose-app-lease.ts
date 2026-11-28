import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import type { AppName } from "../../contracts/identity.ts";

/** Hold the same open file description as flock so direct effect children can inherit it. */
export const acquireComposeAppLease = (directory: string, app: AppName) => {
  const fd = openSync(join(directory, app + ".lock"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("invalid app lock file");
    const locked = spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000 });
    if (locked.status === 0) return Object.freeze({ fd, close: () => { closeSync(fd); } });
    if (locked.status !== 75) throw new Error("could not acquire app lock");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  closeSync(fd);
  return undefined;
};
