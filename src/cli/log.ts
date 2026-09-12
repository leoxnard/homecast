const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = c("2");
export const bold = c("1");
export const green = c("32");
export const yellow = c("33");
export const red = c("31");
export const cyan = c("36");

export const info = (msg: string) => console.log(msg);
export const step = (msg: string) => console.log(`${cyan("›")} ${msg}`);
export const ok = (msg: string) => console.log(`${green("✓")} ${msg}`);
export const warn = (msg: string) => console.log(`${yellow("!")} ${msg}`);
export const fail = (msg: string) => console.error(`${red("✗")} ${msg}`);

/** Two-column key/value table, aligned on the widest key. */
export function table(rows: Array<[string, string]>, indent = "  "): void {
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  for (const [k, v] of rows) console.log(`${indent}${dim(k.padEnd(width))}  ${v}`);
}

/** Single-line progress that overwrites itself on a TTY. */
export function progress(msg: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${dim(msg)}`);
}
export function progressDone(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}
