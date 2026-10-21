// The stop gate end to end: agy-run.mjs against fixtures/fake-agy.mjs, with the real hooks and either
// fixtures/fake-gate.mjs or the real `jobs.mjs gate` on a fake lint tool.
// Run: node --test 'scripts/test/*.test.mjs'

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GATE_DEADLINE_S,
  HOOK_RESERVE_S,
  progress,
  ROUND_BUDGET_S,
  ROUND_CAP,
  runTimeouts,
  stateHash,
  STOP_TIMEOUT_S,
  VERIFIER_DEADLINE_S,
  VERIFIER_KILL_GRACE_S,
  VERIFIER_KILL_MARGIN_S,
  VERIFIER_MIN_PRINT_S,
  verifierTimes,
  writeState,
} from '../hooks/job.mjs'
import { runVerifier, writeVerifierConfig } from '../hooks/verifier.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, '..', 'agy-run.mjs')
const STOP = path.join(HERE, '..', 'hooks', 'stop.mjs')
const FAKE_AGY = path.join(HERE, 'fixtures', 'fake-agy.mjs')
const FAKE_GATE = path.join(HERE, 'fixtures', 'fake-gate.mjs')
fs.chmodSync(FAKE_AGY, 0o755)

// A scratch repo whose unit is `pkg/`, and a job whose brief allows pkg/src/**.
function setup({ calls = [], rounds = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-')))
  const repo = path.join(root, 'repo')
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
  }
  put('pkg/package.json', '{"name": "pkg", "scripts": {"lint": "oxlint"}}\n')
  put('pkg/src/a.ts', 'export const a = 1\n')
  const git = args => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo })
  git(['init', '-q'])
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  const job = path.join(root, 'jobs', 'agy-test')
  fs.mkdirSync(job, { recursive: true })
  fs.writeFileSync(path.join(job, 'brief.md'), 'paths: pkg/src/**\n\nTighten the return type in pkg/src/b.ts.\n')
  fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ id: 'agy-test', tool: 'agy', cwd: repo, toplevel: repo }))
  const file = (name, data) => {
    fs.writeFileSync(path.join(root, name), JSON.stringify(data))
    return path.join(root, name)
  }
  const write = (rel, text) => ({ name: 'write_to_file', args: { TargetFile: path.join(repo, rel), CodeContent: text } })
  const ctx = { root, repo, job, write }
  ctx.calls = file('calls.json', calls.map(([rel, text]) => write(rel, text)))
  ctx.rounds = file('rounds.json', rounds.map(list => list.map(([rel, text]) => write(rel, text))))
  return ctx
}

const runnerEnv = (ctx, env = {}) => ({
  ...process.env,
  AGY_BIN: FAKE_AGY,
  DELEGATE_JOBS_DIR: path.dirname(ctx.job),
  FAKE_CALLS_FILE: ctx.calls,
  FAKE_ROUNDS_FILE: ctx.rounds,
  FAKE_GATE_LOG: path.join(ctx.root, 'gate-calls.jsonl'),
  ...env,
})
const runnerArgs = (ctx, mode = 'implement', args = []) => [RUNNER, 'run', '--job-dir', ctx.job, '--mode', mode, '--model', 'gemini-3.8-flash-low', '--timeout', '2m', ...args]

function run(ctx, { mode = 'implement', args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, runnerArgs(ctx, mode, args), { cwd: ctx.repo, encoding: 'utf8', env: runnerEnv(ctx, env) })
  const read = name => (fs.existsSync(path.join(ctx.job, name)) ? fs.readFileSync(path.join(ctx.job, name), 'utf8') : '')
  const events = read('events.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return {
    status: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    report: read('report.md'),
    meta: JSON.parse(read('meta.json') || '{}'),
    state: JSON.parse(read('state.json') || '{}'),
    stops: events.filter(e => e.event === 'fake_stop_hook').map(e => e.answer),
    gateCalls: read('../../gate-calls.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)),
  }
}
const fake = checks => ({ env: { AGY_DELEGATE_GATE_BIN: FAKE_GATE, FAKE_GATE_CHECKS: checks } })

test('findings in rounds 1-3 and a clean 4th check: three continues, then exit 0 with gate OK', () => {
  const ctx = setup()
  const r = run(ctx, fake('1,1,1,0'))
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'continue', 'continue', 'stop'])
  assert.match(r.stops[0].reason, /\+ typescript\(no-explicit-any\) {2}src\/b\.ts:1:18 {2}Unexpected any/)
  assert.match(r.stops[0].reason, /This is round 1 of 3/)
  assert.match(r.stops[0].reason, /without suppressing them: disable comments and casts count as findings/)
  assert.ok(r.stops[0].reason.split('\n').length <= 40)
  assert.match(r.report, /^## Gates\n- GATE OK: 0 added, 0 removed · verifier PASS · 4 round\(s\), 3 sent back\n/)
  assert.equal((r.report.match(/sent back to agy/g) ?? []).length, 3)
  assert.match(r.report, /- round 4: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, stop allowed\n- round 4's check covers the tree agy left\n/)
  assert.equal(r.meta.gate.verifier.verdict, 'PASS')
  assert.deepEqual({ ...r.meta.gate, verifier: undefined }, { verdict: 'OK', added: 0, removed: 0, outside: 0, round: 4, rounds: 4, verifier: undefined })
  assert.deepEqual(
    r.gateCalls.map(a => a.slice(0, 1).concat(a.slice(3))),
    [['baseline'], ['check', '--round', '1'], ['check', '--round', '2'], ['check', '--round', '3'], ['check', '--round', '4']],
  )
  assert.deepEqual(r.state.gate.scope.units, ['src'])
})

test('findings in all four checks: the cap allows the stop, exit 17 lists what is still added', () => {
  const ctx = setup()
  const r = run(ctx, fake('1'))
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'continue', 'continue', 'stop'])
  assert.match(r.report, /^## Gates\n- GATE FAILED: 1 added, 0 removed · 4 round\(s\), 3 sent back\n/)
  assert.match(r.report, /- round 4: FAILED, 1 added, 0 removed, \d+s, stop allowed\n- round 4's check covers the tree agy left\n- still failing:\n {2}\+ typescript\(no-explicit-any\)/)
  assert.match(r.report, /- exit 17 \(gate\): gate FAILED after 3 round\(s\) sent back: 1 finding\(s\) added/)
  assert.equal(r.meta.gate.verdict, 'FAILED')
  assert.equal(r.meta.gate.rounds, 4)
  assert.match(r.meta.verdict, /^gate FAILED/)
  // The answer is kept: every round's text.
  assert.match(r.stdout, /Fake agy finished\.\nFake agy round 2\.\nFake agy round 3\.\nFake agy round 4\./)
})

test('a check that cannot run mid-job leaves the last result on the same tree, FAILED: exit 17', () => {
  const ctx = setup()
  const r = run(ctx, fake('1,2'))
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'stop'])
  assert.match(r.report, /- round 2: error, \d+s, stop allowed\n- round 1's check covers the tree agy left/)
  assert.equal(r.meta.gate.verdict, 'FAILED')
})

