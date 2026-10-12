// The stop gate end to end: agy-run.mjs against fixtures/fake-agy.mjs, with the real hooks and either
// fixtures/fake-gate.mjs or the real `jobs.mjs gate` on a fake lint tool.
// Run: node --test 'scripts/test/*.test.mjs'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

function run(ctx, { mode = 'implement', args = [], env = {} } = {}) {
  const r = spawnSync(
    process.execPath,
    [RUNNER, 'run', '--job-dir', ctx.job, '--mode', mode, '--model', 'gemini-3.8-flash-low', '--timeout', '2m', ...args],
    {
      cwd: ctx.repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGY_BIN: FAKE_AGY,
        DELEGATE_JOBS_DIR: path.dirname(ctx.job),
        FAKE_CALLS_FILE: ctx.calls,
        FAKE_ROUNDS_FILE: ctx.rounds,
        FAKE_GATE_LOG: path.join(ctx.root, 'gate-calls.jsonl'),
        ...env,
      },
    },
  )
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
  assert.match(r.report, /^## Gates\n- GATE OK: 0 added, 0 removed · 4 round\(s\), 3 sent back\n/)
  assert.equal((r.report.match(/sent back to agy/g) ?? []).length, 3)
  assert.match(r.report, /- round 4: OK, 0 added, 0 removed, \d+s, stop allowed/)
  assert.deepEqual(r.meta.gate, { verdict: 'OK', added: 0, removed: 0, outside: 0, round: 4, rounds: 4 })
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
  assert.match(r.report, /- round 4: FAILED, 1 added, 0 removed, \d+s, stop allowed\n- still failing:\n {2}\+ typescript\(no-explicit-any\)/)
  assert.match(r.report, /- exit 17 \(gate\): gate FAILED after 3 round\(s\) sent back: 1 finding\(s\) added/)
  assert.equal(r.meta.gate.verdict, 'FAILED')
  assert.equal(r.meta.gate.rounds, 4)
  assert.match(r.meta.verdict, /^gate FAILED/)
  // The answer is kept: every round's text.
  assert.match(r.stdout, /Fake agy finished\.\nFake agy round 2\.\nFake agy round 3\.\nFake agy round 4\./)
})

test('a gate that cannot run mid-job lets agy stop and fails the job with exit 17', () => {
  const ctx = setup()
  const r = run(ctx, fake('1,2'))
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.stops.map(a => a.decision), ['continue', 'stop'])
  assert.match(r.report, /- GATE ERROR: gate check exited 2: GATE ERROR: could not run \(round 2\)/)
  assert.equal(r.meta.gate.verdict, 'error')
})

test('a Stop hook killed mid-check never reads as OK', () => {
  const ctx = setup()
  const r = run(ctx, fake('1,kill'))
  assert.equal(r.status, 17, r.report)
  assert.equal(r.stops.at(-1).failed, 'SIGKILL')
  assert.match(r.report, /GATE ERROR: the Stop hook did not finish round 2/)
  assert.equal(r.meta.gate.verdict, 'error')
})

test('a Stop hook that times out fails the job, and the runner stops the gate it left behind', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('hang').env, FAKE_HOOK_TIMEOUT_S: '2' } })
  assert.equal(r.status, 17, r.report)
  assert.match(r.report, /GATE ERROR: the Stop hook did not finish round 1/)
  assert.match(r.report, /stopped processes agy left running: /)
  const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout
  assert.ok(!ps.includes(`--job ${ctx.job}`), 'the hung gate check still runs')
})

test('a run whose Stop hook never fires fails with exit 17', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('0').env, FAKE_STOP_HOOK: '0' } })
  assert.equal(r.status, 17, r.report)
  assert.match(r.report, /GATE ERROR: no gate check ran in this execution/)
})

test('a Stop verdict from an earlier execution does not count', () => {
  const ctx = setup()
  assert.equal(run(ctx, fake('0')).status, 0)
  // A rerun in the same job dir whose Stop hook never fires.
  const r = run(ctx, { env: { ...fake('0').env, FAKE_STOP_HOOK: '0' } })
  assert.equal(r.status, 17, r.report)
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

test('a run that ends at a Stop with work still running fails with exit 17', () => {
  const ctx = setup()
  const r = run(ctx, { env: { ...fake('0').env, FAKE_BUSY_STOP: 'last' } })
  assert.equal(r.status, 17, r.report)
  assert.deepEqual(r.gateCalls.map(a => a[0]), ['baseline'])
  assert.match(r.report, /GATE ERROR: agy stopped with work still running, and no check ran after that/)
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
  assert.equal(hooks['agy-delegate-job'].Stop[0].timeout, 600)
  // 2 min of work plus 4 Stop hook runs of 600 s.
  assert.match(r.stderr, /print-timeout 2520s/)
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
  assert.match(r.report, /- round 1: FAILED, 1 added, 0 removed, \d+s, sent back to agy\n- round 2: OK, 0 added, 0 removed, \d+s, stop allowed/)
  assert.match(r.report, /- baseline: GATE BASELINE: 0 finding\(s\) from 1 command\(s\)/)
  assert.deepEqual(r.state.gate.scope.units, ['pkg'])
  // `gate check --job` wrote each round's record; the runner's final write keeps its shape.
  assert.deepEqual(r.meta.gate, { verdict: 'OK', added: 0, removed: 0, outside: 0, round: 2, rounds: 2 })
})

test('real gate: a broken lint command fails the baseline with exit 18', () => {
  const ctx = setup()
  const r = run(ctx, { args: realGate(ctx, [process.execPath, '-e', 'process.exit(2)']) })
  assert.equal(r.status, 18, r.stderr)
  assert.match(r.report, /GATE ERROR: the baseline could not run/)
  assert.match(r.report, /lint:pkg {2}\d+s {2}exited 2/)
})
