// Tests for gate.mjs: parsers and delta on recorded output, and the CLI on a temp repo with a fake tool.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { delta, listUnits, parseOxlintJson, parseTsc, resolveScope } from '../gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const JOBS = path.join(here, '..', 'jobs.mjs')
const fixture = name => fs.readFileSync(path.join(here, 'fixtures', 'gate', name), 'utf8')
const ROOT = '/work/repo'

describe('parsers', () => {
  test('oxlint JSON: package-relative files, rules, and the code-less unused directive', () => {
    const f = parseOxlintJson(fixture('lint-before.json'), { root: ROOT, cwd: 'packages/a' })
    assert.equal(f.length, 6)
    assert.deepEqual(f[0], {
      tool: 'lint',
      rule: 'typescript(no-unsafe-assignment)',
      file: 'packages/a/src/x.ts',
      line: 10,
      column: 7,
      severity: 'warning',
      message: 'Unsafe assignment of an any value.',
    })
    assert.equal(f[4].rule, 'unused-disable-directive')
  })

  test('oxlint: output that is not JSON throws', () => {
    assert.throws(() => parseOxlintJson(fixture('lint-crash.txt'), { root: ROOT, cwd: '.' }), /not JSON/)
    assert.throws(() => parseOxlintJson('{"files": 3}', { root: ROOT, cwd: '.' }), /no "diagnostics"/)
  })

  test('tsc: multiline and file-less diagnostics', () => {
    const f = parseTsc(fixture('tsc-before.txt'), { root: ROOT, cwd: '.' })
    assert.equal(f.length, 3)
    assert.equal(f[0].file, 'packages/a/src/x.ts')
    assert.equal(f[0].rule, 'TS2322')
    assert.equal(f[0].message.split('\n').length, 3)
    assert.equal(f[0].message.split('\n')[2], "Type 'string' is not assignable to type 'number'.")
    assert.deepEqual([f[2].file, f[2].rule, f[2].line], [null, 'TS2318', null])
  })

  test('tsc: a missing project or a stray line means the snapshot did not run', () => {
    const missing = fixture('tsc-missing-project.txt').replace('<ROOT>', ROOT)
    assert.throws(() => parseTsc(missing, { root: ROOT, cwd: '.' }), /could not check a project/)
    assert.throws(() => parseTsc(fixture('tsc-garbage.txt'), { root: ROOT, cwd: '.' }), /unparseable/)
  })

  test('tsc: an unreadable or unbuilt project fails the snapshot even with a file location', () => {
    for (const name of ['tsc-unreadable-config.txt', 'tsc-unbuilt-reference.txt'])
      assert.throws(() => parseTsc(fixture(name).replaceAll('<ROOT>', ROOT), { root: ROOT, cwd: '.' }), /could not check a project/, name)
  })

  test('tsc: the worktree path is stripped from messages', () => {
    const [f] = parseTsc(`error TS2307: Cannot find module '${ROOT}/packages/a/gen.js'.`, { root: ROOT, cwd: '.' })
    assert.equal(f.message, "Cannot find module 'packages/a/gen.js'.")
  })
})

describe('delta', () => {
  const lint = name => parseOxlintJson(fixture(name), { root: ROOT, cwd: 'packages/a' })

  test('added, removed, moved-line, duplicate and renamed findings', () => {
    const renames = { 'packages/a/src/old-name.ts': 'packages/a/src/new-name.ts' }
    const d = delta(lint('lint-before.json'), lint('lint-after.json'), renames)
    // Added: the new `any` in x.ts, and the third duplicate in dup.ts, reported at its new line.
    assert.deepEqual(d.added.map(f => `${f.rule} ${f.file}:${f.line}`), [
      'typescript(no-explicit-any) packages/a/src/dup.ts:30',
      'typescript(no-explicit-any) packages/a/src/x.ts:3',
    ])
    // Removed: the optional chain. The moved no-unsafe-assignment and the renamed file pair up.
    assert.deepEqual(d.removed.map(f => f.rule), ['typescript(no-unnecessary-condition)'])
    assert.deepEqual(d.countsByRule, {
      'typescript(no-explicit-any)': { added: 2, removed: 0 },
      'typescript(no-unnecessary-condition)': { added: 0, removed: 1 },
    })
  })

  test('without the rename map a renamed file counts as added and removed', () => {
    const d = delta(lint('lint-before.json'), lint('lint-after.json'))
    assert.equal(d.added.filter(f => f.file.endsWith('new-name.ts')).length, 1)
    assert.equal(d.removed.filter(f => f.file.endsWith('old-name.ts')).length, 1)
  })

  test('tsc: a moved multiline error is not new, a new one is', () => {
    const b = parseTsc(fixture('tsc-before.txt'), { root: ROOT, cwd: '.' })
    const a = parseTsc(fixture('tsc-after.txt'), { root: ROOT, cwd: '.' })
    const d = delta(b, a)
    assert.deepEqual(d.added.map(f => `${f.rule} ${f.line}`), ['TS2769 22'])
    assert.deepEqual(d.removed.map(f => f.rule), ['TS2339'])
  })
})

