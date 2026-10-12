// The verifier: a nested headless agy run, read-only, that checks the job's change against
// prompts/verifier-checklist.md and the repo's AGENTS.md files and returns {verdict, findings}.
// stop.mjs runs it after a clean gate check, and agy-run.mjs when it checks the final tree itself.
// It runs as the `delegate-verifier` agent from $JOB/agy-verifier/, never from $JOB/agy/, so the
// implementer's Stop hook can't fire inside it.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiff } from '../diff.mjs'
import { snapshotTree } from '../gate.mjs'
import { GATE_DEADLINE_S, readCheck, runGate, VERIFIER_DEADLINE_S, VERIFIER_PRINT_S } from './job.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const VERIFIER_AGENT = 'delegate-verifier'
// model-trial-ticket.md sets the default. AGY_DELEGATE_VERIFIER_MODEL overrides it.
export const VERIFIER_MODEL = 'gemini-3.8-flash-medium'
// `finish` carries the --json-schema result. Without it in the list, agy 1.3.3 returned no
// structured_output and the run took three times as long.
export const VERIFIER_TOOLS = ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'finish']
export const SCHEMA = path.join(SKILL_DIR, 'prompts', 'agents', `${VERIFIER_AGENT}.schema.json`)
const CHECKLIST = path.join(SKILL_DIR, 'prompts', 'verifier-checklist.md')
// At most this many lines of findings go back to agy or into the report.
const MAX_LINES = 35

const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`
const tryJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// $JOB/agy-verifier/: the agent and a PreToolUse hook. pre-tool.mjs in the verifier role blocks every
// write and every read outside the worktree, the input dir and this config dir. No Stop hook.
export function writeVerifierConfig(dir, { model, worktree }) {
  const cfg = path.join(dir, 'agy-verifier')
  fs.rmSync(cfg, { recursive: true, force: true })
  fs.mkdirSync(path.join(cfg, '.agents', 'agents'), { recursive: true })
  const preTool = `${shellQuote(process.execPath)} ${shellQuote(path.join(SKILL_DIR, 'scripts', 'hooks', 'pre-tool.mjs'))}`
  const hooks = { 'agy-delegate-verifier': { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: preTool, timeout: 30 }] }] } }
  fs.writeFileSync(path.join(cfg, '.agents', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`)
  const vars = {
    job: path.basename(dir),
    model,
    tools: VERIFIER_TOOLS.join(', '),
    worktree,
  }
  const template = fs.readFileSync(path.join(SKILL_DIR, 'prompts', 'agents', `${VERIFIER_AGENT}.md`), 'utf8')
  const agent = template.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m)
  fs.writeFileSync(path.join(cfg, '.agents', 'agents', `${VERIFIER_AGENT}.md`), agent)
  return cfg
}

// $JOB/verifier/input-<n>/: the four `delegate-jobs diff` files for the job's change since it started,
// the brief and the checklist. The checklist is a file here rather than an agy skill: on the same
// planted diff both caught 4 of 4, and the file runs took 83-87 s against 90-118 s.
export function prepareInputs(dir, worktree, n) {
  const input = path.join(dir, 'verifier', `input-${n}`)
  fs.rmSync(input, { recursive: true, force: true })
  fs.mkdirSync(input, { recursive: true })
  const meta = tryJson(path.join(dir, 'meta.json')) ?? {}
  const diff = runDiff({ cwd: worktree, out: input, jobBase: meta.head })
  fs.copyFileSync(path.join(dir, 'brief.md'), path.join(input, 'brief.md'))
  fs.copyFileSync(CHECKLIST, path.join(input, 'checklist.md'))
  return { input, diff }
}

function briefFor(worktree, input, diff) {
  const { totals, rules } = diff
  return [
    `Check the change in ${worktree}. Your input dir is ${input}.`,
    `The change touches ${totals.files} file(s), +${totals.additions} -${totals.deletions}.${totals.generated ? ` ${totals.generated} of them are generated or lock files with no hunks in diff-numbered.txt.` : ''}`,
    rules.length ? 'AGENTS.md files to read, relative to the worktree:' : 'No AGENTS.md applies.',
    ...rules.map(r => `- ${r.path} (${r.bytes} bytes${r.over24kb ? ', over 24,000: view it in parts' : ''})`),
  ].join('\n')
}

// The result must match the schema, and a FAIL must carry findings. Returns the problem or null.
export function invalidResult(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return 'no structured result'
  if (!['PASS', 'FAIL'].includes(out.verdict)) return `verdict is ${JSON.stringify(out.verdict)}, not PASS or FAIL`
  if (!Array.isArray(out.findings)) return 'findings is not a list'
  for (const [i, f] of out.findings.entries()) {
    const bad = ['file', 'rule', 'why', 'fix'].filter(k => typeof f?.[k] !== 'string')
    if (!Number.isInteger(f?.line)) bad.push('line')
    if (bad.length) return `finding ${i + 1} lacks ${bad.join(', ')}`
  }
  if (out.verdict === 'FAIL' && !out.findings.length) return 'FAIL with no findings'
  return null
}

