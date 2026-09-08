/**
 * One palette, so every command looks like the same tool.
 *
 * `watch` already had these colours and nothing else did, which made the screen and the analysis
 * commands look like two different programs. They are not decoration: at a glance the eye should be
 * able to find the number that matters, tell a figure the tool measured from one it assumed, and see
 * a row that failed its own test without reading the row.
 *
 * Colour is dropped when the output is not a terminal, so a redirect into a file or a pipe into
 * `grep` stays plain text. `FORCE_COLOR=1` puts it back, which is how the README screenshots are
 * taken.
 */
const on = process.env.FORCE_COLOR === "1" || (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);

const wrap = (code: string) => (s: string | number): string => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const rgb = (r: number, g: number, b: number): ((s: string | number) => string) => wrap(`38;2;${r};${g};${b}`);

/** The headline figure: the one number a reader is looking for. */
export const lime = rgb(204, 255, 0);
/** A result that failed a check, or a loss. */
export const red = rgb(255, 107, 87);
/** Worth a second look, but not a verdict. */
export const amber = rgb(232, 184, 58);
/** Passed. */
export const green = rgb(126, 231, 135);
export const white = rgb(232, 234, 223);
/** Labels, units, and everything the eye should slide over. */
export const dim = rgb(110, 112, 104);
/** Rules and separators. */
export const faint = rgb(60, 62, 56);
export const bold = wrap("1");

/** A multiple, coloured by whether it made or lost money. 1.0 is the line. */
export const money = (v: number, text = `${v.toFixed(2)}x`): string =>
  v >= 1.15 ? lime(text) : v >= 1 ? green(text) : v >= 0.9 ? amber(text) : red(text);

/** A lift over a base rate, coloured against the floor it has to clear. */
export const lift = (v: number, floor: number, text = `${v.toFixed(2)}x`): string =>
  v >= floor * 1.5 ? lime(text) : v >= floor ? green(text) : dim(text);
