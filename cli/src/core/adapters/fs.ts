import { existsSync, readdirSync, readFileSync } from "node:fs";
import { typed } from "../../typed.ts";

/** A file's text; undefined where there is none. */
export const textAt = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The folders in a directory, by name; none where it is missing. */
export const foldersIn = (path: string) =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
    : typed<readonly string[]>([]);

/** The files in a directory ending in `suffix`, by name; none where it is missing. */
export const filesIn = (path: string, suffix: string) =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => entry.name)
        .toSorted()
    : typed<readonly string[]>([]);
