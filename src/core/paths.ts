// Captures the directory Flows was launched from, once, at startup — the
// default working directory for any step that doesn't set its own. Reading
// process.cwd() lazily inside the engine would (today) return the same
// value, since nothing in this app chdir()s, but capturing it explicitly at
// import time makes that guarantee obvious rather than incidental, and gives
// the UI a concrete path to display instead of the vague "(cwd)" it showed
// before.
export const LAUNCH_DIR = process.cwd();

/** A step's effective working directory: its own override, or LAUNCH_DIR. */
export function resolveWorkingDir(workingDir: string | undefined): string {
  return workingDir || LAUNCH_DIR;
}