test('a Stop hook killed mid-check never reads as OK', () => {
  const ctx = setup()
  const r = run(ctx, fake('1,kill'))
  assert.equal(r.status, 17, r.report)
  assert.equal(r.stops.at(-1).failed, 'SIGKILL')
  assert.match(r.report, /^## Gates\n- GATE FAILED/)
  assert.equal(r.meta.gate.verdict, 'FAILED')
})

test('a Stop hook that times out: the runner stops the gate it left and checks the tree itself', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('hang,1').env, FAKE_HOOK_TIMEOUT_S: '2' } })
  assert.equal(r.status, 17, r.report)
  assert.match(r.report, /- round 2: FAILED, 1 added, 0 removed, \d+s, checked by the runner after agy exited/)
  assert.match(r.report, /stopped processes agy left running: /)
  const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout
  assert.ok(!ps.includes(`--job ${ctx.job}`), 'the hung gate check still runs')
})

test('a run whose Stop hook never fires gets one check from the runner', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('1').env, FAKE_STOP_HOOK: '0' } })
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.gateCalls.map(a => a[0]), ['baseline', 'check'])
  assert.match(r.report, /- the runner checked the tree agy left in round 1/)
})

test('a rerun keeps the baseline and the rounds; an earlier OK is not reused', () => {
  const ctx = setup()
  assert.equal(run(ctx, fake('0')).status, 0)
  const baseline = fs.readFileSync(path.join(ctx.job, 'gate', 'baseline.json'), 'utf8')
  // A rerun in the same job dir whose Stop hook never fires.
  const r = run(ctx, { env: { ...fake('0').env, FAKE_STOP_HOOK: '0' } })
  assert.equal(r.status, 0, r.report)
  assert.equal(fs.readFileSync(path.join(ctx.job, 'gate', 'baseline.json'), 'utf8'), baseline)
  assert.deepEqual(r.gateCalls.map(a => a[0]), ['baseline', 'check', 'check'])
  assert.match(r.report, /- baseline: GATE BASELINE: 0 finding\(s\), kept from an earlier execution of this job/)
  assert.match(r.report, /- round 1: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, stop allowed \(earlier execution\)\n- round 2: OK, .*verifier PASS in \d+s, checked by the runner/)
})

test('a Stop while agy still has work running runs no check and spends no round', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('1,0').env, FAKE_BUSY_STOP: 'mid' } })
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['stop', 'continue', 'stop'])
  assert.deepEqual(r.gateCalls.map(a => a[0]), ['baseline', 'check', 'check'])
  assert.match(r.report, /- round 1: FAILED, 1 added, 0 removed, \d+s, sent back to agy\n- round 2: OK/)
  assert.equal(r.state.gate.history[0].fullyIdle, true)
})

test('a run that ends at a Stop with work still running gets one check from the runner', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('1').env, FAKE_BUSY_STOP: 'last' } })
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.gateCalls.map(a => a[0]), ['baseline', 'check'])
  assert.match(r.report, /- round 1: FAILED, .*checked by the runner after agy exited/)
})

test('a baseline that cannot run exits 18 before agy starts, with the gate output in report.md', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('0').env, FAKE_GATE_BASELINE: '2' } })
  assert.equal(r.status, 18, r.stderr)
  assert.match(r.report, /^## Gates\n- GATE ERROR: the baseline could not run\n- gate output:\n {2}GATE ERROR: the baseline could not run/)
  assert.match(r.report, /- exit 18 \(setup\): gate baseline exited 2, so agy did not start/)
  assert.ok(!fs.existsSync(path.join(ctx.job, 'events.jsonl')))
  assert.equal(r.meta.gate.verdict, 'error')
})

test('without a gate config: no Stop hook, the report says not configured, exit 0', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('1').env, FAKE_GATE_BASELINE: '3' } })
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops, [])
  assert.match(r.report, /^## Gates\n- GATE: not configured/)
  assert.equal(r.meta.gate.verdict, 'not configured')
  const hooks = JSON.parse(fs.readFileSync(path.join(ctx.job, 'agy', '.agents', 'hooks.json'), 'utf8'))
  assert.equal(hooks['agy-delegate-job'].Stop, undefined)
  const agent = fs.readFileSync(path.join(ctx.job, 'agy', '.agents', 'agents', 'delegate-implementer.md'), 'utf8')
  assert.doesNotMatch(agent, /lint and type-check/)
  assert.doesNotMatch(agent, /\n\n\n/)
})

test('a task job takes no baseline and gets no Stop hook', () => {
  const ctx = setup()
  const r = run(ctx, { mode: 'task', ...fake('1') })
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.gateCalls, [])
  assert.doesNotMatch(r.report, /## Gates/)
  assert.equal(r.meta.gate, undefined)
})

test('with a gate, the agent prompt names the stop check and --print-timeout covers the rounds', () => {
  const ctx = setup()
  const r = run(ctx, fake('0'))
  assert.equal(r.status, 0, r.report)
  const agent = fs.readFileSync(path.join(ctx.job, 'agy', '.agents', 'agents', 'delegate-implementer.md'), 'utf8')
  assert.match(agent, /When you stop, this job runs lint and type-check/)
  const hooks = JSON.parse(fs.readFileSync(path.join(ctx.job, 'agy', '.agents', 'hooks.json'), 'utf8'))
  // A 570 s gate check, a 450 s verifier run and 60 s for the diff and tree snapshots.
  assert.equal(hooks['agy-delegate-job'].Stop[0].timeout, 1080)
  // 2 min of work plus 4 Stop hook runs of 1080 s would be 4440 s. That leaves the guard no whole Stop
  // hook run before 110 min, so it is capped: 6600 - 10 - 570 - 450 - 1080 - 120 s, less the setup time.
  const printS = Number(/print-timeout (\d+)s/.exec(r.stderr)?.[1])
  assert.ok(printS <= 4370 && printS >= 4360, r.stderr)
  assert.match(r.stderr, /print-timeout capped at \d+s: 120s of work plus 4320s for gate rounds/)
})

test('runTimeouts: the guard allows a whole Stop hook run past --print-timeout, and the runner ends inside 110 min', () => {
  const maxS = 110 * 60
  const graceS = 120
  for (const timeoutS of [60, 120, 600, 1800, 3600, maxS])
    for (const elapsedS of [0, 5, 600]) {
      const t = runTimeouts({ timeoutS, gate: true, elapsedS, maxS, graceS })
      const at = `timeout ${timeoutS}s, elapsed ${elapsedS}s`
      assert.ok(t.guardS - t.printS >= STOP_TIMEOUT_S + graceS, `${at}: ${JSON.stringify(t)}`)
      // The guard, SIGKILL 10 s later, then the runner's own gate check and verifier run.
      assert.ok(elapsedS + t.guardS + 10 + GATE_DEADLINE_S + VERIFIER_DEADLINE_S <= maxS, `${at}: ${JSON.stringify(t)}`)
      assert.ok(t.printS <= timeoutS + (ROUND_CAP + 1) * STOP_TIMEOUT_S, at)
    }
  // A short job: 2 min of work plus 4 Stop hook runs doesn't fit, so --print-timeout is lowered.
  assert.deepEqual(runTimeouts({ timeoutS: 120, gate: true, maxS, graceS }), { printS: 4370, guardS: 5570, capped: true })
  // Without a gate nothing changes.
  assert.deepEqual(runTimeouts({ timeoutS: 1800, gate: false, maxS, graceS }), { printS: 1800, guardS: 1920, capped: false })
})

