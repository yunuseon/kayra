import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const maximumBytes = 4 * 1024 * 1024;
const digestOf = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const syncDirectory = async (directory: string) => {
  const file = await open(directory, "r");
  try { await file.sync(); }
  finally { await file.close(); }
};

/** Trusted coordinator directory; artifacts contain app descriptions, never materialized platform secrets. */
export const openArtifactStore = async (directory: string) => {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid?.()) throw new Error("invalid artifact directory");
  await syncDirectory(dirname(directory));
  const read = async (digest: string) => {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid artifact digest");
    const file = await open(join(directory, digest + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== info.uid || (stat.mode & 0o7777) !== 0o400 || stat.size > maximumBytes) throw new Error("invalid artifact file");
      const bytes = await file.readFile();
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (bytes.length !== stat.size || digestOf(content) !== digest) throw new Error("artifact integrity check failed");
      return content;
    } finally { await file.close(); }
  };
  const retain = async (content: string) => {
    if (Buffer.byteLength(content, "utf8") > maximumBytes) throw new Error("artifact exceeds retention limit");
    const digest = digestOf(content);
    const temporary = join(directory, `.artifact-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o400);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally { await file.close(); }
    try {
      await link(temporary, join(directory, digest + ".json")).catch((error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
      });
    } finally { await unlink(temporary); }
    await syncDirectory(directory);
    if (await read(digest) !== content) throw new Error("artifact content mismatch");
    return digest;
  };
  return Object.freeze({ retain, read });
};