// A temp monorepo: packages/a <- packages/b <- apps/web, an unrelated apps/docs, a config-only
// package, and tools/ as a type-check-only project.
const FAKE_TOOL = `import fs from 'node:fs'
import path from 'node:path'
const [tool, unit] = process.argv.slice(2)
const state = process.env.FAKE_GATE_STATE
const name = tool === 'lint' ? 'lint-' + unit.replaceAll('/', '_') : tool
const read = f => (fs.existsSync(path.join(state, f)) ? fs.readFileSync(path.join(state, f), 'utf8') : null)
const touch = read(name + '.touch')
if (touch) fs.writeFileSync(path.join(process.env.FAKE_GATE_ROOT, touch), 'export {}')
if (read(name + '.hang') !== null) setInterval(() => {}, 1000)
else {
  process.stdout.write((read(name + '.out') ?? read(tool + '-default.out') ?? '').replaceAll('<ROOT>', process.env.FAKE_GATE_ROOT))
  process.exitCode = Number(read(name + '.status') ?? 0)
}
`

function makeRepo(tmp) {
  const repo = path.join(tmp, 'repo')
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
  }
  const pkg = (dir, name, deps = {}, lint = true) =>
    put(`${dir}/package.json`, JSON.stringify({ name, dependencies: deps, scripts: lint ? { lint: 'oxlint' } : {} }))
  put('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*', 'packages/*'] }))
  put('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  put('README.md', '# repo\n')
  put('.gitignore', 'dist/\n')
  pkg('packages/a', '@x/a')
  pkg('packages/b', '@x/b', { '@x/a': 'workspace:*' })
  pkg('packages/config', '@x/config', {}, false)
  pkg('apps/web', '@x/web', { '@x/b': 'workspace:*' })
  pkg('apps/docs', '@x/docs')
  for (const d of ['packages/a', 'packages/b', 'apps/web', 'apps/docs', 'tools']) put(`${d}/tsconfig.json`, '{}\n')
  put('packages/a/src/x.ts', 'export const x = 1\n')
  put('packages/a/src/old-name.ts', 'const tmp = 1\nexport const keep = "a fairly long line so git sees a rename"\n')
  put('packages/b/src/y.ts', 'export const y = 2\n')
  put('apps/web/src/page.ts', 'export const page = 3\n')
  put('apps/docs/src/index.ts', 'export const docs = 4\n')
  put('tools/run.mts', 'export {}\n')
  const g = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['add', '-A'])
  g(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'])
  return repo
}

describe('scope', () => {
  let tmp, repo, units
  const config = { wholeRepo: ['package.json', 'pnpm-lock.yaml'], extraProjects: ['tools'], links: [{ from: 'apps/docs', to: ['apps/web'] }] }
  const files = () => spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  const scope = paths => resolveScope({ root: repo, config, units, paths, files: files() })
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-scope-'))
    repo = makeRepo(tmp)
    units = listUnits(repo, config)
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  test('units come from the workspace globs plus extra projects', () => {
    assert.deepEqual([...units.keys()].sort(), ['apps/docs', 'apps/web', 'packages/a', 'packages/b', 'packages/config', 'tools'])
  })
  test('a package glob adds its transitive dependents', () => {
    const s = scope(['packages/a/src/**'])
    assert.deepEqual([s.whole, s.seeds, s.units], [false, ['packages/a'], ['apps/web', 'packages/a', 'packages/b']])
  })
  test('a file that does not exist yet maps through its directory', () => {
    assert.deepEqual(scope(['packages/b/src/new-file.ts']).units, ['apps/web', 'packages/b'])
  })
  test('extra links and extra projects', () => {
    assert.deepEqual(scope(['apps/docs']).units, ['apps/docs', 'apps/web'])
    assert.deepEqual(scope(['tools/*.mts']).units, ['tools'])
  })
  test('the lockfile, root config, or no paths widen to the whole repo', () => {
    assert.equal(scope(['packages/a/**', 'pnpm-lock.yaml']).whole, true)
    assert.equal(scope(null).whole, true)
    assert.equal(scope([]).whole, true)
  })
  test('files outside every unit add nothing', () => {
    assert.deepEqual(scope(['README.md']).units, [])
  })
})