test('runTimeouts: a setup that left too little of the 110 min is refused, never given a guard past it', () => {
  const maxS = 110 * 60
  const graceS = 120
  for (const timeoutS of [60, 1800, maxS])
    for (let elapsedS = 0; elapsedS <= maxS + 100; elapsedS += 25) {
      const t = runTimeouts({ timeoutS, gate: true, elapsedS, maxS, graceS })
      if (t.refused) continue
      const at = `timeout ${timeoutS}s, elapsed ${elapsedS}s: ${JSON.stringify(t)}`
      assert.ok(t.printS >= 60, at)
      assert.ok(t.guardS - t.printS >= STOP_TIMEOUT_S + graceS, at)
      assert.ok(elapsedS + t.guardS + 10 + GATE_DEADLINE_S + VERIFIER_DEADLINE_S <= maxS, at)
    }
  // The review's case: a baseline that ran to 6500 s.
  assert.match(runTimeouts({ timeoutS: 1800, gate: true, elapsedS: 6500, maxS, graceS }).refused ?? '', /6500s.* 100s/)
  // A minute of agy, a Stop hook run, the guard's slack, SIGKILL's 10 s and the runner's own round: 2290 s.
  assert.equal(runTimeouts({ timeoutS: 1800, gate: true, elapsedS: maxS - 2290, maxS, graceS }).printS, 60)
  assert.ok(runTimeouts({ timeoutS: 1800, gate: true, elapsedS: maxS - 2289, maxS, graceS }).refused)
  assert.equal(runTimeouts({ timeoutS: 1800, gate: false, elapsedS: 6500, maxS, graceS }).refused, undefined)
})

test('verifierTimes: a Stop hook ends, verdict saved, before agy kills it at its timeout', () => {
  // stop.mjs gives the verifier its timeout less HOOK_RESERVE_S, less what the check and snapshots took.
  const hook = spentS => {
    const { deadlineS, printS } = verifierTimes(STOP_TIMEOUT_S - HOOK_RESERVE_S - spentS)
    // The kill timer, then SIGKILL's grace, then the last snapshot and the writes.
    return { printS, endS: spentS + deadlineS + VERIFIER_KILL_GRACE_S + HOOK_RESERVE_S }
  }
  // The review's cases: a 124 s check, and a 569 s check with 10 s of inputs and 50 s of snapshots.
  // Before, they ended at 1085 s and 1084 s.
  for (const spentS of [0, 1.5, 124, 124 + 60, 569 + 10 + 50, GATE_DEADLINE_S + 5 + 60]) {
    const { printS, endS } = hook(spentS)
    assert.ok(endS <= STOP_TIMEOUT_S, `${spentS}s spent: the hook ends at ${endS}s`)
    assert.ok(printS >= VERIFIER_MIN_PRINT_S, `${spentS}s spent: --print-timeout ${printS}s`)
  }
  assert.equal(hook(124).printS, 891)
  assert.equal(hook(629).printS, 386)
  // The runner's own check stays inside the round budget runTimeouts reserves after agy exits.
  for (const spentS of [0, 124, GATE_DEADLINE_S + 5]) assert.ok(spentS + verifierTimes(ROUND_BUDGET_S - spentS).deadlineS + VERIFIER_KILL_GRACE_S <= ROUND_BUDGET_S)
  assert.equal(ROUND_BUDGET_S, GATE_DEADLINE_S + VERIFIER_DEADLINE_S)
  assert.equal(STOP_TIMEOUT_S, ROUND_BUDGET_S + 60)
})

test('a verifier run or a job without a gate leaves stop.mjs inert', () => {
  for (const env of [{ AGY_DELEGATE_ROLE: 'verifier', AGY_DELEGATE_GATE: '1' }, { AGY_DELEGATE_GATE: '' }]) {
    const r = spawnSync(process.execPath, [STOP], {
      input: '{"executionNum": 0}',
      encoding: 'utf8',
      env: { ...process.env, AGY_DELEGATE_JOB: '/nonexistent', ...env },
    })
    assert.equal(r.stdout.trim(), '{"decision":"stop"}')
    assert.equal(r.stderr, '')
  }
})

// The real gate (`jobs.mjs gate`) with a lint tool that reports each `as any`.
const FAKE_LINT = `import fs from 'node:fs'
import path from 'node:path'
const diagnostics = []
const walk = dir => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p)
    else fs.readFileSync(p, 'utf8').split('\\n').forEach((text, i) => {
      if (text.includes('as any'))
        diagnostics.push({ code: 'typescript(no-explicit-any)', severity: 'warning', message: 'Unexpected any. Specify a different type.', filename: path.relative(process.cwd(), p), labels: [{ span: { line: i + 1, column: text.indexOf('as any') + 4 } }] })
    })
  }
}
walk('src')
process.stdout.write(JSON.stringify({ diagnostics }))
`
function realGate(ctx, command) {
  fs.writeFileSync(path.join(ctx.root, 'fake-lint.mjs'), FAKE_LINT)
  const config = { packages: ['pkg'], lint: { command: command ?? [process.execPath, path.join(ctx.root, 'fake-lint.mjs')], cwd: '{dir}', parser: 'oxlint-json' } }
  fs.writeFileSync(path.join(ctx.root, 'gate.json'), JSON.stringify(config))
  return ['--gate-config', path.join(ctx.root, 'gate.json')]
}

test('real gate: an `as any` goes back to agy, the fix passes the next check', () => {
  const ctx = setup({
    calls: [['pkg/src/b.ts', "export const b = JSON.parse('1') as any\n"]],
    rounds: [[['pkg/src/b.ts', "export const b: number = JSON.parse('1')\n"]]],
  })
  const r = run(ctx, { args: realGate(ctx) })
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'stop'])
  assert.match(r.stops[0].reason, /\+ typescript\(no-explicit-any\) {2}pkg\/src\/b\.ts:1:37 {2}Unexpected any/)
  assert.match(r.report, /- round 1: FAILED, 1 added, 0 removed, \d+s, sent back to agy\n- round 2: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, stop allowed/)
  assert.match(r.report, /- baseline: GATE BASELINE: 0 finding\(s\) from 1 command\(s\)/)
  assert.deepEqual(r.state.gate.scope.units, ['pkg'])
  // `gate check --job` wrote each round's record; the runner's final write keeps its shape.
  assert.deepEqual(r.meta.gate, {
    verdict: 'OK',
    added: 0,
    removed: 0,
    outside: 0,
    round: 2,
    rounds: 2,
    verifier: { verdict: 'PASS', findings: 0, model: 'gemini-3.8-flash-medium', durationMs: r.meta.gate.verifier.durationMs },
  })
})

