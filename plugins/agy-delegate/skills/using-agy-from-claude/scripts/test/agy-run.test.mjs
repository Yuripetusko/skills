// Runs agy-run.mjs against fixtures/fake-agy.mjs in a scratch git repo, with the real hook scripts.
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
const FAKE = path.join(HERE, 'fixtures', 'fake-agy.mjs')
fs.chmodSync(FAKE, 0o755)

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-')))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  const git = args => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo })
  git(['init', '-q'])
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  const job = path.join(root, 'jobs', 'agy-test')
  fs.mkdirSync(job, { recursive: true })
  fs.writeFileSync(path.join(job, 'brief.md'), 'paths: src/**\n\nRun claude, write outside paths, edit src/b.ts.\n')
  const calls = path.join(root, 'calls.json')
  fs.writeFileSync(
    calls,
    JSON.stringify([
      { name: 'run_command', args: { CommandLine: 'claude --version' } },
      { name: 'write_to_file', args: { TargetFile: path.join(repo, 'notes', 'outside.md'), CodeContent: 'x\n' } },
      { name: 'write_to_file', args: { TargetFile: path.join(repo, 'src', 'b.ts'), CodeContent: 'export const b = 2\n' } },
    ]),
  )
  return { root, repo, job, calls }
}

function run(ctx, env = {}) {
  const r = spawnSync(
    process.execPath,
    [RUNNER, 'run', '--job-dir', ctx.job, '--mode', 'implement', '--model', 'gemini-3.8-flash-low', '--timeout', '2m'],
    {
      cwd: ctx.repo,
      encoding: 'utf8',
      env: { ...process.env, AGY_BIN: FAKE, DELEGATE_JOBS_DIR: path.dirname(ctx.job), FAKE_CALLS_FILE: ctx.calls, ...env },
    },
  )
  return { status: r.status, stderr: r.stderr, report: fs.existsSync(path.join(ctx.job, 'report.md')) ? fs.readFileSync(path.join(ctx.job, 'report.md'), 'utf8') : '' }
}
const meta = ctx => JSON.parse(fs.readFileSync(path.join(ctx.job, 'meta.json'), 'utf8'))

test('a job blocks claude and the out-of-scope write, keeps the in-scope edit, exits 0', () => {
  const ctx = setup()
  const r = run(ctx)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.report, /blocked by job rules \(2\):/)
  assert.match(r.report, /run_command `claude --version` \(ai-cli\)/)
  assert.match(r.report, /notes\/outside\.md \(outside-paths\)/)
  assert.equal(meta(ctx).blocked, 2)
  assert.ok(fs.existsSync(path.join(ctx.repo, 'src', 'b.ts')))
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'notes')))
})

test('an unknown --agent name exits 18 before launch', () => {
  const ctx = setup()
  const r = run(ctx, { AGY_DELEGATE_AGENT: 'no-such-agent' })
  assert.equal(r.status, 18)
  assert.match(r.stderr, /agy -p \/agents` does not list agent "no-such-agent"/)
})

test('a failed /hooks or /agents call exits 18 and names the call, even with JSON printed', () => {
  const ctx = setup()
  let r = run(ctx, { FAKE_SLASH_FAIL: 'hooks:exit' })
  assert.equal(r.status, 18)
  assert.match(r.stderr, /`agy -p \/hooks` exited 1/)
  r = run(ctx, { FAKE_SLASH_FAIL: 'agents:signal' })
  assert.equal(r.status, 18)
  assert.match(r.stderr, /`agy -p \/agents` was killed by SIGKILL/)
})

test('hooks that never fire exit 18, also when a canary is left from an earlier run', () => {
  const ctx = setup()
  assert.equal(run(ctx).status, 0)
  const r = run(ctx, { FAKE_HOOKS: '0' })
  assert.equal(r.status, 18, r.report)
  assert.match(r.report, /job rules did not load/)
})

test('a canary without this execution id does not count', () => {
  const ctx = setup()
  const r = run(ctx, { FAKE_FORGE: '1' })
  assert.equal(r.status, 18, r.report)
})

test("a healthy rerun is not stopped by the earlier run's finished steps", () => {
  const ctx = setup()
  assert.equal(run(ctx, { FAKE_HOOKS: '0' }).status, 18)
  fs.rmSync(path.join(ctx.repo, 'src', 'b.ts'), { force: true })
  fs.rmSync(path.join(ctx.repo, 'notes'), { recursive: true, force: true })
  const r = run(ctx, { FAKE_DELAY_START: '1.5' })
  assert.equal(r.status, 0, r.report)
  assert.match(r.report, /blocked by job rules \(2\):/)
})

test('a state.json rewritten during the run makes every call fail', () => {
  const ctx = setup()
  const r = run(ctx, { FAKE_TAMPER: '1' })
  assert.match(r.report, /blocked by job rules \(3\):/)
  assert.equal((r.report.match(/\(state-changed\)/g) ?? []).length, 3)
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'notes')))
  assert.ok(!fs.existsSync(path.join(ctx.repo, 'src', 'b.ts')))
})
