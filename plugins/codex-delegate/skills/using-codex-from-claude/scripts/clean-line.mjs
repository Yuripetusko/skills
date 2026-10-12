// cleanLine, shared by jobs.mjs and the agy hooks. It imports nothing, so a hook that needs it never
// depends on jobs.mjs loading. The same file sits in both delegate skills' scripts/ folders; keep the
// two copies identical.

// A progress line can carry text from outside the hooks: a command's first output line, agy's stderr, an
// error message. It reaches terminals and an orchestrator's Monitor stream, so escape sequences (CSI,
// OSC and the other two-character ones) and control characters, including the C1 range, line and
// paragraph separators and the bidi and zero-width marks, are dropped, then runs of white space shrink.
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]*[0-~])/g
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g
export const cleanLine = (text, max = 240) =>
  String(text).replace(ESCAPES, ' ').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