test('real gate: a broken lint command fails the baseline with exit 18', () => {
  const ctx = setup()
  const r = run(ctx, { args: realGate(ctx, [process.execPath, '-e', 'process.exit(2)']) })
  assert.equal(r.status, 18, r.stderr)
  assert.match(r.report, /GATE ERROR: the baseline could not run/)
  assert.match(r.report, /lint:pkg {2}\d+s {2}exited 2/)
})

test('real gate: a retry that keeps the findings exits 17 and cannot pass the continue cap', () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', "export const b = JSON.parse('1') as any\n"]] })
  const args = realGate(ctx)
  const first = run(ctx, { args })
  assert.equal(first.status, 17, first.report)
  // The retry changes nothing. A fresh baseline would see the finding as old and pass.
  fs.writeFileSync(ctx.calls, '[]')
  const r = run(ctx, { args })
  assert.equal(r.status, 17, r.report)
  // events.jsonl holds both executions.
  assert.deepEqual(r.stops.slice(first.stops.length).map(a => a.decision), ['stop'])
  assert.match(r.report, /kept from an earlier execution of this job/)
  assert.match(r.report, /- round 5: FAILED, 1 added, 0 removed, \d+s, stop allowed\n/)
  assert.equal(r.state.gate.continues, 3)
})

test('real gate: an OK, then an edit, then a final Stop hook killed at once must not exit 0', () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']] })
  fs.writeFileSync(path.join(ctx.root, 'after-mid.json'), JSON.stringify([ctx.write('pkg/src/b.ts', "export const b = JSON.parse('1') as any\n")]))
  const env = { FAKE_BUSY_STOP: 'mid-idle', FAKE_AFTER_MID_FILE: path.join(ctx.root, 'after-mid.json'), FAKE_KILL_STOP: 'final' }
  const r = run(ctx, { args: realGate(ctx), env })
  assert.equal(r.status, 17, r.report)
  assert.equal(r.stops[0].decision, 'stop')
  assert.equal(r.stops.at(-1).failed, 'ETIMEDOUT')
  assert.match(r.report, /- round 1: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, stop allowed\n- round 2: FAILED, 1 added, 0 removed, \d+s, checked by the runner after agy exited/)
  assert.equal(r.meta.gate.verdict, 'FAILED')
})

test('real gate: an OK whose tree agy left unchanged stands without another check', () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']] })
  const r = run(ctx, { args: realGate(ctx), env: { FAKE_BUSY_STOP: 'mid-idle', FAKE_KILL_STOP: 'final' } })
  assert.equal(r.status, 0, r.report)
  assert.match(r.report, /- round 1's check covers the tree agy left/)
  assert.equal(r.state.gate.history.length, 1)
})

// The verifier, after a clean gate check: fixtures/fake-agy.mjs answers `--agent delegate-verifier`
// runs from FAKE_VERIFIER, one answer per round.
const verified = (checks, answers, extra = {}) => ({ env: { ...fake(checks).env, FAKE_VERIFIER: answers, ...extra } })
const changed = () => setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']] })
const verifierRuns = ctx => {
  const file = path.join(ctx.root, 'verifier-runs.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
}
const logVerifier = ctx => ({ FAKE_VERIFIER_LOG: path.join(ctx.root, 'verifier-runs.jsonl') })

test('verifier FAIL goes back to agy with its findings, and a PASS in the next round exits 0', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'FAIL,PASS', logVerifier(ctx)))
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'stop'])
  assert.match(r.stops[0].reason, /^An independent check of your change found problems\. .*This is round 1 of 3/)
  assert.match(r.stops[0].reason, /\n- pkg\/src\/b\.ts:1 \[SAFETY comments are true\] Nothing checks the value before the cast\. Fix: Narrow it/)
  // A SAFETY: comment backed by the code is a valid fix, and a throw added to fit a type is not.
  assert.match(r.stops[0].reason, /\nFix the cause in the code without changing what it does at runtime\. .*a cast whose SAFETY: comment the code does not back/)
  assert.ok(r.stops[0].reason.split('\n').length <= 40)
  assert.match(r.report, /^## Gates\n- GATE OK: 0 added, 0 removed · verifier PASS · 2 round\(s\), 1 sent back\n/)
  assert.match(r.report, /- round 1: FAILED, 0 added, 0 removed, \d+s, verifier FAIL, 1 finding\(s\) in \d+s, sent back to agy\n {2}- pkg\/src\/b\.ts:1 \[SAFETY/)
  assert.match(r.report, /- round 2: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, stop allowed\n/)
  assert.match(r.report, /- verifier: gemini-3\.8-flash-medium, 2 run\(s\) of \d+s, \d+s\n/)
  // The nested run: the worktree as cwd, its own config dir and agent, the schema, the verifier role.
  const runs = verifierRuns(ctx)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].cwd, ctx.repo)
  assert.equal(runs[0].role, 'verifier')
  const args = runs[0].args.join(' ')
  const result = JSON.parse(fs.readFileSync(path.join(ctx.job, 'verifier', 'result-1.json'), 'utf8'))
  assert.match(args, new RegExp(`--add-dir ${path.join(ctx.job, 'agy-verifier')} --agent delegate-verifier --json-schema \\S+delegate-verifier\\.schema\\.json`))
  // The fake gate check takes about a second. The Stop hook's own deadline bounds the verifier, which
  // gets nearly all of it: more than the runner's round budget, less than the hook's timeout allows.
  const printS = Number(/--model gemini-3\.8-flash-medium .*--print-timeout (\d+)s/.exec(args)?.[1])
  const maxS = STOP_TIMEOUT_S - HOOK_RESERVE_S - VERIFIER_KILL_GRACE_S - VERIFIER_KILL_MARGIN_S
  assert.ok(printS > ROUND_BUDGET_S - VERIFIER_KILL_MARGIN_S && printS <= maxS, args)
  assert.equal(result.printS, printS)
  assert.ok(!runs[0].args.includes(path.join(ctx.job, 'agy')), 'the verifier must not load the implementer config')
  const input = path.join(ctx.job, 'verifier', 'input-1')
  assert.deepEqual(fs.readdirSync(input).sort(), ['brief.md', 'checklist.md', 'diff-numbered.txt', 'diff.patch', 'files.json', 'rules.json'])
  assert.match(fs.readFileSync(path.join(input, 'diff-numbered.txt'), 'utf8'), /pkg\/src\/b\.ts/)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.findings[0].rule, 'SAFETY comments are true')
})

test('verifier FAIL in every round: the cap allows the stop and exit 17 lists the findings', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'FAIL'))
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'continue', 'continue', 'stop'])
  assert.match(r.report, /^## Gates\n- GATE FAILED: 0 added, 0 removed · verifier FAIL, 1 finding\(s\) · 4 round\(s\), 3 sent back\n/)
  assert.match(r.report, /- still failing:\n {2}- pkg\/src\/b\.ts:1 \[SAFETY comments are true\]/)
  assert.match(r.report, /- exit 17 \(gate\): gate FAILED after 3 round\(s\) sent back: the verifier found 1 problem\(s\)/)
  assert.deepEqual({ ...r.meta.gate.verifier, durationMs: 0 }, { verdict: 'FAIL', findings: 1, model: 'gemini-3.8-flash-medium', durationMs: 0 })
})