describe('jobs.mjs gate', () => {
  let tmp, repo, jobsDir, state, configFile, job, gitState
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout
  const gitSnapshot = () => ({
    index: createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex'),
    refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
    stash: git(['stash', 'list']),
  })
  const env = () => ({ ...process.env, DELEGATE_JOBS_DIR: jobsDir, FAKE_GATE_STATE: state, FAKE_GATE_ROOT: repo })
  const run = (args, script = JOBS) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env: env(), encoding: 'utf8' })
  const stage = (name, text) => fs.writeFileSync(path.join(state, name), text)
  const unstage = () => {
    for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f))
    stage('lint-default.out', '{"diagnostics": []}')
  }
  const writeConfig = (overrides = {}) => {
    const fake = path.join(tmp, 'fake-tool.mjs')
    fs.writeFileSync(fake, FAKE_TOOL)
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        wholeRepo: ['package.json', 'pnpm-lock.yaml'],
        extraProjects: ['tools'],
        lint: { command: ['node', fake, 'lint', '{dir}'], cwd: '{dir}', parser: 'oxlint-json', script: 'lint', concurrency: 2 },
        typecheck: { command: ['node', fake, 'typecheck', '{projects}'], parser: 'tsc' },
        ...overrides,
      }),
    )
  }
  const newJob = paths => {
    const r = run(['new', 'agy', '--label', 'gate test'])
    assert.equal(r.status, 0, r.stderr)
    const dir = r.stdout.trim()
    fs.writeFileSync(path.join(dir, 'brief.md'), `paths: ${paths}\ncommit: test\n\nDo the thing.\n`)
    return dir
  }
  const edit = (file, text) => fs.writeFileSync(path.join(repo, file), text)
  const reset = () => {
    spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo })
    spawnSync('git', ['clean', '-qfd'], { cwd: repo })
  }

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cli-')))
    repo = makeRepo(tmp)
    jobsDir = path.join(tmp, 'jobs')
    state = path.join(tmp, 'state')
    configFile = path.join(tmp, 'gate.json')
    fs.mkdirSync(state)
    writeConfig()
    unstage()
    stage('lint-packages_a.out', fixture('lint-before.json'))
    stage('typecheck.out', fixture('tsc-before.txt'))
    stage('typecheck.status', '2')
    job = newJob('packages/a/src/**')
    gitState = gitSnapshot()
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  test('baseline records the scope and the command list', () => {
    const r = run(['gate', 'baseline', '--job', job, '--gate-config', configFile])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE BASELINE: 9 finding\(s\) from 4 command\(s\)/)
    const b = JSON.parse(fs.readFileSync(path.join(job, 'gate', 'baseline.json'), 'utf8'))
    assert.deepEqual(b.plan.map(c => c.id), ['typecheck', 'lint:apps/web', 'lint:packages/a', 'lint:packages/b'])
    assert.deepEqual(b.plan[0].argv.slice(-3), ['apps/web', 'packages/a', 'packages/b'])
    assert.ok(b.commands.every(c => typeof c.durationMs === 'number' && 'stderrTail' in c))
  })

  test('an untouched check is clean', () => {
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE OK: 0 added, 0 removed · round 1/)
    assert.ok(fs.existsSync(path.join(job, 'gate', 'after-1.json')))
    assert.ok(fs.existsSync(path.join(job, 'gate', 'delta-1.json')))
  })

  test('snapshots leave git status, refs, stash and the real index alone', () => {
    assert.deepEqual(gitSnapshot(), gitState)
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '')
  })

  test('new findings fail with exit 1 and are listed by rule and file', () => {
    edit('packages/a/src/x.ts', 'export const x: any = 1\n')
    fs.renameSync(path.join(repo, 'packages/a/src/old-name.ts'), path.join(repo, 'packages/a/src/new-name.ts'))
    stage('lint-packages_a.out', fixture('lint-after.json'))
    stage('typecheck.out', fixture('tsc-after.txt'))
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE FAILED: 3 added, 2 removed · round 2/)
    assert.match(r.stdout, /\+ typescript\(no-explicit-any\) {2}packages\/a\/src\/x\.ts:3:22/)
    assert.match(r.stdout, /\+ TS2769 {2}packages\/a\/src\/x\.ts:22:9 {2}No overload matches this call\./)
    const d = JSON.parse(fs.readFileSync(path.join(job, 'gate', 'delta-2.json'), 'utf8'))
    assert.deepEqual(d.renames, { 'packages/a/src/old-name.ts': 'packages/a/src/new-name.ts' })
    assert.equal(d.exitCode, 1)
    // The snapshot of the edited tree exists only as unreachable objects, which git gc prunes.
    assert.equal(gitSnapshot().refs, gitState.refs)
    assert.match(git(['fsck', '--unreachable', '--no-reflogs']), /unreachable tree/)
  })

  test('a changed file outside the baseline scope fails the check', () => {
    stage('lint-packages_a.out', fixture('lint-before.json'))
    stage('typecheck.out', fixture('tsc-before.txt'))
    reset()
    edit('apps/docs/src/index.ts', 'export const docs = 5\n')
    edit('README.md', '# changed\n')
    fs.mkdirSync(path.join(repo, 'lib'))
    edit('lib/util.ts', 'export const util = 1\n')
    const r = run(['gate', 'check', '--job', job, '--round', '7'])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE FAILED: 0 added, 0 removed, 2 file\(s\) outside baseline scope · round 7/)
    assert.match(r.stdout, /outside baseline scope: apps\/docs\/src\/index\.ts \(apps\/docs is not in the baseline scope\)/)
    assert.match(r.stdout, /outside baseline scope: lib\/util\.ts \(outside every unit and not in ignore\)/)
    const d = JSON.parse(fs.readFileSync(path.join(job, 'gate', 'delta-7.json'), 'utf8'))
    assert.deepEqual(d.ignored, ['README.md'])
    reset()
  })

  test('a lockfile change is outside a package-scoped baseline', () => {
    edit('pnpm-lock.yaml', 'lockfileVersion: 10\n')
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /outside baseline scope: pnpm-lock\.yaml \(matches wholeRepo\)/)
    reset()
  })

  test('a crashed lint command exits 2, never 0', () => {
    stage('lint-packages_b.out', fixture('lint-crash.txt'))
    stage('lint-packages_b.status', '101')
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE ERROR: could not run .*lint:packages\/b: exited 101/)
    const d = JSON.parse(fs.readFileSync(path.join(job, 'gate', 'delta-9.json'), 'utf8'))
    assert.deepEqual([d.verdict, d.complete, d.exitCode], ['error', false, 2])
    fs.rmSync(path.join(state, 'lint-packages_b.status'))
    const r2 = run(['gate', 'check', '--job', job])
    assert.equal(r2.status, 2)
    assert.match(r2.stdout, /lint:packages\/b: output is not JSON/)
    fs.rmSync(path.join(state, 'lint-packages_b.out'))
  })

  test('a type-check that finds no project exits 2', () => {
    stage('typecheck.out', fixture('tsc-missing-project.txt'))
    stage('typecheck.status', '1')
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /tsc could not check a project/)
    stage('typecheck.out', fixture('tsc-before.txt'))
    stage('typecheck.status', '2')
  })

  test('an unreadable or unbuilt project exits 2, at baseline and at check', () => {
    stage('typecheck.out', fixture('tsc-unbuilt-reference.txt'))
    stage('typecheck.status', '1')
    const j = newJob('packages/a/src/**')
    const b = run(['gate', 'baseline', '--job', j, '--gate-config', configFile])
    assert.equal(b.status, 2, b.stdout + b.stderr)
    assert.match(b.stdout, /typecheck .*tsc could not check a project: .*TS6305/)
    stage('typecheck.out', fixture('tsc-unreadable-config.txt'))
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /tsc could not check a project: .*TS5083/)
    stage('typecheck.out', fixture('tsc-before.txt'))
    stage('typecheck.status', '2')
  })

  test('a lint command that exits non-zero with no diagnostics exits 2', () => {
    stage('lint-packages_b.out', fixture('lint-empty.json'))
    stage('lint-packages_b.status', '1')
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /lint:packages\/b: exited 1 without diagnostics/)
    fs.rmSync(path.join(state, 'lint-packages_b.out'))
    fs.rmSync(path.join(state, 'lint-packages_b.status'))
  })

  test('a package deleted since the baseline still owns its files', () => {
    fs.rmSync(path.join(repo, 'apps/docs'), { recursive: true })
    const r = run(['gate', 'check', '--job', job])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /outside baseline scope: apps\/docs\/package\.json \(apps\/docs is not in the baseline scope\)/)
    reset()
  })

  test('in whole-repo mode a package added after the baseline is outside the scope', () => {
    writeConfig({ typecheck: undefined })
    const j = newJob('packages/a/**')
    fs.writeFileSync(path.join(j, 'brief.md'), 'Do the thing.\n')
    const b = run(['gate', 'baseline', '--job', j, '--gate-config', configFile])
    assert.equal(b.status, 0, b.stdout + b.stderr)
    assert.match(b.stdout, /scope whole repo \(no paths given\)/)
    fs.mkdirSync(path.join(repo, 'packages/c/src'), { recursive: true })
    edit('packages/c/package.json', JSON.stringify({ name: '@x/c', scripts: { lint: 'oxlint' } }))
    edit('packages/c/src/z.ts', 'export const z: any = 1\n')
    const r = run(['gate', 'check', '--job', j])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /outside baseline scope: packages\/c\/src\/z\.ts \(packages\/c is not in the baseline scope\)/)
    reset()
    writeConfig()
  })

  test('files the gate commands write belong to the baseline, not to the change', () => {
    const j = newJob('packages/b/**')
    stage('typecheck.touch', 'apps/docs/generated.d.ts')
    const b = run(['gate', 'baseline', '--job', j, '--gate-config', configFile])
    assert.equal(b.status, 0, b.stdout + b.stderr)
    const c = run(['gate', 'check', '--job', j])
    assert.equal(c.status, 0, c.stdout + c.stderr)
    fs.rmSync(path.join(state, 'typecheck.touch'))
    fs.rmSync(path.join(repo, 'apps/docs/generated.d.ts'))
  })

  test('a command that runs past its timeout is killed and exits 2', () => {
    writeConfig({ typecheck: undefined })
    const j = newJob('apps/docs/**')
    stage('lint-apps_docs.hang', '')
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    cfg.lint.timeoutSec = 0.5
    fs.writeFileSync(configFile, JSON.stringify(cfg))
    const r = run(['gate', 'baseline', '--job', j, '--gate-config', configFile])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /^GATE ERROR: the baseline could not run/)
    assert.match(r.stdout, /lint:apps\/docs .*timed out after 0.5s/)
    const c = run(['gate', 'check', '--job', j])
    assert.equal(c.status, 2)
    assert.match(c.stdout, /the baseline did not complete/)
    fs.rmSync(path.join(state, 'lint-apps_docs.hang'))
    writeConfig()
  })

  test('no config means exit 3 and "not configured"; no baseline means exit 2', () => {
    const j = newJob('packages/a/**')
    const b = run(['gate', 'baseline', '--job', j])
    assert.equal(b.status, 3)
    assert.match(b.stdout, /^GATE: not configured/)
    const c = run(['gate', 'check', '--job', j])
    assert.equal(c.status, 3)
    assert.match(c.stdout, /^GATE: not configured/)
    const fresh = newJob('packages/a/**')
    const none = run(['gate', 'check', '--job', fresh])
    assert.equal(none.status, 2)
    assert.match(none.stdout, /^GATE ERROR: .*no baseline/)
  })

  test('the stable copy under DELEGATE_JOBS_DIR loads gate.mjs too', () => {
    assert.ok(fs.existsSync(path.join(jobsDir, 'gate.mjs')))
    const r = run(['gate', 'check', '--job', job], path.join(jobsDir, 'jobs.mjs'))
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })
})
