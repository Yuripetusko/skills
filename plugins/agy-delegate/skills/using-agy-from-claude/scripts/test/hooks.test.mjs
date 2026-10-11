// Replays hook stdin JSON through the agy hook scripts. Run: node --test scripts/test/
// The fixtures follow agy 1.3.3's documented PreToolUse input; {{worktree}} and {{agyDir}} are filled in here.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decide, globToRegExp } from '../hooks/pre-tool.mjs'
import { globToRegExp as jobsGlob } from '../jobs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOKS = path.join(HERE, '..', 'hooks')
const FIXTURES = path.join(HERE, 'fixtures', 'hooks')

function makeJob(state = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-')))
  const worktree = path.join(root, 'worktree')
  const job = path.join(root, 'job')
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
  fs.mkdirSync(path.join(job, 'agy', '.agents'), { recursive: true })
  const full = { job, worktree, mode: 'implement', readOnly: false, paths: ['src/**'], agent: 'delegate-implementer', ...state }
  fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(full))
  return { root, worktree, job, agyDir: path.join(job, 'agy') }
}

const hookLog = job =>
  fs.existsSync(path.join(job, 'hook.log'))
    ? fs.readFileSync(path.join(job, 'hook.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    : []

function runHook(script, input, ctx, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, script)], {
    input,
    encoding: 'utf8',
    cwd: path.join(ctx.agyDir, '.agents'), // agy runs hooks in the dir that holds hooks.json
    env: { ...process.env, AGY_DELEGATE_JOB: ctx.job, AGY_DELEGATE_ROLE: '', ...env },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

function replay(fixture, ctx, env) {
  const input = fs
    .readFileSync(path.join(FIXTURES, fixture), 'utf8')
    .replaceAll('{{worktree}}', ctx.worktree)
    .replaceAll('{{agyDir}}', ctx.agyDir)
  return runHook('pre-tool.mjs', input, ctx, env)
}

test('allowed command: explicit allow, logged', () => {
  const ctx = makeJob()
  assert.deepEqual(replay('run-command-allowed.json', ctx), { decision: 'allow' })
  const [entry] = hookLog(ctx.job)
  assert.equal(entry.decision, 'allow')
  assert.equal(entry.tool, 'run_command')
  assert.equal(entry.target, 'git status --short && git diff --stat')
})

test('denied command: claude is blocked with a reason, logged', () => {
  const ctx = makeJob()
  const answer = replay('run-command-claude.json', ctx)
  assert.equal(answer.decision, 'deny')
  assert.match(answer.reason, /ai-cli/)
  assert.deepEqual(
    hookLog(ctx.job).map(e => [e.decision, e.rule, e.target]),
    [['deny', 'ai-cli', 'claude --version']],
  )
})

test('write inside paths is allowed', () => {
  const ctx = makeJob()
  assert.deepEqual(replay('write-in-scope.json', ctx), { decision: 'allow' })
  assert.equal(hookLog(ctx.job)[0].target, path.join(ctx.worktree, 'src', 'feature.ts'))
})

test('write outside paths is denied', () => {
  const ctx = makeJob()
  const answer = replay('write-out-of-scope.json', ctx)
  assert.equal(answer.decision, 'deny')
  assert.match(answer.reason, /outside-paths/)
})

test('write outside the worktree is denied', () => {
  const ctx = makeJob({ paths: ['**'] })
  assert.match(replay('write-outside-worktree.json', ctx).reason, /outside-worktree/)
})

test('ticket file is denied even when paths list it', () => {
  const ctx = makeJob({ paths: ['src/**', 'specs/**'] })
  const answer = replay('write-ticket.json', ctx)
  assert.equal(answer.decision, 'deny')
  assert.match(answer.reason, /plan-file/)
})

test('read-only task job denies every write and still allows reads and safe commands', () => {
  const ctx = makeJob({ mode: 'task', readOnly: true, paths: [] })
  assert.match(replay('write-in-scope.json', ctx).reason, /read-only/)
  assert.deepEqual(replay('view-file.json', ctx), { decision: 'allow' })
  assert.deepEqual(replay('run-command-allowed.json', ctx), { decision: 'allow' })
  assert.equal(replay('run-command-claude.json', ctx).decision, 'deny')
})

test('a broken job fails closed for commands and writes, open for reads', () => {
  const ctx = makeJob()
  fs.rmSync(path.join(ctx.job, 'state.json'))
  assert.equal(replay('run-command-allowed.json', ctx).decision, 'deny')
  assert.equal(replay('write-in-scope.json', ctx).decision, 'deny')
  assert.deepEqual(replay('view-file.json', ctx), { decision: 'allow' })
  assert.equal(runHook('pre-tool.mjs', 'not json', ctx).decision, 'deny')
  assert.ok(hookLog(ctx.job).every(e => e.rule === 'error'))
})

test('verifier role: allow and log nothing', () => {
  const ctx = makeJob()
  assert.deepEqual(replay('run-command-claude.json', ctx, { AGY_DELEGATE_ROLE: 'verifier' }), { decision: 'allow' })
  assert.deepEqual(hookLog(ctx.job), [])
})

test('pre-invocation writes the canary once; the verifier role writes none', () => {
  const ctx = makeJob()
  const input = JSON.stringify({ conversationId: 'c1', modelName: 'gemini-3.8-flash-low', invocationNum: 0 })
  assert.deepEqual(runHook('pre-invocation.mjs', input, ctx, { AGY_DELEGATE_ROLE: 'verifier' }), {})
  assert.equal(fs.existsSync(path.join(ctx.job, 'loaded')), false)
  assert.deepEqual(runHook('pre-invocation.mjs', input, ctx), {})
  const first = fs.readFileSync(path.join(ctx.job, 'loaded'), 'utf8')
  assert.equal(JSON.parse(first).agent, 'delegate-implementer')
  runHook('pre-invocation.mjs', input, ctx)
  assert.equal(fs.readFileSync(path.join(ctx.job, 'loaded'), 'utf8'), first)
  assert.deepEqual(hookLog(ctx.job).map(e => e.decision), ['loaded'])
})

const command = (line, state) => decide({ name: 'run_command', args: { CommandLine: line } }, state)
const IMPLEMENT = { mode: 'implement', worktree: '/w', paths: ['src/**'] }
const TASK = { mode: 'task', worktree: '/w', paths: [] }

test('command rules: denied in implement mode', () => {
  const denied = {
    'git commit -m x': 'git-state',
    'git -C /tmp/x push origin HEAD': 'git-state',
    'cd src && git checkout -- file.ts': 'git-state',
    'git branch -D old': 'git-state',
    'git stash': 'git-state',
    'git worktree add ../x': 'git-state',
    'timeout 60 git push': 'git-state',
    'pnpm lint | tee out.txt; git reset --hard': 'git-state',
    'echo "$(git commit -m x)"': 'git-state',
    'FOO=1 claude -p hi': 'ai-cli',
    '/usr/local/bin/claude --version': 'ai-cli',
    'npx @anthropic-ai/claude-code --version': 'ai-cli',
    'sh -c "codex exec hi"': 'ai-cli',
    "bash -lc 'coderabbit review --plain'": 'ai-cli',
    'pnpm exec gemini -p hi': 'ai-cli',
    'env -i PATH=/bin agy -p hi': 'ai-cli',
    'gh pr create --fill': 'gh-write',
    'gh -R o/r issue comment 1 --body x': 'gh-write',
    'gh api -X POST repos/o/r/issues': 'gh-write',
    'gh api --method=DELETE repos/o/r': 'gh-write',
    'gh api repos/o/r/issues -f title=x': 'gh-write',
    'pnpm add lodash': 'dependencies',
    'pnpm --filter web install': 'dependencies',
    'npm i': 'dependencies',
    yarn: 'dependencies',
    'bun update': 'dependencies',
  }
  for (const [line, rule] of Object.entries(denied)) assert.equal(command(line, IMPLEMENT).rule, rule, line)
})

test('command rules: allowed in implement mode', () => {
  const allowed = [
    'git status',
    'git diff --stat origin/main...HEAD',
    'git log --oneline -5',
    'git branch',
    'git show HEAD:src/a.ts',
    'pnpm lint',
    'pnpm run type-check',
    'pnpm --filter web test',
    'npm test',
    'yarn lint',
    'yarn --version',
    'gh pr view 12',
    'gh pr list',
    'gh api repos/o/r/pulls',
    'echo claude',
    'grep -rn "git commit" src',
    'cat README.md',
  ]
  for (const line of allowed) assert.equal(command(line, IMPLEMENT).decision, 'allow', line)
})

test('command rules: task mode keeps only the git and AI CLI rules', () => {
  assert.equal(command('git commit -m x', TASK).rule, 'git-state')
  assert.equal(command('claude --version', TASK).rule, 'ai-cli')
  assert.equal(command('pnpm add lodash', TASK).decision, 'allow')
  assert.equal(command('gh pr comment 1 --body x', TASK).decision, 'allow')
})

test('write rules: plain task mode allows writes anywhere', () => {
  const call = { name: 'write_to_file', args: { TargetFile: '/elsewhere/x.txt' } }
  assert.equal(decide(call, TASK).decision, 'allow')
})

test('write rules: a write tool without a target path is denied when rules apply', () => {
  const call = { name: 'sed_file', args: {} }
  assert.equal(decide(call, IMPLEMENT).rule, 'no-target')
  assert.equal(decide(call, { ...TASK, readOnly: true }).rule, 'read-only')
  assert.equal(decide(call, TASK).decision, 'allow')
})

// Regressions from the review of the first version.

const write = (ctx, target, state = {}) =>
  decide(
    { name: 'write_to_file', args: { TargetFile: target } },
    { mode: 'implement', worktree: ctx.worktree, paths: ['src/**'], ...state },
  )

test('symlinks: a dangling link out of the worktree is denied', () => {
  const ctx = makeJob()
  fs.symlinkSync(path.join(ctx.root, 'outside', 'new.ts'), path.join(ctx.worktree, 'src', 'new.ts'))
  assert.equal(write(ctx, path.join(ctx.worktree, 'src', 'new.ts')).rule, 'outside-worktree')
  assert.equal(write(ctx, 'src/new.ts').rule, 'outside-worktree')
})

test('symlinks: `..` after a linked directory follows the link first', () => {
  const ctx = makeJob()
  fs.mkdirSync(path.join(ctx.root, 'outside', 'sub'), { recursive: true })
  fs.symlinkSync(path.join(ctx.root, 'outside', 'sub'), path.join(ctx.worktree, 'src', 'link'))
  assert.equal(write(ctx, `${ctx.worktree}/src/link/../escape.ts`).rule, 'outside-worktree')
  assert.equal(write(ctx, `${ctx.worktree}/src/link/x.ts`).rule, 'outside-worktree')
})

test('symlinks: a link that stays inside paths is allowed, a loop is denied', () => {
  const ctx = makeJob()
  fs.symlinkSync('feature.ts', path.join(ctx.worktree, 'src', 'alias.ts'))
  assert.equal(write(ctx, 'src/alias.ts').decision, 'allow')
  fs.symlinkSync('loop', path.join(ctx.worktree, 'src', 'loop'))
  assert.equal(write(ctx, 'src/loop').rule, 'unresolved-target')
})

test('command rules: shell keywords and wrapper options with values', () => {
  const denied = {
    'if true; then git commit -m x; fi': 'git-state',
    'for f in a b; do git push; done': 'git-state',
    'while true; do claude; done': 'ai-cli',
    '{ git push; }': 'git-state',
    '! git push': 'git-state',
    'env -u DEBUG claude --version': 'ai-cli',
    'env -C /tmp -u X FOO=1 codex exec hi': 'ai-cli',
    'env -S "claude --version"': 'ai-cli',
    'sudo -u bob git push': 'git-state',
    'xargs -I {} git commit -m {}': 'git-state',
    'nice -n 5 git push': 'git-state',
    'timeout -s KILL 60 git push': 'git-state',
    'exec -a name git push': 'git-state',
    'npx -p @scope/tool claude --version': 'ai-cli',
    'npx -c "git push"': 'git-state',
    'pnpm dlx --package=x claude': 'ai-cli',
    'bunx -p x gemini': 'ai-cli',
  }
  for (const [line, rule] of Object.entries(denied)) assert.equal(command(line, IMPLEMENT).rule, rule, line)
  for (const line of ['echo if then git', 'if [ -f x ]; then echo ok; fi', 'command -v git', 'env -u DEBUG node -v'])
    assert.equal(command(line, IMPLEMENT).decision, 'allow', line)
})

test('command rules: package manager options per tool', () => {
  for (const line of ['pnpm -w install', 'pnpm -w add lodash', 'npm --workspace x install', 'npm -w x i', 'yarn workspace web add lodash'])
    assert.equal(command(line, IMPLEMENT).rule, 'dependencies', line)
  for (const line of ['pnpm -w lint', 'npm -w web run build', 'yarn workspace web build'])
    assert.equal(command(line, IMPLEMENT).decision, 'allow', line)
})

test('plan files match without regard to case', () => {
  const ctx = makeJob({ paths: ['**'] })
  for (const name of ['spec.md', 'map.md', 'Spec.MD', 'docs/feature-TICKET.md', 'ticket.md'])
    assert.equal(write(ctx, name, { paths: ['**'] }).rule, 'plan-file', name)
  assert.equal(write(ctx, 'docs/tickets.md', { paths: ['**'] }).decision, 'allow')
})

test('the inlined glob matcher agrees with jobs.mjs', () => {
  for (const glob of ['src/**', '**/*.ts', 'apps/*/src/**/*.tsx', 'a?b.md', 'docs/x (1).md', '**'])
    assert.equal(globToRegExp(glob).source, jobsGlob(glob).source, glob)
})
