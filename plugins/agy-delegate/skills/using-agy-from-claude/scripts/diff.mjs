// `delegate-jobs diff`: a numbered diff, the changed files and the AGENTS.md files that apply, on git
// (and gh for --pr). Identical copy in both delegate plugins; jobs.mjs loads it by dynamic import.
// Parsing and numbering are trimmed from the review-teammate-pr skill (plugins install separately).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RULES_LIMIT_BYTES = 24000 // agy truncates a rules file here
const MAX_UNTRACKED_BYTES = 1_000_000
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/']

export class DiffError extends Error {}

const GENERATED_PATTERNS = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.lock$/,
  /(^|\/)meta\/(_journal|\d+_snapshot)\.json$/,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.generated\./,
  /(^|\/)(__fixtures__|fixtures|__snapshots__)\//,
  /(^|\/)dist\//,
]
export const isGeneratedPath = file => GENERATED_PATTERNS.some(pattern => pattern.test(file))

const run = (cmd, args, cwd) =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd, maxBuffer: 512 * 1024 * 1024 })
const git = (cwd, args) => run('git', ['-c', 'core.quotePath=false', ...args], cwd)
const gitOut = (cwd, args) => {
  const r = git(cwd, args)
  return r.status === 0 ? r.stdout.trim() : null
}
const tail = text => String(text ?? '').trim().split('\n').slice(-3).join(' | ')
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Parsing. A quoted path has C-style escapes; git only quotes names with tabs, quotes or backslashes
// once core.quotePath is off.
const unquote = text =>
  text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => ({ t: '\t', n: '\n' })[c] ?? c)
    : text
const stripPrefix = text => {
  const clean = unquote(text.replace(/\t$/, '')) // git adds a trailing tab after names with spaces
  return clean === '/dev/null' ? null : clean.replace(/^[ab]\//, '')
}
// `diff --git a/P b/P` names one path when the sides are equal; renames name two, and then the
// `rename to` line decides.
function headerPath(rest) {
  const quoted = rest.match(/^("a\/.*") ("b\/.*")$/)
  if (quoted) return stripPrefix(quoted[2])
  const mid = (rest.length - 1) / 2
  return Number.isInteger(mid) && rest[mid] === ' ' && rest.slice(2, mid) === rest.slice(mid + 3)
    ? rest.slice(2, mid)
    : null
}

// Returns Map<path, { path, oldPath, status, binary, additions, deletions, hunks: [{ header, lines }] }>.
// `lines` keeps display order; each line has the base (left) and head (right) number or null.
export function parseDiff(diffText) {
  const files = new Map()
  let file = null
  let hunk = null
  let oldLine = 0
  let newLine = 0
  let oldName = null
  const flush = () => {
    if (file?.path) files.set(file.path, file)
    file = hunk = oldName = null
  }

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      file = {
        path: headerPath(line.slice(11)),
        oldPath: null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        file.oldPath = unquote(line.replace(/^\w+ from /, ''))
        file.status = line.startsWith('rename') ? 'renamed' : 'copied'
      } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        file.path = unquote(line.replace(/^\w+ to /, ''))
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = true
        if (/^Binary files \/dev\/null and /.test(line)) file.status = 'added'
        if (/ and \/dev\/null differ$/.test(line)) file.status = 'deleted'
      } else if (line.startsWith('--- ')) oldName = stripPrefix(line.slice(4))
      else if (line.startsWith('+++ ')) file.path = stripPrefix(line.slice(4)) ?? oldName ?? file.path
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
    } else if (hunk && line.startsWith('+')) {
      hunk.lines.push({ left: null, right: newLine++, text: line })
      file.additions++
    } else if (hunk && line.startsWith('-')) {
      hunk.lines.push({ left: oldLine++, right: null, text: line })
      file.deletions++
    } else if (hunk && line.startsWith(' ')) {
      hunk.lines.push({ left: oldLine++, right: newLine++, text: line })
    }
  }
  flush()
  return files
}

// One block per file with base (L) and head (R) numbers on every line. Generated and lock files get no
// hunks; a footer names them and files.json keeps them.
export function numberedDiff(records) {
  const out = []
  const skipped = []
  for (const file of records) {
    if (file.generated || file.skipped) {
      skipped.push(file.path)
      continue
    }
    const marks = [
      file.status === 'added' && 'new file',
      file.status === 'deleted' && 'deleted',
      file.status === 'renamed' && `renamed from ${file.oldPath}`,
      file.binary && 'binary',
    ].filter(Boolean)
    out.push(`\n### ${file.path} (+${file.additions} -${file.deletions})${marks.map(m => ` [${m}]`).join('')}`)
    for (const hunk of file.hunks) {
      out.push(hunk.header)
      for (const line of hunk.lines) {
        const left = line.left === null ? '' : `L${line.left}`
        const right = line.right === null ? '' : `R${line.right}`
        out.push(`${left.padStart(6)} ${right.padStart(6)} |${line.text}`)
      }
    }
  }
  if (skipped.length) out.push(`\nNot shown (generated, lock or too large, listed in files.json): ${skipped.join(', ')}`)
  return out.length ? `${out.join('\n').trimStart()}\n` : ''
}

