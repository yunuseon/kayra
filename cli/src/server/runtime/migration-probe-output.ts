import { parseMigrationProbe } from "../../contracts/migration-probe.ts";

/** Docker's non-TTY stdout frames, not stderr, shell output or a truncated tail. */
// eslint-disable-next-line functional/prefer-immutable-types -- adapter-owned bytes are inspected without mutation
export const migrationProbeOutput = (bytes: Uint8Array) => {
  if (bytes.byteLength > 1024) return "unknown";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // eslint-disable-next-line functional/prefer-immutable-types -- bounded adapter-owned frame accumulator
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line functional/no-let -- validates every frame boundary before decoding
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8 || view.getUint8(offset) !== 1 || [1, 2, 3].some((index) => view.getUint8(offset + index) !== 0)) return "unknown";
    const length = view.getUint32(offset + 4);
    if (length > bytes.byteLength - offset - 8) return "unknown";
    // eslint-disable-next-line functional/immutable-data -- bounded private frame accumulator
    chunks.push(bytes.subarray(offset + 8, offset + 8 + length)); offset += 8 + length;
  }
  try {
    const response = parseMigrationProbe(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
    return response.ok ? response.value.outcome : "unknown";
  } catch { return "unknown"; }
};
