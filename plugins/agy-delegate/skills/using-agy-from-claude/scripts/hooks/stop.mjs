#!/usr/bin/env node
// agy Stop hook: runs the lint and type-check gate (`jobs.mjs gate check`) each time agy wants to stop,
// and the verifier (verifier.mjs) once the gate is clean. While either finds problems it answers
// continue with them, up to ROUND_CAP times per job. After that it lets agy stop with the verdict
// FAILED. A verifier that gives no verdict also fails the job, with no continue: agy can't fix that.
// Each check records the git tree it checked, and
// agy-run.mjs takes a verdict only for the tree agy left: agy also stops when this hook crashes, prints
// anything else or times out, so a later edit may have no check. The runner then checks once itself.
// stdout carries the decision JSON and nothing else: the gate's output is piped.

import path from 'node:path'
import { snapshotTree } from '../gate.mjs'
import { isVerifier, jobDir, logLine, progress, readState, readStdin, ROUND_CAP, stateHash, writeState } from './job.mjs'
import { checkRound, coveredTree, VERIFIER_MODEL, verifierSummary } from './verifier.mjs'

// agy stops on any decision other than "continue".
const STOP = JSON.stringify({ decision: 'stop' })

const continueReason = (lines, attempt) =>
  [
    `Lint and type-check found problems your change added. Fix them before you finish. This is round ${attempt} of ${ROUND_CAP}, and after round ${ROUND_CAP} the job fails with them listed.`,
    ...lines,
    'Fix these without suppressing them: disable comments and casts count as findings.',
    ...(lines.some(l => l.includes('outside the baseline scope')) ? ['Undo your changes to the files listed as outside the baseline scope.'] : []),
    'Then end with your report as before.',
  ].join('\n')

const verifierReason = (lines, attempt) =>
  [
    `An independent check of your change found problems. Fix them before you finish. This is round ${attempt} of ${ROUND_CAP}, and after round ${ROUND_CAP} the job fails with them listed.`,
    ...lines,
    'Fix the cause in the code without changing what it does at runtime. A disable comment, a ts-ignore, or a cast whose SAFETY: comment the code does not back fixes nothing.',
    'If a finding is wrong, leave that code as it is and say why in your report.',
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
  // half-done work, so it waits for a stop with nothing running.
  if (input.fullyIdle === false) {
    save({ verdict: 'error', reason: 'agy stopped with work still running, and no check ran after that' })
    logLine(dir, { hook: 'Stop', decision: 'stop', skipped: 'not idle', terminationReason: input.terminationReason ?? null })
    progress(dir, 'gate: agy stopped with work still running, so no check this time')
    return STOP
  }
  save({ round: n, verdict: 'error', reason: `the Stop hook did not finish round ${n}` })
  const entry = { run, round: n, executionNum: input.executionNum ?? null, terminationReason: input.terminationReason ?? null, fullyIdle: input.fullyIdle ?? null }
  const say = text => progress(dir, `gate round ${n}: ${text}`)
  const finish = (verdict, action, fields, patch = {}) => {
    const h = { ...entry, verdict, action, ...fields }
    save({ verdict, history: [...(readState(dir).gate?.history ?? []), h], ...patch })
    logLine(dir, { hook: 'Stop', decision: action, round: n, verdict, exit: h.exit ?? null, added: h.added ?? null, verifier: h.verifier?.verdict ?? null })
    say(
      action === 'continue'
        ? `sent back to agy (${patch.continues} of ${ROUND_CAP})`
        : verdict === 'OK'
          ? 'OK, agy may stop'
          : `${verdict}, stop allowed${patch.reason ? `: ${patch.reason}` : ''}`,
    )
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

  // The tree the check starts from. A check that later reads edited files no longer matches the tree
  // agy leaves, so the runner checks again.
  const tree = snapshotTree(state.worktree, path.join(dir, 'gate'))
  const env = process.env
  const verifier = { agy: env.AGY_DELEGATE_AGY, model: env.AGY_DELEGATE_VERIFIER_MODEL || VERIFIER_MODEL, run, stateSha: env.AGY_DELEGATE_STATE_SHA }
  const c = await checkRound({ dir, worktree: state.worktree, n, verifier, say })
  const fields = { tree: coveredTree(c, tree), ...c.fields, ...(c.verifier ? { verifier: verifierSummary(c.verifier) } : {}), ...(c.lines.length ? { lines: c.lines } : {}) }
  if (c.verdict === 'OK') {
    finish('OK', 'stop', fields, { reason: null })
    return STOP
  }
  if (c.verdict === 'FAILED') {
    if (c.verifier?.noVerdict) {
      finish('FAILED', 'stop', fields, { reason: c.reason })
      return STOP
    }
    const continues = state.gate?.continues ?? 0
    if (continues < ROUND_CAP) {
      finish('FAILED', 'continue', fields, { continues: continues + 1, reason: null })
      const reason = (c.verifier ? verifierReason : continueReason)(c.lines, continues + 1)
      return JSON.stringify({ decision: 'continue', reason })
    }
    const why = c.verifier ? `the verifier still finds problems after ${ROUND_CAP} rounds` : `the change still adds findings after ${ROUND_CAP} rounds`
    finish('FAILED', 'stop', fields, { reason: why })
    return STOP
  }
  finish('error', 'stop', { ...c.fields, lines: c.lines }, { reason: c.reason })
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
    progress(jobDir(), `gate: the Stop hook crashed, stop allowed: ${error.message}`)
  } catch {}
}
console.log(answer)
