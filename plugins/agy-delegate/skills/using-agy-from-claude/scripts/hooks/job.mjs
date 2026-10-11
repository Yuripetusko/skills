// Shared by agy-run.mjs and the agy hook scripts. Hooks find their job through AGY_DELEGATE_JOB, never
// through workspacePaths or their cwd: the --add-dir config dir comes first in one and is the other.

import fs from 'node:fs'
import path from 'node:path'

export const STATE = 'state.json'
export const HOOK_LOG = 'hook.log'
export const CANARY = 'loaded'

// The nested verifier run sets this; the implementer's hooks then stay out of its way.
export const isVerifier = () => process.env.AGY_DELEGATE_ROLE === 'verifier'

export function jobDir() {
  const dir = process.env.AGY_DELEGATE_JOB
  if (!dir) throw new Error('AGY_DELEGATE_JOB is not set')
  return dir
}

export const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8'))

export const logLine = (dir, entry) =>
  fs.appendFileSync(path.join(dir, HOOK_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)

export function readHookLog(dir) {
  const file = path.join(dir, HOOK_LOG)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

export function readStdin() {
  return new Promise(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (text += chunk))
    process.stdin.on('end', () => resolve(text))
  })
}