// Checks, each with its own message.
function requireGit() {
  const r = run('git', ['--version'])
  if (r.error?.code === 'ENOENT') throw new DiffError('git is not installed or not on PATH')
  if (r.status !== 0) throw new DiffError(`git does not run: ${tail(r.stderr || r.error?.message)}`)
}
function requireGh() {
  const version = run('gh', ['--version'])
  if (version.error?.code === 'ENOENT')
    throw new DiffError('gh (the GitHub CLI) is not installed or not on PATH; a --pr diff needs it, see https://cli.github.com')
  const auth = run('gh', ['auth', 'status'])
  if (auth.status !== 0)
    throw new DiffError(`gh is not signed in or cannot reach GitHub; run "gh auth login" and retry (${tail(auth.stderr || auth.stdout)})`)
}
function toplevel(cwd) {
  if (!fs.existsSync(cwd)) throw new DiffError(`directory ${cwd} does not exist`)
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) throw new DiffError(`${cwd} is not inside a git checkout`)
  return top
}

// The commit to diff against. --base and the merge-base defaults use the merge-base with HEAD, so a
// moved branch tip does not show up as the job's change. A job's own start commit is used as is.
function resolveBase(top, { base, jobBase }) {
  const commit = ref => gitOut(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const forkPoint = ref => gitOut(top, ['merge-base', 'HEAD', ref]) ?? commit(ref)
  if (!commit('HEAD')) throw new DiffError(`HEAD does not resolve in ${top}; the repository has no commits`)
  if (base) {
    if (!commit(base)) throw new DiffError(`base ref "${base}" does not resolve to a commit in ${top}`)
    return { ref: base, sha: forkPoint(base), source: `--base ${base}` }
  }
  if (jobBase && commit(jobBase)) return { ref: jobBase, sha: commit(jobBase), source: 'job start' }
  for (const ref of ['origin/main', 'main'])
    if (commit(ref)) return { ref, sha: forkPoint(ref), source: `merge-base with ${ref}` }
  return { ref: 'HEAD', sha: commit('HEAD'), source: 'HEAD (no origin/main or main)' }
}

const ensureNewline = text => (text && !text.endsWith('\n') ? `${text}\n` : text)

// Tracked changes against the base, plus untracked files rendered as new-file diffs. `git add -N`
// would do the same but writes the job's index, so each file goes through `diff --no-index`.
function worktreeDiff(top, sha, skipDir) {
  const tracked = git(top, ['diff', '-M', ...DIFF_FLAGS, sha])
  if (tracked.status !== 0) throw new DiffError(`git diff ${sha.slice(0, 10)} failed: ${tail(tracked.stderr || tracked.error?.message)}`)
  const listed = git(top, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (listed.status !== 0) throw new DiffError(`git ls-files failed: ${tail(listed.stderr)}`)
  const untracked = listed.stdout.split('\0').filter(Boolean)
  const parts = [tracked.stdout]
  const oversized = new Set()
  for (const file of untracked) {
    const abs = path.join(top, file)
    if (skipDir && (abs === skipDir || abs.startsWith(`${skipDir}${path.sep}`))) continue
    if (fs.lstatSync(abs).size > MAX_UNTRACKED_BYTES) {
      oversized.add(file)
      continue
    }
    const r = git(top, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file])
    if (r.status > 1 || r.status === null) throw new DiffError(`git diff for untracked ${file} failed: ${tail(r.stderr || r.error?.message)}`)
    parts.push(r.stdout)
  }
  return {
    text: parts.map(ensureNewline).join(''),
    untracked: new Set(untracked),
    oversized,
  }
}

function prDiff(top, number) {
  requireGh()
  const r = run('gh', ['pr', 'diff', String(number), '--color', 'never'], top)
  if (r.status !== 0) throw new DiffError(`gh pr diff ${number} failed: ${tail(r.stderr || r.error?.message)}`)
  return r.stdout
}

// The nearest package.json above a file. One without a name only counts at the repo root.
function packageFinder(top) {
  const cache = new Map()
  const find = dir => {
    if (cache.has(dir)) return cache.get(dir)
    const pkg = readJson(path.join(top, dir === '.' ? '' : dir, 'package.json'))
    let found = null
    if (pkg && (pkg.name || dir === '.')) found = { dir, name: pkg.name ?? null }
    else if (dir !== '.') found = find(path.posix.dirname(dir))
    cache.set(dir, found)
    return found
  }
  return file => find(path.posix.dirname(file))
}

// The root AGENTS.md plus every AGENTS.md on the way from a changed file's directory up to the root.
export function applicableRules(top, changedPaths) {
  const dirs = new Set(['.'])
  for (const file of changedPaths) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) dirs.add(dir)
  }
  const rules = []
  for (const dir of [...dirs].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)))) {
    const rel = dir === '.' ? 'AGENTS.md' : `${dir}/AGENTS.md`
    let stat
    try {
      stat = fs.statSync(path.join(top, rel))
    } catch {
      continue
    }
    if (stat.isFile()) rules.push({ path: rel, bytes: stat.size, over24kb: stat.size > RULES_LIMIT_BYTES })
  }
  return rules
}

