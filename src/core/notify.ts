// Terminal notifications: a BEL and, where the terminal supports it, a
// desktop notification via OSC 777 (iTerm2/kitty/foot/WezTerm surface it;
// other terminals silently ignore the unrecognized escape sequence). No
// external processes, no dependencies — just writing to stdout.

/** Rings the terminal bell and, if supported, shows a desktop notification
 * with the given title/body. */
export function notify(title: string, body: string): void {
  process.stdout.write(`\x07\x1b]777;notify;${title};${body}\x07`);
}

/** Rings the terminal bell only, with no OSC notification — used when the
 * run is already on-screen and a full notification would be redundant, but
 * the user may still have looked away. */
export function bell(): void {
  process.stdout.write("\x07");
}