for (const [answer, why] of [
  ['none', /no valid verdict: no structured result/],
  ['invalid', /no valid verdict: verdict is "MAYBE"/],
  ['crash', /exited 1 without a result/],
  ['pass-exit1', /exited 1 after streaming a result/],
  ['pass-kill', /exited SIGKILL after streaming a result/],
  ['hang', /ran past 2s and was stopped/],
  ['scribble', /the worktree changed while the verifier ran/],
]) {
  test(`a verifier that gives no verdict (${answer}) fails the job without sending agy back`, () => {
    const ctx = changed()
    const r = run(ctx, verified('0', answer, { AGY_DELEGATE_VERIFIER_DEADLINE_S: '2' }))
    assert.equal(r.status, 17, r.report)
    assert.deepEqual(r.stops.map(a => a.decision), ['stop'])
    assert.match(r.report, /^## Gates\n- GATE FAILED: 0 added, 0 removed · verifier no verdict · 1 round\(s\), 0 sent back\n/)
    assert.match(r.report, why)
    assert.equal(r.meta.gate.verdict, 'FAILED')
    assert.equal(r.meta.gate.verifier.verdict, 'no verdict')
  })
}

for (const [who, extra] of [['the Stop hook', {}], ["the runner's own check", { FAKE_STOP_HOOK: '0' }]]) {
  test(`a verifier that hits a quota error in ${who} exits 10 (quota), not 17`, () => {
    const ctx = changed()
    const r = run(ctx, verified('0', 'quota', extra))
    assert.equal(r.status, 10, r.report)
    assert.match(r.report, /^## Gates\n- GATE FAILED: 0 added, 0 removed · verifier no verdict, quota · 1 round\(s\), 0 sent back\n/)
    assert.match(r.report, /- exit 10 \(quota\): gate FAILED after 0 round\(s\) sent back: the verifier hit a quota or rate limit and produced no verdict \(the verifier exited 3 after streaming a result: AGY_ERROR: .*code 429/)
    assert.equal(r.meta.gate.verdict, 'FAILED')
  })
}

test('the verifier hook blocks a write: hook.log shows no allowed write and the worktree is unchanged', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'write'))
  assert.equal(r.status, 0, r.report)
  const log = fs.readFileSync(path.join(ctx.job, 'hook.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const mine = log.filter(e => e.role === 'verifier')
  assert.deepEqual(mine.map(e => [e.tool, e.decision]), [['view_file', 'allow'], ['write_to_file', 'deny']])
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'verifier-was-here.txt')))
  assert.match(r.report, /- the verifier's hook blocked 1 call\(s\); see hook\.log/)
  // The implementer's own list stays clean.
  assert.match(r.report, /- blocked by job rules: none/)
  assert.equal(r.meta.blocked, 0)
})

test('the verifier hook blocks an MCP write, which names no path the write rules check', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'mcp'))
  assert.equal(r.status, 0, r.report)
  const log = fs.readFileSync(path.join(ctx.job, 'hook.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const mine = log.filter(e => e.role === 'verifier')
  assert.deepEqual(mine.map(e => [e.tool, e.decision, e.rule ?? null]), [['view_file', 'allow', null], ['call_mcp_tool', 'deny', 'verifier-read-only']])
  assert.equal(mine[1].target, 'filesystem/write_file')
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'verifier-was-here.txt')))
})

