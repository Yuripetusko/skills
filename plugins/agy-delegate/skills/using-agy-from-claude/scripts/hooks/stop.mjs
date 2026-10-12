#!/usr/bin/env node
// agy Stop hook: runs the lint and type-check gate (`jobs.mjs gate check`) each time agy wants to stop.
// While the change adds findings it answers continue with them, up to ROUND_CAP times. After that it
// lets agy stop with the verdict FAILED, and agy-run.mjs exits 17. agy also lets a stop through when
// this hook crashes, prints anything else or times out, so each round records the verdict `error` in
// state.json first and replaces it only with a real result.
// stdout carries the decision JSON and nothing else: the gate's output is piped.

import fs from 'node:fs'
import path from 'node:path'
import { GATE_DEADLINE_S, isVerifier, jobDir, logLine, readState, readStdin, ROUND_CAP, runGate, stateHash, writeState } from './job.mjs'

// agy stops on any decision other than "continue".
const STOP = JSON.stringify({ decision: 'stop' })
const MAX_LINES = 35

const tryJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The added findings and the files outside the baseline scope, from the delta file. Without one, the
// gate's own text minus its verdict and Details lines.
function findingLines(delta, stdout) {
  const lines = delta?.complete
    ? [
        ...delta.added.map(f => `+ ${f.rule}  ${f.file ?? '(no file)'}${f.line ? `:${f.line}:${f.column}` : ''}  ${String(f.message).split('\n')[0]}`),
        ...(delta.outsideScope ?? []).map(o => `changed outside the baseline scope: ${o.file} (${o.reason})`),
      ]
    : stdout.trim().split('\n').slice(1).filter(l => l.trim() && !l.startsWith('Details: '))
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `... and ${lines.length - MAX_LINES + 1} more`] : lines
}

const continueReason = (lines, attempt) =>
  [
    `Lint and type-check found problems your change added. Fix them before you finish. This is round ${attempt} of ${ROUND_CAP}, and after round ${ROUND_CAP} the job fails with them listed.`,
    ...lines,
    'Fix these without suppressing them: disable comments and casts count as findings.',
    ...(lines.some(l => l.includes('outside the baseline scope')) ? ['Undo your changes to the files listed as outside the baseline scope.'] : []),
    'Then end with your report as before.',
  ].join('\n')

async function round(raw) {
  const dir = jobDir()
  const run = process.env.AGY_DELEGATE_RUN ?? null
  const state = readState(dir)
  const n = (state.gate?.round ?? 0) + 1
  // Reads state.json again before each write, so the runner's and the earlier rounds' fields stay.
  const save = patch => {
    const s = readState(dir)
    s.gate = { ...s.gate, ...patch, run }
    writeState(dir, s)
  }
  let input = {}
  try {
    input = JSON.parse(raw || '{}')
  } catch {}
  // agy also stops mid-job, for example at a `wait` step while its own commands run (terminationReason
  // TERMINAL_STEP_TYPE in agy 1.3.3). A check then races those commands and could spend a round on
  // half-done work, so it waits for a stop with nothing running. The verdict drops to error until
  // then, so a job that ends here fails.
  if (input.fullyIdle === false) {
    save({ verdict: 'error', reason: 'agy stopped with work still running, and no check ran after that' })
    logLine(dir, { hook: 'Stop', decision: 'stop', skipped: 'not idle', terminationReason: input.terminationReason ?? null })
    return STOP
  }
  save({ round: n, verdict: 'error', reason: `the Stop hook did not finish round ${n}` })
  const entry = { round: n, executionNum: input.executionNum ?? null, terminationReason: input.terminationReason ?? null, fullyIdle: input.fullyIdle ?? null }
  const finish = (verdict, action, fields, patch = {}) => {
    const h = { ...entry, verdict, action, ...fields }
    save({ verdict, history: [...(readState(dir).gate?.history ?? []), h], ...patch })
    logLine(dir, { hook: 'Stop', decision: action, round: n, verdict, exit: h.exit ?? null, added: h.added ?? null })
  }
  if (stateHash(state) !== process.env.AGY_DELEGATE_STATE_SHA) {
    finish('error', 'stop', { lines: [] }, { reason: 'state.json changed during the run' })
    return STOP
  }
  if (String(input.terminationReason).toLowerCase() === 'error') {
    const error = String(input.error ?? '').split('\n')[0]
    finish('error', 'stop', { lines: error ? [error] : [] }, { reason: `agy stopped on an error, so the gate did not run${error ? `: ${error}` : ''}` })
    return STOP
  }

  const r = await runGate(['check', '--job', dir, '--round', String(n)], { cwd: state.worktree, deadlineS: GATE_DEADLINE_S }).done
  const delta = tryJson(path.join(dir, 'gate', `delta-${n}.json`))
  const counts = delta?.complete ? { added: delta.added.length, removed: delta.removed.length, outside: delta.outsideScope?.length ?? 0 } : {}
  const fields = { exit: r.status ?? r.signal ?? null, durationMs: r.durationMs, ...counts }
  if (r.status === 0) {
    // The verifier (agy-verifier-ticket.md) runs here, once the gate is clean.
    finish('OK', 'stop', fields, { reason: null })
    return STOP
  }
  if (r.status === 1) {
    const lines = findingLines(delta, r.stdout)
    const continues = state.gate?.continues ?? 0
    if (continues < ROUND_CAP) {
      finish('FAILED', 'continue', { ...fields, lines }, { continues: continues + 1, reason: null })
      return JSON.stringify({ decision: 'continue', reason: continueReason(lines, continues + 1) })
    }
    finish('FAILED', 'stop', { ...fields, lines }, { reason: `the change still adds findings after ${ROUND_CAP} rounds` })
    return STOP
  }
  const why = r.timedOut
    ? `gate check timed out after ${GATE_DEADLINE_S}s`
    : r.error
      ? `gate check could not start: ${r.error}`
      : `gate check exited ${r.status ?? r.signal}`
  const out = (r.stdout.trim() || r.stderr.trim()).split('\n').filter(Boolean)
  finish('error', 'stop', { ...fields, lines: out.slice(0, MAX_LINES) }, { reason: `${why}${out[0] ? `: ${out[0]}` : ''}` })
  return STOP
}

const raw = await readStdin()
let answer = STOP
try {
  if (!isVerifier() && process.env.AGY_DELEGATE_GATE === '1') answer = await round(raw)
} catch (error) {
  process.stderr.write(`stop: ${error.stack ?? error.message}\n`)
  try {
    logLine(jobDir(), { hook: 'Stop', decision: 'stop', verdict: 'error', error: error.message })
  } catch {}
}
console.log(answer)