const real = p => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

// Runs the verifier for round `n` and writes $JOB/verifier/result-<n>.json. `run` and `stateSha` are the
// execution's AGY_DELEGATE_RUN and AGY_DELEGATE_STATE_SHA, which its hook needs to allow any call; the
// runner's own process doesn't have them in its environment. `ctl.stop` is set while the nested agy
// runs, so a caller's signal handler can end it. `say(text)` reports the start (model, pid) for
// `delegate-jobs tail`. Every outcome other than a valid PASS or FAIL from a
// run that exited 0 is a FAIL with `noVerdict: true` and the reason, never a PASS.
export async function runVerifier({
  dir,
  worktree,
  n,
  agy,
  model,
  run,
  stateSha,
  deadlineS = Number(process.env.AGY_DELEGATE_VERIFIER_DEADLINE_S) || VERIFIER_DEADLINE_S,
  ctl = {},
  say = () => {},
}) {
  const started = Date.now()
  const vdir = path.join(dir, 'verifier')
  fs.mkdirSync(vdir, { recursive: true })
  const base = { round: n, model, verdict: 'FAIL', findings: [], noVerdict: true, reason: null }
  const save = fields => {
    const result = { ...base, ...fields, durationMs: Date.now() - started }
    fs.writeFileSync(path.join(vdir, `result-${n}.json`), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  // Recorded first and replaced only by a real verdict, so a killed hook leaves a FAIL behind.
  save({ reason: 'the verifier did not finish' })
  let input
  let diff
  let treeBefore
  try {
    treeBefore = snapshotTree(worktree, vdir)
    ;({ input, diff } = prepareInputs(dir, worktree, n))
  } catch (error) {
    return save({ reason: `the verifier's inputs could not be prepared: ${error.message}` })
  }
  if (!diff.totals.files) return save({ verdict: 'PASS', noVerdict: false, reason: 'the change is empty, so there was nothing to check', input, treeBefore })
  if (!agy) return save({ reason: 'no agy binary was passed to the verifier', input })

  const message = path.join(vdir, `input-${n}.jsonl`)
  fs.writeFileSync(message, `${JSON.stringify({ event: 'user', message: { role: 'user', content: briefFor(worktree, input, diff) } })}\n`)
  const events = path.join(vdir, `events-${n}.jsonl`)
  const stderr = path.join(vdir, `stderr-${n}.log`)
  const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model]
  args.push('--add-dir', path.join(dir, 'agy-verifier'), '--agent', VERIFIER_AGENT, '--json-schema', SCHEMA)
  args.push('--dangerously-skip-permissions', '--print-timeout', `${VERIFIER_PRINT_S}s`)
  let timedOut = false
  const outcome = await new Promise(resolve => {
    const child = spawn(agy, args, {
      cwd: worktree, // never the hook's cwd, which holds the implementer's hooks.json
      detached: true,
      env: {
        ...process.env,
        AGY_DELEGATE_JOB: dir,
        AGY_DELEGATE_RUN: run ?? '',
        AGY_DELEGATE_STATE_SHA: stateSha ?? '',
        AGY_DELEGATE_ROLE: 'verifier',
        AGY_DELEGATE_VERIFIER_INPUT: input,
      },
      stdio: [fs.openSync(message, 'r'), fs.openSync(events, 'w'), fs.openSync(stderr, 'w')],
    })
    say(`verifier started: ${model}, pid ${child.pid}, stopped after ${deadlineS}s`)
    const kill = sig => {
      try {
        process.kill(-child.pid, sig)
      } catch {}
    }
    ctl.stop = () => {
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 5000).unref()
    }
    const timer = setTimeout(() => ((timedOut = true), ctl.stop()), deadlineS * 1000)
    child.on('error', error => (clearTimeout(timer), resolve({ error: error.message })))
    child.on('exit', (code, signal) => (clearTimeout(timer), resolve({ code, signal })))
  })
  ctl.stop = null

  let treeAfter = null
  try {
    treeAfter = snapshotTree(worktree, vdir)
  } catch {}
  const lines = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n') : []
  const parsed = lines.flatMap(l => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
  const init = parsed.find(e => e.event === 'init')?.init
  const result = parsed.findLast(e => e.event === 'result')?.result
  const errText = fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8') : ''
  const info = {
    input,
    treeBefore,
    treeAfter,
    conversationId: result?.conversation_id ?? null,
    usage: result?.usage ?? null,
    tools: parsed.filter(e => e.step_update?.step_type === 'tool' && e.step_update.state !== 'ACTIVE').length,
  }
  const fail = reason => save({ ...info, reason })
  if (timedOut) return save({ ...info, timedOut: true, reason: `the verifier ran past ${deadlineS}s and was stopped` })
  if (outcome.error) return fail(`agy could not start: ${outcome.error}`)
  // A result streamed before a crash or a kill doesn't count.
  if (outcome.code !== 0 || outcome.signal)
    return fail(`the verifier exited ${outcome.signal ?? outcome.code} ${result ? 'after streaming a result' : 'without a result'}: ${errText.trim().split('\n').at(-1) || 'no detail'}`)
  if (treeAfter !== treeBefore) return fail('the worktree changed while the verifier ran')
  if (init && real(init.cwd) !== real(worktree)) return fail(`the verifier bound to ${init.cwd}, not the worktree`)
  if (/print timeout after/i.test(errText)) return save({ ...info, timedOut: true, reason: `the verifier hit its --print-timeout of ${VERIFIER_PRINT_S}s` })
  if (!result) return fail(`the verifier ended without a result (exit ${outcome.code ?? outcome.signal}): ${errText.trim().split('\n').at(-1) || 'no detail'}`)
  if (result.status !== 'SUCCESS' || result.error) return fail(`the verifier run failed: ${result.error || result.status}`)
  const problem = invalidResult(result.structured_output)
  if (problem) return fail(`the verifier produced no valid verdict: ${problem}`)
  const { verdict, findings } = result.structured_output
  // A PASS that lists findings counts as a FAIL: the findings are concrete.
  return save({ ...info, verdict: findings.length ? 'FAIL' : verdict, findings, noVerdict: false, reason: verdict === 'PASS' && findings.length ? 'PASS with findings counts as FAIL' : null })
}

// One line per finding, clipped to MAX_LINES.
export function findingLines(v) {
  const lines = v.noVerdict
    ? [`- verifier produced no verdict: ${v.reason}`]
    : v.findings.map(f => `- ${f.file}:${f.line} [${f.rule}] ${String(f.why).replace(/\s+/g, ' ')} Fix: ${String(f.fix).replace(/\s+/g, ' ')}`)
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `... and ${lines.length - MAX_LINES + 1} more`] : lines
}