test("the runner's own check gives the verifier the job env, so its reads pass and a PASS counts", () => {
  const ctx = changed()
  // No Stop hook fires, so only the runner runs the gate and the verifier. The fake verifier answers
  // FAIL when its hook denies the read of its input.
  const r = run(ctx, { env: { ...verified('0', 'PASS').env, FAKE_STOP_HOOK: '0' } })
  assert.equal(r.status, 0, r.report)
  assert.match(r.report, /- round 1: OK, 0 added, 0 removed, \d+s, verifier PASS in \d+s, checked by the runner after agy exited/)
  const log = fs.readFileSync(path.join(ctx.job, 'hook.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const read = log.find(e => e.role === 'verifier' && e.tool === 'view_file')
  assert.equal(read.decision, 'allow')
  assert.equal(read.run, r.state.gate.run)
  assert.match(read.target, /verifier\/input-1\/diff-numbered\.txt$/)
})

test('runVerifier: without the job env its hook denies the input read, and no PASS comes back', async () => {
  const ctx = setup()
  fs.writeFileSync(path.join(ctx.repo, 'pkg', 'src', 'b.ts'), 'export const b = 1\n')
  const state = { job: ctx.job, worktree: ctx.repo, mode: 'implement', readOnly: false, paths: ['pkg/src/**'], agent: 'delegate-implementer' }
  writeState(ctx.job, state)
  writeVerifierConfig(ctx.job, { model: 'gemini-3.8-flash-medium', worktree: ctx.repo })
  process.env.FAKE_VERIFIER = 'PASS'
  try {
    const base = { dir: ctx.job, worktree: ctx.repo, agy: FAKE_AGY, model: 'gemini-3.8-flash-medium', run: 'run-1' }
    const broken = await runVerifier({ ...base, n: 1, stateSha: undefined })
    assert.equal(broken.verdict, 'FAIL')
    const log = fs.readFileSync(path.join(ctx.job, 'hook.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.deepEqual(log.map(e => [e.role, e.tool, e.decision, e.rule]), [['verifier', 'view_file', 'deny', 'state-changed']])
    const good = await runVerifier({ ...base, n: 2, stateSha: stateHash(state) })
    assert.equal(good.verdict, 'PASS', good.reason)
  } finally {
    delete process.env.FAKE_VERIFIER
  }
})

// A changed worktree with the verifier config written, for calling runVerifier in this process.
function verifierJob() {
  const ctx = setup()
  fs.writeFileSync(path.join(ctx.repo, 'pkg', 'src', 'b.ts'), 'export const b = 1\n')
  const state = { job: ctx.job, worktree: ctx.repo, mode: 'implement', readOnly: false, paths: ['pkg/src/**'], agent: 'delegate-implementer' }
  writeState(ctx.job, state)
  writeVerifierConfig(ctx.job, { model: 'gemini-3.8-flash-medium', worktree: ctx.repo })
  return { ctx, base: { dir: ctx.job, worktree: ctx.repo, agy: FAKE_AGY, model: 'gemini-3.8-flash-medium', run: 'run-1', stateSha: stateHash(state) } }
}

test('runVerifier leaves no file descriptors open for the verifier stdio', async () => {
  const { base } = verifierJob()
  const open = () => fs.readdirSync('/dev/fd').length
  const before = open()
  for (const n of [1, 2]) assert.equal((await runVerifier({ ...base, n })).verdict, 'PASS')
  assert.equal(open(), before)
})

test('runVerifier takes its kill timer and --print-timeout from its deadline, and skips agy when too little is left', async () => {
  const { ctx, base } = verifierJob()
  const log = path.join(ctx.root, 'verifier-runs.jsonl')
  process.env.FAKE_VERIFIER_LOG = log
  try {
    const short = await runVerifier({ ...base, n: 1, deadlineAt: Date.now() + 50_000 })
    assert.deepEqual([short.verdict, short.noVerdict], ['FAIL', true])
    assert.match(short.reason, /^only (49|50)s were left for the verifier, too little for a 60s --print-timeout$/)
    assert.ok(!fs.existsSync(log), 'agy ran with too little time')
    const v = await runVerifier({ ...base, n: 2, deadlineAt: Date.now() + 200_000 })
    assert.equal(v.verdict, 'PASS')
    // 200 s less SIGKILL's 5 s grace and the 30 s kill margin.
    assert.ok(v.printS >= 164 && v.printS <= 165, String(v.printS))
    assert.match(JSON.parse(fs.readFileSync(log, 'utf8')).args.join(' '), new RegExp(`--print-timeout ${v.printS}s`))
  } finally {
    delete process.env.FAKE_VERIFIER_LOG
  }
})

test('the verifier runs without AGY_DELEGATE_GATE', async () => {
  const { ctx, base } = verifierJob()
  const log = path.join(ctx.root, 'verifier-runs.jsonl')
  Object.assign(process.env, { AGY_DELEGATE_GATE: '1', FAKE_VERIFIER_LOG: log })
  try {
    assert.equal((await runVerifier({ ...base, n: 1 })).verdict, 'PASS')
  } finally {
    delete process.env.AGY_DELEGATE_GATE
    delete process.env.FAKE_VERIFIER_LOG
  }
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).hasGate, false)
})

test('a FAILED gate check runs no verifier', () => {
  const ctx = changed()
  const r = run(ctx, verified('1,0', 'PASS', logVerifier(ctx)))
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(verifierRuns(ctx).map(v => v.round), [2])
  assert.equal(r.state.gate.history[0].verifier, undefined)
})

test('an empty change passes the verifier without running agy', () => {
  const ctx = setup()
  const r = run(ctx, verified('0', 'FAIL', logVerifier(ctx)))
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(verifierRuns(ctx), [])
  assert.match(JSON.parse(fs.readFileSync(path.join(ctx.job, 'verifier', 'result-1.json'), 'utf8')).reason, /the change is empty/)
})

test('a PASS, then an edit, then a final Stop hook killed at once: the runner runs the verifier too', () => {
  const ctx = changed()
  fs.writeFileSync(path.join(ctx.root, 'after-mid.json'), JSON.stringify([ctx.write('pkg/src/c.ts', 'export const c = 1\n')]))
  const extra = { FAKE_BUSY_STOP: 'mid-idle', FAKE_AFTER_MID_FILE: path.join(ctx.root, 'after-mid.json'), FAKE_KILL_STOP: 'final' }
  const r = run(ctx, verified('0', 'PASS,FAIL', extra))
  assert.equal(r.status, 17, r.report)
  assert.match(r.report, /- round 1: OK, .*verifier PASS in \d+s, stop allowed\n- round 2: FAILED, 0 added, 0 removed, \d+s, verifier FAIL, 1 finding\(s\) in \d+s, checked by the runner after agy exited/)
})

test('a Stop hook killed while the verifier runs never reads as OK', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'hang', { FAKE_HOOK_TIMEOUT_S: '2', AGY_DELEGATE_VERIFIER_DEADLINE_S: '4' }))
  assert.equal(r.status, 17, r.report)
  assert.equal(r.stops.at(-1).failed, 'ETIMEDOUT')
  assert.match(r.report, /- round 2: FAILED, .*verifier no verdict in \d+s, checked by the runner after agy exited/)
  const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout
  assert.ok(!ps.split('\n').some(l => l.includes('delegate-verifier') && l.includes(ctx.job)), 'the hung verifier still runs')
})

test('the generated verifier config: read-only agent with finish, a PreToolUse hook and no Stop hook', () => {
  const ctx = changed()
  assert.equal(run(ctx, verified('0', 'PASS')).status, 0)
  const cfg = path.join(ctx.job, 'agy-verifier', '.agents')
  const agent = fs.readFileSync(path.join(cfg, 'agents', 'delegate-verifier.md'), 'utf8')
  assert.match(agent, /^---\nname: delegate-verifier\n/)
  assert.match(agent, /\nmainAgent: true\ntools: \[view_file, list_dir, find_by_name, grep_search, finish\]\n---\n/)
  assert.doesNotMatch(agent, /\{\{/)
  const hooks = JSON.parse(fs.readFileSync(path.join(cfg, 'hooks.json'), 'utf8'))
  assert.deepEqual(Object.keys(hooks['agy-delegate-verifier']), ['PreToolUse'])
  assert.match(hooks['agy-delegate-verifier'].PreToolUse[0].hooks[0].command, /pre-tool\.mjs'$/)
})

// `delegate-jobs tail`: agy's stream has no hook events, so the hooks write progress.jsonl and tail puts
// those lines between agy's own steps.
const JOBS = path.join(HERE, '..', 'jobs.mjs')
const tailEnv = ctx => ({ ...process.env, DELEGATE_JOBS_DIR: path.dirname(ctx.job) })
const snapshot = ctx => spawnSync(process.execPath, [JOBS, 'tail', ctx.job, '-n', '200'], { env: tailEnv(ctx), encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
function assertInOrder(lines, patterns) {
  let at = 0
  for (const p of patterns) {
    const i = lines.findIndex((l, idx) => idx >= at && p.test(l))
    assert.ok(i >= 0, `no line matching ${p} after line ${at} in:\n${lines.join('\n')}`)
    at = i + 1
  }
}
const gate = (n, text, prefix = '') => new RegExp(`^${prefix}gate round ${n}: ${text}`)

// Runs the job through `jobs.mjs exec` while `jobs.mjs tail <tailArgs>` follows it. `--next` waits for a
// job created after it starts, so the job's meta.json is written afterwards.
async function watched(ctx, tailArgs, env = {}) {
  const meta = path.join(ctx.job, 'meta.json')
  const arm = () => fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), status: 'created', createdAt: new Date().toISOString() }))
  const next = tailArgs.includes('--next')
  if (!next) arm()
  const finished = child => new Promise(resolve => child.on('exit', code => resolve(code)))
  let stdout = ''
  const tail = spawn(process.execPath, [JOBS, 'tail', ...(next ? [] : [ctx.job]), ...tailArgs], { env: tailEnv(ctx), stdio: ['ignore', 'pipe', 'inherit'] })
  tail.stdout.setEncoding('utf8').on('data', d => (stdout += d))
  const killer = setTimeout(() => tail.kill(), 60_000)
  const tailed = finished(tail)
  if (next) arm()
  const exec = spawn(process.execPath, [JOBS, 'exec', ctx.job, '--', process.execPath, ...runnerArgs(ctx)], { cwd: ctx.repo, env: runnerEnv(ctx, env), stdio: 'ignore' })
  const status = await finished(exec)
  assert.equal(await tailed, 0)
  clearTimeout(killer)
  return { status, lines: stdout.split('\n').filter(Boolean) }
}

test('tail shows each gate check and verifier run between agy steps, in order', () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']], rounds: [[['pkg/src/b.ts', 'export const b = 2\n']]] })
  const r = run(ctx, verified('1,0', 'PASS'))
  assert.equal(r.status, 0, r.report)
  const lines = snapshot(ctx)
  assertInOrder(lines, [
    /^agy-test · /,
    /^agy started: gemini-3\.8-flash-low/,
    /^write_to_file {2}pkg\/src\/b\.ts$/,
    /^says: Fake agy finished\.$/,
    gate(1, 'lint and type-check started \\(stopped after 570s\\)$'),
    gate(1, 'lint and type-check FAILED, 1 added, 0 removed \\(\\d+s\\)$'),
    gate(1, 'sent back to agy \\(1 of 3\\)$'),
    /^write_to_file {2}pkg\/src\/b\.ts$/,
    /^says: Fake agy round 2\.$/,
    gate(2, 'lint and type-check started'),
    gate(2, 'lint and type-check OK, 0 added, 0 removed \\(\\d+s\\)$'),
    gate(2, 'verifier started: gemini-3\\.8-flash-medium, pid \\d+, stopped after \\d+s$'),
    gate(2, 'verifier PASS \\(\\d+s\\)$'),
    gate(2, 'OK, agy may stop$'),
    /^agy's turn ended: SUCCESS/,
  ])
  assert.equal(lines.filter(l => l.startsWith('gate round')).length, 8)
  // The nested verifier's own tool calls stay out of the job's progress.
  assert.ok(!lines.some(l => /view_file|diff-numbered/.test(l)), lines.join('\n'))
  // The file holds display text and the size of events.jsonl at the time, nothing the runner decides on.
  const written = fs.readFileSync(path.join(ctx.job, 'progress.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  assert.equal(written.length, 8)
  assert.deepEqual(written.map(w => w.offset), written.map(w => w.offset).sort((a, b) => a - b))
  assert.ok(written.every(w => w.offset > 0 && typeof w.text === 'string'))
})

test('tail shows a verifier that timed out, and the stop the hook allowed', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'hang', { AGY_DELEGATE_VERIFIER_DEADLINE_S: '2' }))
  assert.equal(r.status, 17, r.report)
  assertInOrder(snapshot(ctx), [
    gate(1, 'lint and type-check OK, 0 added, 0 removed'),
    gate(1, 'verifier started: gemini-3\\.8-flash-medium, pid \\d+, stopped after 2s$'),
    gate(1, 'verifier timed out after 2s, so no verdict$'),
    gate(1, 'FAILED, stop allowed: the verifier produced no verdict: the verifier ran past 2s and was stopped$'),
  ])
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.job, 'verifier', 'result-1.json'), 'utf8')).timedOut, true)
})

