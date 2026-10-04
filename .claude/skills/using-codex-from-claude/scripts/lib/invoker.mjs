import process from 'node:process'

// Subagents inherit the parent's CLAUDE_CODE_SESSION_ID and CLAUDE_PID, so an agent that runs Codex
// concurrently with its siblings names itself with --invoker / CODEX_INVOKER to get its own broker.
export const INVOKER_ENV = 'CODEX_INVOKER'
const SESSION_ID_ENVS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_COMPANION_SESSION_ID']
const OWNER_PID_ENV = 'CLAUDE_PID'

function sanitizeKeyPart(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function resolveSessionId(env = process.env) {
  for (const name of SESSION_ID_ENVS) {
    if (env?.[name]) {
      return env[name]
    }
  }
  return null
}

export function resolveOwnerPid(env = process.env) {
  const pid = Number.parseInt(env?.[OWNER_PID_ENV] ?? '', 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function resolveInvokerKey(env = process.env) {
  const invoker = sanitizeKeyPart(env?.[INVOKER_ENV] ?? '')
  if (invoker) {
    return `invoker-${invoker}`
  }
  const sessionId = resolveSessionId(env)
  if (sessionId) {
    return `session-${sanitizeKeyPart(sessionId)}`
  }
  return `shell-${process.ppid}`
}
