/** "1 server", "3 servers": a count with its noun. */
export const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
