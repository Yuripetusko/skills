// Shared by agy-run.mjs and the agy hook scripts. Hooks find their job through AGY_DELEGATE_JOB, never
// through workspacePaths or their cwd: the --add-dir config dir comes first in one and is the other.
// The runner also sets AGY_DELEGATE_RUN (one id per execution), AGY_DELEGATE_STATE_SHA, and
// AGY_DELEGATE_GATE=1 when the job has a lint and type-check gate. agy's shell commands can write the
// job dir but cannot change the environment agy starts hooks with.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATE = 'state.json'
export const HOOK_LOG = 'hook.log'
export const CANARY = 'loaded'

// The stop gate. agy itself ignores the 11th consecutive continue, so the cap stays well below 10.
// The Stop hook checks once more after the last continue, so a job runs at most ROUND_CAP + 1 checks.
export const ROUND_CAP = 3
// The Stop hook's timeout in hooks.json. A whole-repo check took 147 s warm and about 370 s cold.
export const STOP_TIMEOUT_S = 600
// stop.mjs stops its gate check this long before agy would kill the hook, so the verdict says why.
export const GATE_DEADLINE_S = STOP_TIMEOUT_S - 30

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// `jobs.mjs gate`, or for tests a script that takes the same arguments (AGY_DELEGATE_GATE_BIN).
export const gateArgv = () => [process.execPath, process.env.AGY_DELEGATE_GATE_BIN || path.join(SCRIPTS, 'jobs.mjs'), 'gate']

// Runs `gate <args>` in its own process group with piped output. `done` resolves with
// {status, signal, stdout, stderr, timedOut, durationMs}; `stop()` ends the gate and the commands it
// started (its SIGTERM handler kills their groups).
export function runGate(args, { cwd, deadlineS }) {
  const [cmd, ...rest] = gateArgv()
  const started = Date.now()
  const child = spawn(cmd, [...rest, ...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 5000).unref()
  }
  const done = new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = deadlineS ? setTimeout(() => ((timedOut = true), stop()), deadlineS * 1000) : null
    child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', d => (stderr = (stderr + d).slice(-20000)))
    const end = extra => {
      clearTimeout(timer)
      resolve({ stdout, stderr, timedOut, durationMs: Date.now() - started, ...extra })
    }
    child.on('error', error => end({ status: null, signal: null, error: error.message }))
    child.on('close', (status, signal) => end({ status, signal }))
  })
  return { child, stop, done }
}

// The nested verifier run sets this; the implementer's hooks then stay out of its way.
export const isVerifier = () => process.env.AGY_DELEGATE_ROLE === 'verifier'

export function jobDir() {
  const dir = process.env.AGY_DELEGATE_JOB
  if (!dir) throw new Error('AGY_DELEGATE_JOB is not set')
  return dir
}

// Reads the result of `gate check --round <n>` (`r` from runGate) and its delta file: the verdict, the
// counts, and at most MAX_LINES lines of findings or error output to show agy or the report.
const MAX_LINES = 35
export function readCheck(dir, n, r) {
  let delta = null
  try {
    delta = JSON.parse(fs.readFileSync(path.join(dir, 'gate', `delta-${n}.json`), 'utf8'))
  } catch {}
  const counts = delta?.complete ? { added: delta.added.length, removed: delta.removed.length, outside: delta.outsideScope?.length ?? 0 } : {}
  const fields = { exit: r.status ?? r.signal ?? null, durationMs: r.durationMs, ...counts }
  const clip = lines => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `... and ${lines.length - MAX_LINES + 1} more`] : lines)
  if (r.status === 0) return { verdict: 'OK', fields, lines: [] }
  if (r.status === 1) {
    // From the delta file, or without one the gate's own text minus its verdict and Details lines.
    const lines = delta?.complete
      ? [
          ...delta.added.map(f => `+ ${f.rule}  ${f.file ?? '(no file)'}${f.line ? `:${f.line}:${f.column}` : ''}  ${String(f.message).split('\n')[0]}`),
          ...(delta.outsideScope ?? []).map(o => `changed outside the baseline scope: ${o.file} (${o.reason})`),
        ]
      : r.stdout.trim().split('\n').slice(1).filter(l => l.trim() && !l.startsWith('Details: '))
    return { verdict: 'FAILED', fields, lines: clip(lines) }
  }
  const why = r.timedOut
    ? `gate check timed out after ${GATE_DEADLINE_S}s`
    : r.error
      ? `gate check could not start: ${r.error}`
      : `gate check exited ${r.status ?? r.signal}`
  const out = (r.stdout.trim() || r.stderr.trim()).split('\n').filter(Boolean)
  return { verdict: 'error', fields, lines: out.slice(0, MAX_LINES), reason: `${why}${out[0] ? `: ${out[0]}` : ''}` }
}

export const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8'))
// Through a rename, so pre-tool.mjs never reads a half-written file and denies the call.
export function writeState(dir, state) {
  const file = path.join(dir, STATE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

// Covers only the fields the deny rules read, so later hooks may add their own fields to state.json.
export const stateHash = s =>
  createHash('sha256')
    .update(JSON.stringify([s.job, s.worktree, s.mode, Boolean(s.readOnly), s.paths ?? []]))
    .digest('hex')

export const logLine = (dir, entry) =>
  fs.appendFileSync(
    path.join(dir, HOOK_LOG),
    `${JSON.stringify({ at: new Date().toISOString(), run: process.env.AGY_DELEGATE_RUN, ...entry })}\n`,
  )

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
