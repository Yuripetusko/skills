// Run with: node --test plugins/agy-delegate/skills/using-agy-from-claude/scripts/test/
// Every test builds its own git repo in a temp dir, so nothing here depends on the checkout it runs in.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { applicableRules, isGeneratedPath, numberedDiff, parseDiff } from '../diff.mjs'

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const JOBS = path.join(SCRIPTS, 'jobs.mjs')
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'diff-test-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

let counter = 0
const fresh = name => {
  const dir = path.join(scratch, `${name}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  DELEGATE_JOBS_DIR: path.join(scratch, 'jobs-root'),
}
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: baseEnv,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const write = (repo, file, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
}
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
const diffCli = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [JOBS, 'diff', ...args], { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' })
const readOut = (out, name) => fs.readFileSync(path.join(out, name), 'utf8')
const readJson = (out, name) => JSON.parse(readOut(out, name))

// A small monorepo shape: a root AGENTS.md over 24,000 bytes, one package with its own AGENTS.md,
// one without. Returns the repo path with the base commit made.
function makeRepo() {
  const repo = fresh('repo')
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, 'package.json', '{"name":"root-pkg"}\n')
  write(repo, 'AGENTS.md', 'rule\n'.repeat(5000))
  write(repo, 'packages/app/package.json', '{"name":"@fixture/app"}\n')
  write(repo, 'packages/app/AGENTS.md', 'app rules\n')
  write(repo, 'packages/app/src/a.ts', lines(40))
  write(repo, 'packages/app/src/old-name.ts', lines(40, 'export const value'))
  write(repo, 'packages/app/src/gone.ts', lines(5))
  write(repo, 'packages/lib/package.json', '{"name":"@fixture/lib"}\n')
  write(repo, 'packages/lib/src/b.ts', lines(10))
  write(repo, 'docs/same.md', lines(12))
  write(repo, 'docs/notes.md', lines(12))
  write(repo, 'pnpm-lock.yaml', lines(30, 'dep'))
  fs.writeFileSync(path.join(repo, 'assets.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}

// The edits an agent might leave in a worktree: all of them uncommitted.
function editWorktree(repo) {
  fs.appendFileSync(path.join(repo, 'packages/app/src/a.ts'), 'added line\n')
  git(repo, 'rm', '-q', 'packages/app/src/gone.ts')
  git(repo, 'mv', 'packages/app/src/old-name.ts', 'packages/app/src/new-name.ts')
  fs.appendFileSync(path.join(repo, 'packages/app/src/new-name.ts'), 'export const extra = 1\n')
  git(repo, 'mv', 'docs/same.md', 'docs/moved.md')
  fs.appendFileSync(path.join(repo, 'pnpm-lock.yaml'), 'dep 31\n')
  fs.writeFileSync(path.join(repo, 'assets.bin'), Buffer.from([0, 9, 9, 0, 255, 254]))
  write(repo, 'packages/lib/src/fresh.ts', 'export const fresh = 1\n')
  write(repo, 'docs/my notes.md', 'spaced name\n')
}

describe('parseDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@ function f',
    ' keep',
    '--- starts with dashes',
    '+added',
    ' tail',
    'diff --git a/old.md b/new.md',
    'similarity index 100%',
    'rename from old.md',
    'rename to new.md',
    'diff --git a/img.png b/img.png',
    'new file mode 100644',
    'index 0000000..abc',
    'Binary files /dev/null and b/img.png differ',
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    'index 0000000..e69de29',
    'diff --git a/mode.sh b/mode.sh',
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n')
  const files = parseDiff(diff)

  test('numbers lines on both sides and counts changes', () => {
    const a = files.get('src/a.ts')
    assert.equal(a.additions, 1)
    assert.equal(a.deletions, 1)
    assert.deepEqual(
      a.hunks[0].lines.map(l => [l.left, l.right]),
      [[1, 1], [2, null], [null, 2], [3, 3]],
    )
  })
  test('keeps entries that have no hunks', () => {
    assert.equal(files.get('new.md').status, 'renamed')
    assert.equal(files.get('new.md').oldPath, 'old.md')
    assert.equal(files.get('img.png').status, 'added')
    assert.equal(files.get('img.png').binary, true)
    assert.equal(files.get('empty.txt').status, 'added')
    assert.equal(files.get('mode.sh').status, 'modified')
  })
  test('flags generated and lock files', () => {
    for (const p of ['pnpm-lock.yaml', 'apps/web/yarn.lock', 'a/dist/x.js', 'x.min.js', 'src/__snapshots__/a.snap'])
      assert.equal(isGeneratedPath(p), true, p)
    assert.equal(isGeneratedPath('src/app.ts'), false)
  })
  test('numberedDiff leaves hunks out for generated files and names them in a footer', () => {
    const text = numberedDiff([{ ...files.get('src/a.ts'), generated: false }, { path: 'pnpm-lock.yaml', generated: true }])
    assert.match(text, /### src\/a\.ts \(\+1 -1\)/)
    assert.match(text, /\n\s+L2\s+\|-/)
    assert.match(text, /Not shown .*: pnpm-lock\.yaml/)
  })
})

describe('applicableRules', () => {
  test('lists the root file and every AGENTS.md on the way up from a changed file', () => {
    const repo = fresh('rules')
    write(repo, 'AGENTS.md', 'root')
    write(repo, 'apps/AGENTS.md', 'apps')
    write(repo, 'apps/web/AGENTS.md', 'web')
    write(repo, 'apps/other/AGENTS.md', 'other')
    const rules = applicableRules(repo, ['apps/web/src/x.ts', 'apps/web/src/y.ts'])
    assert.deepEqual(rules.map(r => r.path), ['AGENTS.md', 'apps/AGENTS.md', 'apps/web/AGENTS.md'])
  })
  test('flags a file over 24,000 bytes and not one at the limit', () => {
    const repo = fresh('rules-size')
    write(repo, 'AGENTS.md', 'x'.repeat(24001))
    write(repo, 'a/AGENTS.md', 'x'.repeat(24000))
    const rules = applicableRules(repo, ['a/f.ts'])
    assert.deepEqual(rules.map(r => [r.path, r.bytes, r.over24kb]), [['AGENTS.md', 24001, true], ['a/AGENTS.md', 24000, false]])
  })
})

describe('delegate-jobs diff on a worktree', () => {
  const repo = makeRepo()
  editWorktree(repo)
  const out = path.join(scratch, 'out-main')
  const result = diffCli(repo, ['--base', 'HEAD', '--out', out])

  test('exits 0 and writes the four files', () => {
    assert.equal(result.status, 0, result.stderr)
    for (const name of ['diff.patch', 'diff-numbered.txt', 'files.json', 'rules.json']) assert.ok(fs.existsSync(path.join(out, name)), name)
  })
  test('files.json has status, generated flag and owning package for each change', () => {
    const files = Object.fromEntries(readJson(out, 'files.json').map(f => [f.path, f]))
    assert.equal(files['packages/app/src/a.ts'].status, 'modified')
    assert.equal(files['packages/app/src/a.ts'].package, 'packages/app')
    assert.equal(files['packages/app/src/a.ts'].packageName, '@fixture/app')
    assert.equal(files['packages/app/src/gone.ts'].status, 'deleted')
    assert.equal(files['packages/app/src/new-name.ts'].status, 'renamed')
    assert.equal(files['packages/app/src/new-name.ts'].oldPath, 'packages/app/src/old-name.ts')
    assert.equal(files['docs/moved.md'].status, 'renamed')
    assert.equal(files['docs/moved.md'].additions, 0)
    assert.equal(files['assets.bin'].binary, true)
    assert.equal(files['pnpm-lock.yaml'].generated, true)
    assert.equal(files['packages/app/src/a.ts'].generated, false)
    assert.equal(files['docs/notes.md'], undefined)
  })
  test('untracked files are included, spaces in names too, and the index stays untouched', () => {
    const files = Object.fromEntries(readJson(out, 'files.json').map(f => [f.path, f]))
    assert.equal(files['packages/lib/src/fresh.ts'].untracked, true)
    assert.equal(files['packages/lib/src/fresh.ts'].status, 'added')
    assert.equal(files['packages/lib/src/fresh.ts'].package, 'packages/lib')
    assert.equal(files['docs/my notes.md'].additions, 1)
    assert.match(git(repo, 'status', '--porcelain'), /\?\? packages\/lib\/src\/fresh\.ts/)
  })
  test('the numbered diff has L/R numbers, skips the lock file and keeps it in files.json', () => {
    const numbered = readOut(out, 'diff-numbered.txt')
    assert.match(numbered, /### packages\/app\/src\/a\.ts \(\+1 -0\)/)
    assert.match(numbered, /\n\s+R41 \|\+added line/)
    assert.match(numbered, /### packages\/app\/src\/new-name\.ts .*\[renamed from packages\/app\/src\/old-name\.ts\]/)
    assert.match(numbered, /### assets\.bin .*\[binary\]/)
    assert.doesNotMatch(numbered, /dep 31/)
    assert.match(numbered, /Not shown .*pnpm-lock\.yaml/)
    assert.match(readOut(out, 'diff.patch'), /dep 31/)
  })
  test('rules.json lists the root and package AGENTS.md with sizes and the 24 KB flag', () => {
    const rules = readJson(out, 'rules.json')
    assert.deepEqual(rules, [
      { path: 'AGENTS.md', bytes: 25000, over24kb: true },
      { path: 'packages/app/AGENTS.md', bytes: 10, over24kb: false },
    ])
  })
  test('--json prints the whole result', () => {
    const json = JSON.parse(diffCli(repo, ['--base', 'HEAD', '--out', out, '--json']).stdout)
    assert.equal(json.target, 'worktree')
    assert.equal(json.out, fs.realpathSync(out))
    assert.equal(json.rules.length, 2)
    assert.ok(json.totals.generated >= 1)
  })
  test('the text summary says when a rules file is over the limit', () => {
    assert.match(result.stdout, /AGENTS\.md {2}25000 bytes {2}OVER 24000/)
  })
  test('an untracked file over 1 MB is listed but not diffed', () => {
    const big = makeRepo()
    write(big, 'big.log', 'x'.repeat(1_100_000))
    const bigOut = path.join(scratch, 'out-big')
    assert.equal(diffCli(big, ['--base', 'HEAD', '--out', bigOut]).status, 0)
    assert.deepEqual(
      readJson(bigOut, 'files.json').map(f => [f.path, f.untracked, f.skipped]),
      [['big.log', true, 'over 1 MB, not diffed']],
    )
    assert.equal(readOut(bigOut, 'diff.patch'), '')
  })
  test('output kept inside the checkout is not picked up as untracked on the next run', () => {
    const inside = path.join(repo, '.diff-out')
    diffCli(repo, ['--base', 'HEAD', '--out', inside])
    diffCli(repo, ['--base', 'HEAD', '--out', inside])
    assert.equal(readJson(inside, 'files.json').some(f => f.path.startsWith('.diff-out/')), false)
  })
})

describe('base selection', () => {
  test('without --base or origin/main it diffs against main, here the same commit as HEAD', () => {
    const repo = makeRepo()
    write(repo, 'packages/lib/src/b.ts', lines(11))
    const out = path.join(scratch, 'out-main-fallback')
    const r = JSON.parse(diffCli(repo, ['--out', out, '--json']).stdout)
    assert.equal(r.base.source, 'merge-base with main')
    assert.deepEqual(readJson(out, 'files.json').map(f => f.path), ['packages/lib/src/b.ts'])
  })
  test('with neither origin/main nor main it falls back to HEAD', () => {
    const repo = makeRepo()
    git(repo, 'branch', '-m', 'trunk')
    write(repo, 'packages/lib/src/b.ts', lines(11))
    const r = JSON.parse(diffCli(repo, ['--out', path.join(scratch, 'out-head'), '--json']).stdout)
    assert.equal(r.base.source, 'HEAD (no origin/main or main)')
  })
  test('uses the merge-base with origin/main when that ref exists', () => {
    const repo = makeRepo()
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', base)
    write(repo, 'docs/committed.md', 'committed\n')
    git(repo, 'add', 'docs/committed.md')
    git(repo, 'commit', '-q', '-m', 'feature')
    write(repo, 'packages/lib/src/b.ts', lines(11))
    const out = path.join(scratch, 'out-originmain')
    const r = JSON.parse(diffCli(repo, ['--out', out, '--json']).stdout)
    assert.equal(r.base.source, 'merge-base with origin/main')
    assert.equal(r.base.sha, base)
    assert.deepEqual(readJson(out, 'files.json').map(f => f.path).sort(), ['docs/committed.md', 'packages/lib/src/b.ts'])
  })
  test('--base takes the merge-base with HEAD, so a moved branch tip is not part of the change', () => {
    const repo = makeRepo()
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', '-b', 'side')
    write(repo, 'docs/side.md', 'side\n')
    git(repo, 'add', 'docs/side.md')
    git(repo, 'commit', '-q', '-m', 'side work')
    git(repo, 'checkout', '-q', 'main')
    write(repo, 'docs/mine.md', 'mine\n')
    git(repo, 'add', 'docs/mine.md')
    git(repo, 'commit', '-q', '-m', 'my work')
    const out = path.join(scratch, 'out-mergebase')
    const r = JSON.parse(diffCli(repo, ['--base', 'side', '--out', out, '--json']).stdout)
    assert.equal(r.base.sha, base)
    assert.deepEqual(readJson(out, 'files.json').map(f => f.path), ['docs/mine.md'])
  })
})

describe('delegate-jobs diff with --job', () => {
  test('diffs against the commit the job started from and writes to the job dir by default', () => {
    const repo = makeRepo()
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'))
    write(repo, 'docs/earlier.md', 'earlier work on the branch\n')
    git(repo, 'add', 'docs/earlier.md')
    git(repo, 'commit', '-q', '-m', 'earlier work')
    const created = spawnSync(process.execPath, [JOBS, 'new', 'agy'], { cwd: repo, env: baseEnv, encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr)
    const job = created.stdout.trim()
    write(repo, 'packages/lib/src/b.ts', lines(12))
    const elsewhere = fresh('elsewhere')
    const r = diffCli(elsewhere, ['--job', path.basename(job), '--json'])
    assert.equal(r.status, 0, r.stderr)
    const json = JSON.parse(r.stdout)
    assert.equal(json.base.source, 'job start')
    assert.equal(json.out, fs.realpathSync(path.join(job, 'diff')))
    assert.deepEqual(readJson(path.join(job, 'diff'), 'files.json').map(f => f.path), ['packages/lib/src/b.ts'])
  })
  test('the stable copy of jobs.mjs finds the diff module `new` copied next to it', () => {
    const repo = makeRepo()
    const root = path.join(scratch, 'stable-root')
    const env = { ...baseEnv, DELEGATE_JOBS_DIR: root }
    assert.equal(spawnSync(process.execPath, [JOBS, 'new', 'agy'], { cwd: repo, env, encoding: 'utf8' }).status, 0)
    assert.ok(fs.existsSync(path.join(root, 'diff.mjs')))
    write(repo, 'packages/lib/src/b.ts', lines(13))
    const out = path.join(scratch, 'out-stable')
    const r = spawnSync(process.execPath, [path.join(root, 'jobs.mjs'), 'diff', '--base', 'HEAD', '--out', out], { cwd: repo, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readJson(out, 'files.json').map(f => f.path), ['packages/lib/src/b.ts'])
  })
  test('a stable copy without the diff module says how to refresh it', () => {
    const repo = makeRepo()
    const root = path.join(scratch, 'old-root')
    fs.mkdirSync(root, { recursive: true })
    fs.copyFileSync(JOBS, path.join(root, 'jobs.mjs'))
    const r = spawnSync(process.execPath, [path.join(root, 'jobs.mjs'), 'diff', '--base', 'HEAD'], { cwd: repo, env: { ...baseEnv, DELEGATE_JOBS_DIR: root }, encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /diff\.mjs is missing/)
  })
})

describe('install checks', () => {
  const emptyDir = fresh('empty-path')
  // A PATH with only git on it: a wrapper script, so the real binary's location does not matter.
  const gitOnly = fresh('git-only')
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  fs.writeFileSync(path.join(gitOnly, 'git'), `#!/bin/sh\nexec "${realGit}" "$@"\n`, { mode: 0o755 })

  test('a missing git names git and exits non-zero', () => {
    const r = diffCli(os.tmpdir(), ['--base', 'HEAD'], { PATH: emptyDir })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /git is not installed/)
  })
  test('outside a git checkout it says so', () => {
    const r = diffCli(fresh('plain'), ['--base', 'HEAD'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /not inside a git checkout/)
  })
  test('a base ref that does not resolve is named', () => {
    const r = diffCli(makeRepo(), ['--base', 'no-such-ref'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /base ref "no-such-ref" does not resolve/)
  })
  test('a repository with no commits says so', () => {
    const repo = fresh('no-commits')
    git(repo, 'init', '-q', '-b', 'main')
    const r = diffCli(repo, [])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /no commits/)
  })
  test('--pr without gh names gh and exits non-zero', () => {
    const r = diffCli(makeRepo(), ['--pr', '1'], { PATH: gitOnly })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /gh \(the GitHub CLI\) is not installed/)
  })
  test('--pr with gh signed out says to sign in', () => {
    const bin = fresh('gh-signed-out')
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1" = auth ] && { echo "You are not logged in" >&2; exit 1; }\nexit 0\n', { mode: 0o755 })
    const r = diffCli(makeRepo(), ['--pr', '1'], { PATH: `${bin}:${gitOnly}` })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /gh is not signed in/)
  })
  test('--pr with a signed-in gh reads the PR diff', () => {
    const bin = fresh('gh-ok')
    const patch = path.join(bin, 'pr.patch')
    fs.writeFileSync(
      patch,
      ['diff --git a/packages/lib/src/b.ts b/packages/lib/src/b.ts', '--- a/packages/lib/src/b.ts', '+++ b/packages/lib/src/b.ts', '@@ -1,2 +1,3 @@', ' line 1', '+inserted', ' line 2', ''].join('\n'),
    )
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1" = pr ] && [ "$2" = diff ] && [ "$3" = 7 ] && exec /bin/cat "${patch}"\nexit 0\n`, { mode: 0o755 })
    const out = path.join(scratch, 'out-pr')
    const r = diffCli(makeRepo(), ['--pr', '7', '--out', out, '--json'], { PATH: `${bin}:${gitOnly}` })
    assert.equal(r.status, 0, r.stderr)
    const json = JSON.parse(r.stdout)
    assert.equal(json.target, 'pr')
    assert.equal(json.base, null)
    assert.deepEqual(readJson(out, 'files.json').map(f => [f.path, f.additions, f.package]), [['packages/lib/src/b.ts', 1, 'packages/lib']])
    assert.deepEqual(readJson(out, 'rules.json').map(r => r.path), ['AGENTS.md'])
  })
  test('--pr and --base together are refused', () => {
    const r = diffCli(makeRepo(), ['--pr', '7', '--base', 'HEAD'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /cannot be combined/)
  })
  test('bad arguments get a message and a non-zero exit', () => {
    const repo = makeRepo()
    assert.match(diffCli(repo, ['--pr', 'abc']).stderr, /--pr needs a PR number/)
    assert.match(diffCli(repo, ['--nope']).stderr, /unknown argument/)
    assert.match(diffCli(repo, ['--base']).stderr, /--base needs a value/)
  })
})