// The tree a round's verdict covers. A verifier run that changed the worktree fails, and that failure
// covers the tree it left, so the runner can't pass the job on a fresh check of that tree.
export const coveredTree = (c, tree) => (c.verifier?.treeAfter && c.verifier.treeAfter !== c.verifier.treeBefore ? c.verifier.treeAfter : tree)

// What the round history keeps of a verifier run.
export const verifierSummary = v => ({
  verdict: v.verdict,
  findings: v.findings.length,
  noVerdict: v.noVerdict,
  reason: v.reason,
  model: v.model,
  durationMs: v.durationMs,
  tools: v.tools ?? 0,
})

// The progress lines `delegate-jobs tail` shows for a gate check and a verifier run.
const secs = ms => `${Math.round((ms ?? 0) / 1000)}s`
const clip = (text, n = 140) => (String(text).length > n ? `${String(text).slice(0, n - 3)}...` : String(text))
export function gateLine(c) {
  const f = c.fields
  if (c.verdict === 'error') return `lint and type-check could not finish after ${secs(f.durationMs)}: ${clip(c.reason ?? 'no detail')}`
  const counts = f.added == null ? '' : `, ${f.added} added, ${f.removed} removed${f.outside ? `, ${f.outside} file(s) outside the baseline scope` : ''}`
  return `lint and type-check ${c.verdict}${counts} (${secs(f.durationMs)})`
}
export function verifierLine(v) {
  if (v.timedOut) return `verifier timed out after ${secs(v.durationMs)}, so no verdict`
  if (v.noVerdict) return `verifier gave no verdict after ${secs(v.durationMs)}: ${clip(v.reason ?? 'no detail')}`
  return `verifier ${v.verdict}${v.findings.length ? `, ${v.findings.length} finding(s)` : ''} (${secs(v.durationMs)})${v.reason ? `: ${clip(v.reason)}` : ''}`
}

// One round: the gate check, then the verifier when the gate is clean. Returns the round verdict
// (OK only for a clean gate and a verifier PASS), the gate's fields, the lines to show, and the verifier
// result. `ctl.stop` ends whichever child runs, for the caller's signal handler. `say(text)` writes the
// round's progress lines for `delegate-jobs tail`: each start and each result.
export async function checkRound({ dir, worktree, n, verifier, ctl = {}, say = () => {} }) {
  say(`lint and type-check started (stopped after ${GATE_DEADLINE_S}s)`)
  const gate = runGate(['check', '--job', dir, '--round', String(n)], { cwd: worktree, deadlineS: GATE_DEADLINE_S })
  ctl.stop = gate.stop
  const r = await gate.done
  ctl.stop = null
  const c = readCheck(dir, n, r)
  say(gateLine(c))
  if (c.verdict !== 'OK') return { ...c, verifier: null }
  const v = await runVerifier({ dir, worktree, n, ...verifier, ctl, say })
  say(verifierLine(v))
  const lines = findingLines(v)
  if (v.verdict === 'PASS') return { verdict: 'OK', fields: c.fields, lines: [], verifier: v }
  const reason = v.noVerdict ? `the verifier produced no verdict: ${v.reason}` : `the verifier found ${v.findings.length} problem(s)`
  return { verdict: 'FAILED', fields: c.fields, lines, verifier: v, reason }
}