test('tail shows a gate check that cannot run, and the stop the hook allowed', () => {
  const ctx = setup()
  const r = run(ctx, fake('2'))
  assert.equal(r.status, 17, r.report)
  assertInOrder(snapshot(ctx), [gate(1, 'lint and type-check started'), gate(1, 'lint and type-check could not finish after \\d+s: '), gate(1, 'error, stop allowed: ')])
})

test('tail shows the runner checking the tree agy left when no Stop hook ran', () => {
  const ctx = changed()
  const r = run(ctx, verified('1', 'PASS', { FAKE_STOP_HOOK: '0' }))
  assert.equal(r.status, 17, r.report)
  const runner = ' \\(runner, after agy exited\\)'
  assertInOrder(snapshot(ctx), [
    /^agy's turn ended: /,
    new RegExp(`^gate round 1${runner}: no check covers the tree agy left, so the runner checks it$`),
    new RegExp(`^gate round 1${runner}: lint and type-check started`),
    new RegExp(`^gate round 1${runner}: lint and type-check FAILED, 1 added, 0 removed`),
    new RegExp(`^gate round 1${runner}: FAILED$`),
  ])
})

test('tail shows a stop with work still running as a skipped check that spends no round', () => {
  const ctx = changed()
  const r = run(ctx, verified('0', 'PASS', { FAKE_BUSY_STOP: 'mid' }))
  assert.equal(r.status, 0, r.report)
  assertInOrder(snapshot(ctx), [
    /^gate: agy stopped with work still running, so no check this time$/,
    gate(1, 'lint and type-check started'),
    gate(1, 'OK, agy may stop'),
  ])
})

