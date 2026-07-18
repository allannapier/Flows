// Tiny module-level flag tracking whether the run screen is currently
// attached to a live agent PTY. Used by App.tsx's global ctrl+c handler to
// decide whether ctrl+c should quit Flows or be forwarded to the agent
// (RunScreen forwards it directly while attached; App must not also quit).

let attached = false;

export const setAttached = (v: boolean) => {
  attached = v;
};

export const isAttached = () => attached;
