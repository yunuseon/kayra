import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { err, ok } from "../../result.ts";
import type { DirectoryListing } from "./contract.gen.ts";

export const directories = async (path: string, root: string) => {
  try {
    const absolute = await realpath(resolve(root, path));
    const entries = await readdir(absolute, { withFileTypes: true });
    const children = await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(absolute, entry.name);
        const directory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await stat(path).then(
              (info) => info.isDirectory(),
              () => false,
            )));
        return directory ? [{ name: entry.name, path }] : [];
      }),
    );
    return ok<DirectoryListing>({ path: absolute, parent: dirname(absolute), directories: children.flat().toSorted((a, b) => a.name.localeCompare(b.name)) });
  } catch {
    return err("Cannot read that directory. Check its path and permissions.");
  }
};