// Builds the four outputs for one target and writes them to `out`. `jobBase` is the commit a job
// started from; it is the default base when `base` is not given.
export function runDiff({ cwd, base, pr, out, jobBase }) {
  requireGit()
  if (pr != null && base) throw new DiffError('--pr and --base cannot be combined; a PR already has its base')
  if (pr != null) requireGh()
  const top = toplevel(cwd)
  const target = pr == null ? resolveBase(top, { base, jobBase }) : null
  fs.mkdirSync(out, { recursive: true })
  const outDir = fs.realpathSync(out)
  const source =
    pr == null
      ? worktreeDiff(top, target.sha, path.relative(top, outDir).startsWith('..') ? null : outDir)
      : { text: prDiff(top, pr), untracked: new Set(), oversized: new Set() }

  const packageOf = packageFinder(top)
  const records = [...parseDiff(source.text).values()].map(file => {
    const owner = packageOf(file.path)
    return {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      untracked: source.untracked.has(file.path),
      binary: file.binary,
      additions: file.additions,
      deletions: file.deletions,
      generated: isGeneratedPath(file.path),
      package: owner?.dir ?? null,
      packageName: owner?.name ?? null,
      hunks: file.hunks,
    }
  })
  for (const file of source.oversized) {
    const owner = packageOf(file)
    records.push({
      path: file,
      status: 'added',
      untracked: true,
      binary: false,
      additions: 0,
      deletions: 0,
      generated: isGeneratedPath(file),
      package: owner?.dir ?? null,
      packageName: owner?.name ?? null,
      skipped: 'over 1 MB, not diffed',
      hunks: [],
    })
  }
  const files = records.map(({ hunks, ...rest }) => rest)
  const rules = applicableRules(top, records.map(r => r.path))

  const paths = {
    patch: path.join(outDir, 'diff.patch'),
    numbered: path.join(outDir, 'diff-numbered.txt'),
    files: path.join(outDir, 'files.json'),
    rules: path.join(outDir, 'rules.json'),
  }
  fs.writeFileSync(paths.patch, source.text)
  fs.writeFileSync(paths.numbered, numberedDiff(records))
  fs.writeFileSync(paths.files, `${JSON.stringify(files, null, 2)}\n`)
  fs.writeFileSync(paths.rules, `${JSON.stringify(rules, null, 2)}\n`)

  return {
    target: pr == null ? 'worktree' : 'pr',
    repo: top,
    base: target && { ref: target.ref, sha: target.sha, source: target.source },
    pr: pr ?? null,
    out: outDir,
    paths,
    totals: {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      generated: files.filter(f => f.generated).length,
    },
    files,
    rules,
  }
}

function summarize(result) {
  const { totals, base, rules } = result
  const lines = [
    result.target === 'pr'
      ? `diff of PR #${result.pr} in ${result.repo}`
      : `diff of ${result.repo} against ${base.sha.slice(0, 10)} (${base.source})`,
    totals.files ? `${totals.files} file(s), +${totals.additions} -${totals.deletions}` : 'no changes',
    ...(totals.generated ? [`${totals.generated} generated or lock file(s): listed in files.json, no hunks in diff-numbered.txt`] : []),
    rules.length ? 'AGENTS.md files that apply:' : 'no AGENTS.md applies',
    ...rules.map(r => `  ${r.path}  ${r.bytes} bytes${r.over24kb ? `  OVER ${RULES_LIMIT_BYTES}, agy truncates it` : ''}`),
    `wrote ${result.out}/{diff.patch,diff-numbered.txt,files.json,rules.json}`,
  ]
  return lines.join('\n')
}

const USAGE = 'usage: diff [--job <job>] [--base <ref>] [--pr <n>] [--json] [--out <dir>]'

// Entry for `delegate-jobs diff`. `job` is the resolved --job record (or null); jobs.mjs owns the lookup.
export function cmdDiff(args, job) {
  const parsed = { json: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') parsed.json = true
    else if (['--job', '--base', '--pr', '--out'].includes(arg)) {
      if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new DiffError(`${arg} needs a value; ${USAGE}`)
      parsed[arg.slice(2)] = args[++i]
    } else throw new DiffError(`unknown argument "${arg}"; ${USAGE}`)
  }
  if (parsed.pr != null && !/^[1-9]\d*$/.test(parsed.pr)) throw new DiffError(`--pr needs a PR number, got "${parsed.pr}"`)
  const out = parsed.out
    ? path.resolve(parsed.out)
    : job
      ? path.join(job.dir, 'diff')
      : fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-diff-'))
  const result = runDiff({
    cwd: job ? (job.toplevel ?? job.cwd) : process.cwd(),
    base: parsed.base,
    pr: parsed.pr == null ? null : Number(parsed.pr),
    out,
    jobBase: job?.head,
  })
  console.log(parsed.json ? JSON.stringify(result, null, 2) : summarize(result))
}