test('tail places a gate line by the byte size of events.jsonl, also after non-ASCII text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-offset-'))
  try {
    const job = path.join(dir, 'agy-x')
    fs.mkdirSync(job)
    fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ id: 'agy-x', status: 'completed', cwd: '/w' }))
    const events = [
      { event: 'init', init: { model: 'm', cwd: '/w' } },
      { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'héllo wörld ✓ ünïcode' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/w/a.ts' } } } },
    ].map(e => `${JSON.stringify(e)}\n`)
    fs.writeFileSync(path.join(job, 'events.jsonl'), events.join(''))
    const after = n => events.slice(0, n).reduce((sum, l) => sum + Buffer.byteLength(l), 0)
    const marks = [[after(0), 'before all'], [after(2), 'after the answer'], [after(3), 'after the tool'], [after(3) + 5000, 'past the end']]
    fs.writeFileSync(path.join(job, 'progress.jsonl'), `${marks.map(([offset, text]) => JSON.stringify({ offset, text })).join('\n')}\nnot json\n`)
    const lines = spawnSync(process.execPath, [JOBS, 'tail', job, '-n', '50'], { env: { ...process.env, DELEGATE_JOBS_DIR: dir }, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    assert.deepEqual(lines.slice(1), ['before all', 'agy started: m in /w', 'says: héllo wörld ✓ ünïcode', 'after the answer', 'view_file  a.ts', 'after the tool', 'past the end'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Text from outside the hooks (a command's output, agy's stderr) can carry terminal control sequences.
const BIDI = String.fromCharCode(0x202e)
const DIRTY = `ok \x1b[31mred\x1b[0m \x1b]0;title\x07done\r\nnext\x00\x08\x9b${BIDI} end \x1b(B\x1b7\x1b[2J`
const CONTROL_CHARS = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${BIDI}]`)

test('progress() drops escape sequences and control characters before it writes a line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-clean-'))
  try {
    progress(dir, DIRTY)
    progress(dir, `${'x'.repeat(300)}\x1b[31m`)
    const [first, second] = fs.readFileSync(path.join(dir, 'progress.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(first.text, 'ok red done next end')
    assert.equal(second.text, 'x'.repeat(240))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail drops escape sequences and control characters from a progress line written by anything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-clean-'))
  try {
    const job = path.join(dir, 'agy-x')
    fs.mkdirSync(job)
    fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ id: 'agy-x', status: 'completed', cwd: '/w' }))
    fs.writeFileSync(path.join(job, 'events.jsonl'), `${JSON.stringify({ event: 'init', init: { model: 'm', cwd: '/w' } })}\n`)
    fs.writeFileSync(path.join(job, 'progress.jsonl'), `${JSON.stringify({ offset: 0, text: DIRTY })}\n`)
    const out = spawnSync(process.execPath, [JOBS, 'tail', job, '-n', '50'], { env: { ...process.env, DELEGATE_JOBS_DIR: dir }, encoding: 'utf8' }).stdout
    assert.equal(out.split('\n').filter(Boolean)[1], 'ok red done next end')
    assert.doesNotMatch(out, CONTROL_CHARS)
    // `jobs` shows the latest line of a job under its id.
    fs.writeFileSync(path.join(job, 'progress.jsonl'), `${JSON.stringify({ offset: 1e9, text: DIRTY })}\n`)
    const listed = spawnSync(process.execPath, [JOBS, 'jobs', '--all'], { env: { ...process.env, DELEGATE_JOBS_DIR: dir }, encoding: 'utf8' }).stdout
    assert.match(listed, /ok red done next end/)
    assert.doesNotMatch(listed, CONTROL_CHARS)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('jobs shows the verifier verdict beside the gate verdict', () => {
  const listed = ctx => spawnSync(process.execPath, [JOBS, 'jobs', '--all'], { env: tailEnv(ctx), encoding: 'utf8' }).stdout.split('\n').find(l => l.startsWith('agy-test '))
  const cases = [
    [verified('0', 'PASS'), 0, / gate OK · verifier PASS$/],
    [verified('0', 'FAIL'), 17, / gate FAILED · verifier FAIL \(1\)$/],
    [verified('0', 'crash', { AGY_DELEGATE_VERIFIER_DEADLINE_S: '2' }), 17, / gate FAILED · verifier no verdict$/],
    [fake('1'), 17, / gate FAILED$/],
  ]
  for (const [options, status, line] of cases) {
    const ctx = changed()
    assert.equal(run(ctx, options).status, status)
    assert.match(listed(ctx), line)
  }
})

test('tail -f prints the gate lines as the job runs, then its outcome', async () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']], rounds: [[['pkg/src/b.ts', 'export const b = 2\n']]] })
  const { status, lines } = await watched(ctx, ['-f'], verified('1,0', 'PASS').env)
  assert.equal(status, 0)
  assertInOrder(lines, [
    /^agy-test · /,
    gate(1, 'lint and type-check started'),
    gate(1, 'sent back to agy \\(1 of 3\\)'),
    gate(2, 'verifier started: '),
    gate(2, 'verifier PASS'),
    gate(2, 'OK, agy may stop'),
    /^agy's turn ended: SUCCESS/,
    /^agy-test completed \(exit 0/,
  ])
})

test('tail --next -f --every prints the gate lines as they happen and condenses the rest', async () => {
  const ctx = setup({ calls: [['pkg/src/b.ts', 'export const b = 1\n']] })
  // agy starts working 3 s in, after tail has attached: a condensed tail prints nothing of what came before.
  const { status, lines } = await watched(ctx, ['--next', '-f', '--every', '1m'], verified('0', 'PASS', { FAKE_DELAY_START: '3' }).env)
  assert.equal(status, 0)
  const prefix = 'agy-test · '
  assertInOrder(lines, [
    gate(1, 'lint and type-check started', prefix),
    gate(1, 'lint and type-check OK, 0 added, 0 removed', prefix),
    gate(1, 'verifier started: ', prefix),
    gate(1, 'verifier PASS', prefix),
    gate(1, 'OK, agy may stop', prefix),
    /^agy-test completed \(exit 0/,
  ])
  // The one-minute summary is not due, so agy's own steps are not printed.
  assert.ok(!lines.some(l => /^write_to_file/.test(l)), lines.join('\n'))
})

test('tail --next takes an open job the relay created just before the watch, one job per watch', async () => {
  const jobs = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-next-'))), 'jobs')
  const writeMeta = (id, meta) => {
    fs.mkdirSync(path.join(jobs, id), { recursive: true })
    fs.writeFileSync(path.join(jobs, id, 'meta.json'), JSON.stringify({ id, tool: 'agy', cwd: jobs, ...meta }))
  }
  const secondsAgo = s => new Date(Date.now() - s * 1000).toISOString()
  writeMeta('agy-stale', { status: 'created', createdAt: secondsAgo(600) })
  writeMeta('agy-done', { status: 'completed', exitCode: 0, createdAt: secondsAgo(30) })
  writeMeta('agy-first', { status: 'created', createdAt: secondsAgo(20) })
  writeMeta('agy-second', { status: 'created', createdAt: secondsAgo(10) })
  const watch = () => {
    const child = spawn(process.execPath, [JOBS, 'tail', '--next', '-f'], { env: { ...process.env, DELEGATE_JOBS_DIR: jobs }, stdio: ['ignore', 'pipe', 'inherit'] })
    const killer = setTimeout(() => child.kill(), 15_000)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    // A watch that never attaches is killed, so the test fails instead of hanging.
    const attached = new Promise(resolve => {
      child.stdout.on('data', d => resolve((stdout += d)))
      child.on('exit', resolve)
    })
    const exited = new Promise(resolve => child.on('exit', code => resolve(code))).then(code => {
      clearTimeout(killer)
      return { code, lines: stdout.split('\n').filter(Boolean) }
    })
    return { attached, exited }
  }
  // The second watch starts once the first has claimed the oldest open job, so it takes the next one.
  const first = watch()
  await first.attached
  const second = watch()
  await second.attached
  for (const id of ['agy-first', 'agy-second']) writeMeta(id, { status: 'completed', exitCode: 0, createdAt: secondsAgo(5) })
  const [a, b] = await Promise.all([first.exited, second.exited])
  assert.equal(a.code, 0)
  assert.equal(b.code, 0)
  assert.match(a.lines[0], /^agy-first · created · /, a.lines.join('\n'))
  assert.equal(a.lines.at(-1), 'agy-first completed (exit 0)')
  assert.match(b.lines[0], /^agy-second · created · /, b.lines.join('\n'))
  assert.equal(b.lines.at(-1), 'agy-second completed (exit 0)')
})

test('a job on Argon gets lint and type-check only: findings still go back, the verifier never runs', () => {
  const ctx = changed()
  // A verifier run would FAIL, and its model would not be found: neither may happen.
  const env = verified('1,0', 'FAIL', { ...logVerifier(ctx), AGY_DELEGATE_VERIFIER_MODEL: 'not-a-model' }).env
  const r = run(ctx, { args: ['--model', 'gemini-4-argon-medium'], env })
  assert.equal(r.status, 0, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'stop'])
  assert.equal(verifierRuns(ctx).length, 0)
  assert.ok(!fs.existsSync(path.join(ctx.job, 'agy-verifier')), 'no verifier config was written')
  assert.match(r.report, /^## Gates\n- GATE OK: 0 added, 0 removed · 2 round\(s\), 1 sent back\n/)
  assert.match(r.report, /- round 2: OK, 0 added, 0 removed, \d+s, stop allowed\n/)
  assert.match(r.report, /- verifier: skipped, agy runs on gemini-4-argon-medium\n/)
  assert.equal(r.meta.gate.verdict, 'OK')
  assert.ok(snapshot(ctx).includes('gate round 2: verifier skipped for this model'), snapshot(ctx).join('\n'))
})
