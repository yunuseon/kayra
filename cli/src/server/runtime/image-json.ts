/* eslint-disable functional/no-let, functional/immutable-data -- owns bounded, linear-time lexical scanner state */
const reserved = new Map(["schemaVersion", "mediaType", "config", "Volumes", "manifests", "platform", "architecture", "os", "variant", "os.features", "features", "digest", "size", "layers"].map((key) => [key.toLowerCase(), key] as const));

/** JSON.parse validates syntax; the scanner refuses duplicate/aliased keys before typed metadata interpretation. */
export const imageJson = (source: string) => {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new Error("image metadata exceeds limit");
  const value: unknown = JSON.parse(source);
  // eslint-disable-next-line functional/prefer-immutable-types -- private frames and key sets mutate in place for linear-time scanning
  const frames: { object: boolean; keys: Set<string>; key: boolean }[] = []; let count = 0;
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  for (const match of source.matchAll(tokens)) {
    if (++count > 262144) throw new Error("image metadata exceeds token limit");
    const token = match[0]; const frame = frames.at(-1);
    if (token === "{" || token === "[") {
      if (frames.length >= 64) throw new Error("image metadata exceeds nesting limit");
      frames.push({ object: token === "{", keys: new Set(), key: token === "{" });
    } else if (token === "}" || token === "]") frames.pop();
    else if (token === "," && frame?.object === true) frame.key = true;
    else if (token === ":" && frame?.object === true) frame.key = false;
    else if (token.startsWith('"') && frame?.object === true && frame.key) {
      const key: unknown = JSON.parse(token); if (typeof key !== "string") throw new Error("image metadata has invalid keys");
      // Compatibility normalization also refuses Unicode aliases of ASCII field names.
      const folded = key.normalize("NFKC").toLowerCase(); const canonical = reserved.get(folded);
      if (frame.keys.has(folded) || canonical !== undefined && key !== canonical) throw new Error("image metadata has ambiguous keys");
      frame.keys.add(folded); frame.key = false;
    }
  }
  return value;
};
