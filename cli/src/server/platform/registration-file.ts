import { constants } from "node:fs";
import { open } from "node:fs/promises";

const maxFileBytes = 64 * 1024;

/** Callers supply paths under a trusted, read-only platform mount. */
export const readRegistrationFile = async (path: string, mode: number, group: number) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.gid !== group || (info.mode & 0o7777) !== mode ||
      info.nlink !== 1 || info.size > maxFileBytes) throw new Error("invalid registration file");
    const data = Buffer.alloc(info.size + 1);
    // eslint-disable-next-line functional/no-let -- read may return only part of a file
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("registration file changed during read");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, offset));
  } finally {
    await file.close();
  }
};
