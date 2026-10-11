// Lint and type-check delta gate behind `jobs.mjs gate`. Keep this file identical in both plugins.
// Config format, scope rules and exit codes: references/gate-config.md.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { globToRegExp, resolveJob } from './jobs.mjs'

export const EXIT = { ok: 0, failed: 1, error: 2, unconfigured: 3 }
const CONFIG_NAME = path.join('.agents', 'delegate-gate.json')
const PARSERS = { 'oxlint-json': parseOxlintJson, tsc: parseTsc }
const OK_STATUS = { 'oxlint-json': [0, 1], tsc: [0, 1, 2] }
// File-less tsc errors that mean a project or option is broken, so nothing was checked.
const TSC_SETUP_CODES = /^TS(5\d{3}|6053)$/
const TOOLS = ['typecheck', 'lint'] // type-check writes dist/ first, so lint sees the same outputs both times

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const tryJson = file => {
  try {
    return readJson(file)
  } catch {
    return null
  }
}
const posix = p => p.split(path.sep).join('/')
function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`)
  return r.stdout
}
const tail = (text, lines = 20) => text.trimEnd().split('\n').slice(-lines).join('\n').slice(-2000)

// Config

export function loadConfig(file) {
  const config = readJson(file)
  const problems = []
  if (!config.lint && !config.typecheck) problems.push('needs "lint", "typecheck" or both')
  for (const tool of TOOLS) {
    const t = config[tool]
    if (!t) continue
    if (!Array.isArray(t.command) || !t.command.length || t.command.some(a => typeof a !== 'string'))
      problems.push(`${tool}.command must be a non-empty array of strings`)
    if (!PARSERS[t.parser]) problems.push(`${tool}.parser must be one of ${Object.keys(PARSERS).join(', ')}`)
  }
  for (const link of config.links ?? [])
    if (typeof link.from !== 'string' || !Array.isArray(link.to)) problems.push('each link needs "from" and "to": [...]')
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`)
  return config
}

export function findConfig(root, explicit) {
  if (explicit) return path.resolve(explicit)
  const file = path.join(root, CONFIG_NAME)
  return fs.existsSync(file) ? file : null
}

// Units and scope

function workspaceGlobs(root) {
  const pkg = tryJson(path.join(root, 'package.json'))
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
  if (ws) return ws
  const yaml = path.join(root, 'pnpm-workspace.yaml')
  if (!fs.existsSync(yaml)) return []
  const globs = []
  let inList = false
  for (const line of fs.readFileSync(yaml, 'utf8').split('\n')) {
    if (/^packages:\s*$/.test(line)) inList = true
    else if (inList && /^\s+-\s+/.test(line)) globs.push(line.replace(/^\s+-\s+/, '').replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, ''))
    else if (inList && /^\S/.test(line)) inList = false
  }
  return globs
}

const literalPrefix = glob => {
  const parts = []
  for (const seg of glob.split('/')) {
    if (/[*?[{]/.test(seg)) break
    parts.push(seg)
  }
  return parts.join('/')
}

function expandDirs(root, globs) {
  const include = globs.filter(g => !g.startsWith('!')).map(g => g.replace(/^\.\//, '').replace(/\/$/, ''))
  const exclude = globs.filter(g => g.startsWith('!')).map(g => globToRegExp(g.slice(1).replace(/^\.\//, '').replace(/\/$/, '')))
  const dirs = new Set()
  for (const glob of include) {
    const re = globToRegExp(glob)
    const walk = (rel, depth) => {
      if (re.test(rel) && fs.existsSync(path.join(root, rel, 'package.json'))) dirs.add(rel)
      if (depth > 3) return
      for (const d of fs.readdirSync(path.join(root, rel || '.'), { withFileTypes: true }))
        if (d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.')) walk(rel ? `${rel}/${d.name}` : d.name, depth + 1)
    }
    const start = literalPrefix(glob)
    if (fs.existsSync(path.join(root, start))) walk(start, 0)
  }
  return [...dirs].filter(d => !exclude.some(re => re.test(d))).sort()
}

// A unit is a workspace package, or an extra type-check-only project dir. Files outside every unit
// are ignored by the gate.
export function listUnits(root, config) {
  const units = new Map()
  for (const dir of expandDirs(root, config.packages ?? workspaceGlobs(root))) {
    const pkg = tryJson(path.join(root, dir, 'package.json')) ?? {}
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })
    units.set(dir, { dir, name: pkg.name ?? dir, deps, scripts: pkg.scripts ?? {}, package: true })
  }
  for (const dir of config.extraProjects ?? [])
    units.set(dir.replace(/\/$/, ''), { dir: dir.replace(/\/$/, ''), name: dir, deps: [], scripts: {}, package: false })
  for (const u of units.values()) u.tsconfig = fs.existsSync(path.join(root, u.dir, 'tsconfig.json'))
  return units
}

export const ownerOf = (units, file) =>
  [...units.keys()].filter(d => file === d || file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? null

function dependents(units, config) {
  const byName = new Map([...units.values()].map(u => [u.name, u.dir]))
  const rev = new Map([...units.keys()].map(d => [d, new Set()]))
  for (const u of units.values())
    for (const dep of u.deps) if (byName.has(dep) && byName.get(dep) !== u.dir) rev.get(byName.get(dep)).add(u.dir)
  for (const link of config.links ?? []) for (const to of link.to) if (rev.has(link.from) && units.has(to)) rev.get(link.from).add(to)
  return rev
}

export function parsePaths(value) {
  return [...String(value ?? '').matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)].map(m => m[1] ?? m[2] ?? m[3]).filter(Boolean)
}

// Same matching rules as wt-finish: a directory entry matches everything below it, the rest are globs.
export function pathMatcher(root, entry) {
  const clean = entry.replace(/^\.\//, '')
  const full = path.join(root, clean)
  if (clean.endsWith('/') || (fs.existsSync(full) && fs.statSync(full).isDirectory())) {
    const dir = clean.replace(/\/?$/, '/')
    return { prefix: dir.slice(0, -1), test: f => f.startsWith(dir) }
  }
  const re = globToRegExp(clean)
  return { prefix: literalPrefix(clean), test: f => re.test(f) }
}

export function resolveScope({ root, config, units, paths, files }) {
  const wholeRes = (config.wholeRepo ?? []).map(g => [g, globToRegExp(g)])
  const trigger = file => wholeRes.find(([, re]) => re.test(file))?.[0]
  const seeds = new Set()
  let whole = null
  if (!paths?.length) whole = 'no paths given'
  const consider = file => {
    const t = trigger(file)
    if (t && !whole) whole = `${file} matches wholeRepo "${t}"`
    const owner = ownerOf(units, file)
    if (owner) seeds.add(owner)
  }
  for (const entry of paths ?? []) {
    const m = pathMatcher(root, entry)
    files.filter(m.test).forEach(consider)
    if (m.prefix) consider(m.prefix)
  }
  if (whole) return { whole: true, reason: whole, paths: paths ?? null, seeds: [...seeds].sort(), units: [...units.keys()].sort() }
  const rev = dependents(units, config)
  const closure = new Set(seeds)
  const queue = [...seeds]
  while (queue.length) for (const d of rev.get(queue.shift()) ?? []) if (!closure.has(d)) closure.add(d), queue.push(d)
  return { whole: false, reason: null, paths, seeds: [...seeds].sort(), units: [...closure].sort() }
}

// Commands

const fill = (s, u) => s.replaceAll('{dir}', u?.dir ?? '.').replaceAll('{name}', u?.name ?? '')
export function buildCommands(config, units, scope) {
  const commands = []
  const tc = config.typecheck
  if (tc) {
    const projects = scope.whole ? [] : scope.units.filter(d => units.get(d)?.tsconfig)
    if (scope.whole || projects.length)
      commands.push({
        id: 'typecheck',
        tool: 'typecheck',
        unit: null,
        argv: tc.command.flatMap(a => (a === '{projects}' ? projects : [fill(a, null)])),
        cwd: fill(tc.cwd ?? '.', null),
        parser: tc.parser,
        timeoutSec: tc.timeoutSec ?? 900,
      })
  }
  const lint = config.lint
  if (lint)
    for (const dir of scope.units) {
      const u = units.get(dir)
      if (!u?.package || (lint.script && !u.scripts[lint.script])) continue
      commands.push({
        id: `lint:${dir}`,
        tool: 'lint',
        unit: dir,
        argv: lint.command.map(a => fill(a, u)),
        cwd: fill(lint.cwd ?? '.', u),
        parser: lint.parser,
        timeoutSec: lint.timeoutSec ?? 600,
        concurrency: lint.concurrency ?? 1,
      })
    }
  return commands
}

const active = new Set()
export function killActive() {
  for (const pid of active) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
}

// Each command runs in its own process group, so a timeout also stops the tools pnpm started.
export function runCommand(cmd, { root, env }) {
  return new Promise(resolve => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const done = extra => resolve({ stdout, stderr, durationMs: Date.now() - started, timedOut, ...extra })
    const child = spawn(cmd.argv[0], cmd.argv.slice(1), {
      cwd: path.join(root, cmd.cwd),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const group = sig => {
      try {
        process.kill(-child.pid, sig)
      } catch {}
    }
    if (child.pid) active.add(child.pid)
    child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', d => (stderr = (stderr + d).slice(-20000)))
    const timer = setTimeout(() => {
      timedOut = true
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), 5000).unref()
    }, cmd.timeoutSec * 1000)
    child.on('error', error => {
      clearTimeout(timer)
      active.delete(child.pid)
      done({ status: null, signal: null, error: error.message })
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      group('SIGKILL') // leftovers in the group
      active.delete(child.pid)
      done({ status, signal })
    })
  })
}

// Parsers return findings with repo-relative files, or throw when the output is not what the tool
// prints on a normal run.

const normMessage = (msg, root) =>
  String(msg)
    .replace(/\r\n?/g, '\n')
    .split(root.replace(/\/$/, '') + '/')
    .join('')
    .split(root.replace(/\/$/, ''))
    .join('<root>')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
const relFile = (root, cwd, file) => (file ? posix(path.relative(root, path.resolve(root, cwd, file))) : null)

export function parseOxlintJson(stdout, { root, cwd }) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error(`output is not JSON: ${stdout.trim().slice(0, 200) || '(empty)'}`)
  }
  const list = Array.isArray(data) ? data : data?.diagnostics
  if (!Array.isArray(list)) throw new Error('JSON has no "diagnostics" array')
  return list.map(d => {
    const span = d.labels?.[0]?.span ?? {}
    const message = normMessage(d.message ?? '', root)
    return {
      tool: 'lint',
      rule: d.code ?? (/^unused .*disable directive/i.test(message) ? 'unused-disable-directive' : 'oxlint'),
      file: relFile(root, cwd, d.filename),
      line: span.line ?? null,
      column: span.column ?? null,
      severity: d.severity ?? 'error',
      message,
    }
  })
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/
const TSC_GLOBAL = /^(error|warning|message) (TS\d+): (.*)$/
export function parseTsc(stdout, { root, cwd }) {
  const findings = []
  for (const line of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue
    let m
    if ((m = TSC_LINE.exec(line)))
      findings.push({ tool: 'typecheck', rule: m[5], file: relFile(root, cwd, m[1]), line: +m[2], column: +m[3], severity: m[4], message: m[6] })
    else if ((m = TSC_GLOBAL.exec(line))) {
      if (TSC_SETUP_CODES.test(m[2])) throw new Error(`tsc could not check a project: ${line.trim()}`)
      findings.push({ tool: 'typecheck', rule: m[2], file: null, line: null, column: null, severity: m[1], message: m[3] })
    } else if (/^\s/.test(line) && findings.length) findings.at(-1).message += `\n${line}`
    else throw new Error(`unparseable tsc output: ${line.slice(0, 200)}`)
  }
  for (const f of findings) f.message = normMessage(f.message, root)
  return findings
}

// Snapshot: run every command, parse, and say whether the result is complete.
export async function snapshot({ root, commands, env, phase }) {
  const runEnv = { ...process.env, NO_COLOR: '1', ...env }
  const results = new Array(commands.length)
  const runOne = async i => {
    const cmd = commands[i]
    const r = await runCommand(cmd, { root, env: runEnv })
    const rec = {
      id: cmd.id,
      tool: cmd.tool,
      argv: cmd.argv,
      cwd: cmd.cwd,
      status: r.status,
      signal: r.signal,
      durationMs: r.durationMs,
      stderrTail: tail(r.stderr),
      error: null,
      findings: [],
    }
    if (r.error) rec.error = `could not start: ${r.error}`
    else if (r.timedOut) rec.error = `timed out after ${cmd.timeoutSec}s`
    else if (r.signal) rec.error = `killed by ${r.signal}`
    else if (!OK_STATUS[cmd.parser].includes(r.status)) rec.error = `exited ${r.status}`
    if (!rec.error) {
      try {
        rec.findings = PARSERS[cmd.parser](r.stdout, { root, cwd: cmd.cwd })
        if (cmd.parser === 'tsc' && r.status !== 0 && !rec.findings.length) rec.error = `exited ${r.status} without diagnostics`
      } catch (e) {
        rec.error = e.message
      }
    }
    if (rec.error) rec.stdoutTail = tail(r.stdout, 10)
    results[i] = rec
  }
  const started = Date.now()
  const order = commands.map((c, i) => i)
  for (const tool of TOOLS) {
    const queue = order.filter(i => commands[i].tool === tool)
    const width = Math.max(1, commands[queue[0]]?.concurrency ?? 1)
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift())
    }))
  }
  const findings = results.flatMap(r => r.findings)
  return {
    phase,
    complete: results.every(r => !r.error),
    durationMs: Date.now() - started,
    commands: results.map(({ findings: f, ...r }) => ({ ...r, findings: f.length })),
    findings,
    countsByRule: countBy(findings),
  }
}
const countBy = findings => {
  const counts = {}
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort())
}

// Delta: multisets keyed without positions, so moved lines don't count. Renamed files are mapped
// before matching.
const keyOf = f => JSON.stringify([f.tool, f.rule, f.file ?? '', f.severity, f.message])
export function delta(before, after, renames = {}) {
  const group = (list, map) => {
    const g = new Map()
    for (const f of list) {
      const k = keyOf(map ? { ...f, file: renames[f.file] ?? f.file } : f)
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(f)
    }
    return g
  }
  const b = group(before, true)
  const a = group(after, false)
  const pick = (mine, theirs, n) => {
    // Report the entries whose line has no partner on the other side first.
    const lines = new Set(theirs.map(f => f.line))
    return [...mine].sort((x, y) => lines.has(x.line) - lines.has(y.line) || (x.line ?? 0) - (y.line ?? 0)).slice(0, n)
  }
  const added = []
  const removed = []
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const av = a.get(k) ?? []
    const bv = b.get(k) ?? []
    if (av.length > bv.length) added.push(...pick(av, bv, av.length - bv.length))
    if (bv.length > av.length) removed.push(...pick(bv, av, bv.length - av.length))
  }
  const order = (x, y) => String(x.file).localeCompare(String(y.file)) || (x.line ?? 0) - (y.line ?? 0)
  const countsByRule = {}
  for (const [list, field] of [[added, 'added'], [removed, 'removed']])
    for (const f of list) (countsByRule[f.rule] ??= { added: 0, removed: 0 })[field]++
  return { added: added.sort(order), removed: removed.sort(order), countsByRule: Object.fromEntries(Object.entries(countsByRule).sort()) }
}

// Working-tree state as a tree object, built in a scratch index so the real index is never touched.
export function snapshotTree(root, scratch) {
  fs.mkdirSync(scratch, { recursive: true })
  const index = path.join(scratch, `index-${process.pid}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root).trim()
    if (fs.existsSync(real)) fs.copyFileSync(real, index)
    git(['add', '-A'], root, env)
    return git(['write-tree'], root, env).trim()
  } finally {
    fs.rmSync(index, { force: true })
  }
}
export function treeChanges(root, from, to) {
  const out = git(['diff-tree', '-r', '-M', '--name-status', '-z', from, to], root).split('\0')
  const changes = []
  for (let i = 0; i < out.length - 1; ) {
    const status = out[i++]
    if (!status) continue
    if (/^[RC]/.test(status)) changes.push({ status: status[0], from: out[i++], file: out[i++] })
    else changes.push({ status, file: out[i++] })
  }
  return changes
}

// Job-level operations

const gateDir = jobDir => path.join(jobDir, 'gate')
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}
export function briefPaths(jobDir) {
  const brief = fs.existsSync(path.join(jobDir, 'brief.md')) ? fs.readFileSync(path.join(jobDir, 'brief.md'), 'utf8') : ''
  for (const line of brief.split('\n')) {
    if (!line.trim()) break
    const m = /^paths:\s*(.*)$/i.exec(line.trim())
    if (m) return m[1]
  }
  return null
}

export async function gateBaseline({ jobDir, root, configPath, paths }) {
  const file = path.join(gateDir(jobDir), 'baseline.json')
  const base = { phase: 'baseline', createdAt: new Date().toISOString(), root, config: configPath }
  if (!configPath) {
    write(file, { ...base, configured: false })
    return { exitCode: EXIT.unconfigured, verdict: 'not configured', file }
  }
  let config, units, scope, commands, tree, head
  try {
    config = loadConfig(configPath)
    units = listUnits(root, config)
    tree = snapshotTree(root, gateDir(jobDir))
    head = git(['rev-parse', 'HEAD'], root).trim()
    const files = git(['ls-tree', '-r', '--name-only', '-z', tree], root).split('\0').filter(Boolean)
    scope = resolveScope({ root, config, units, paths, files })
    commands = buildCommands(config, units, scope)
  } catch (e) {
    write(file, { ...base, configured: true, complete: false, error: e.message })
    return { exitCode: EXIT.error, verdict: 'error', error: e.message, file }
  }
  const snap = await snapshot({ root, commands, env: config.env, phase: 'baseline' })
  const result = { ...base, configured: true, head, tree, scope, gateConfig: config, plan: commands, ...snap }
  write(file, result)
  return { exitCode: snap.complete ? EXIT.ok : EXIT.error, verdict: snap.complete ? 'baseline' : 'error', file, result }
}

export async function gateCheck({ jobDir, round }) {
  const dir = gateDir(jobDir)
  const baseline = tryJson(path.join(dir, 'baseline.json'))
  const rounds = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => Number(/^delta-(\d+)\.json$/.exec(f)?.[1] ?? 0)) : []
  const n = round ?? 1 + Math.max(0, ...rounds)
  const deltaFile = path.join(dir, `delta-${n}.json`)
  const finish = (exitCode, verdict, data) => {
    write(deltaFile, { round: n, verdict, exitCode, createdAt: new Date().toISOString(), ...data })
    return { exitCode, verdict, file: deltaFile, round: n, ...data }
  }
  if (!baseline) return finish(EXIT.error, 'error', { complete: false, errors: [`no baseline at ${dir}/baseline.json`] })
  if (baseline.configured === false) return finish(EXIT.unconfigured, 'not configured', {})
  if (!baseline.complete) return finish(EXIT.error, 'error', { complete: false, errors: ['the baseline did not complete'] })
  const { root, scope } = baseline
  let changes
  try {
    changes = treeChanges(root, baseline.tree, snapshotTree(root, dir))
  } catch (e) {
    return finish(EXIT.error, 'error', { complete: false, errors: [e.message] })
  }
  const units = new Set(scope.units)
  const known = listUnits(root, baseline.gateConfig)
  const wholeRes = (baseline.gateConfig.wholeRepo ?? []).map(g => globToRegExp(g))
  const outsideScope = []
  const unowned = []
  for (const file of new Set(changes.flatMap(c => [c.file, c.from].filter(Boolean)))) {
    if (scope.whole) continue
    const owner = ownerOf(known, file)
    if (wholeRes.some(re => re.test(file))) outsideScope.push({ file, reason: 'matches wholeRepo' })
    else if (!owner) unowned.push(file)
    else if (!units.has(owner)) outsideScope.push({ file, reason: `${owner} is not in the baseline scope` })
  }
  const snap = await snapshot({ root, commands: baseline.plan, env: baseline.gateConfig.env, phase: 'check' })
  write(path.join(dir, `after-${n}.json`), { round: n, createdAt: new Date().toISOString(), ...snap })
  const renames = Object.fromEntries(changes.filter(c => c.status === 'R').map(c => [c.from, c.file]))
  const common = { changed: changes, renames, outsideScope, unowned, durationMs: snap.durationMs }
  if (!snap.complete) {
    const errors = snap.commands.filter(c => c.error).map(c => `${c.id}: ${c.error}`)
    return finish(EXIT.error, 'error', { complete: false, errors, ...common, added: [], removed: [], countsByRule: {} })
  }
  const d = delta(baseline.findings, snap.findings, renames)
  const failed = d.added.length || outsideScope.length
  return finish(failed ? EXIT.failed : EXIT.ok, failed ? 'failed' : 'ok', { complete: true, ...d, ...common })
}

// Text output

const secs = ms => `${Math.round(ms / 1000)}s`
const where = f => `${f.file ?? '(no file)'}${f.line ? `:${f.line}:${f.column}` : ''}`
const firstLine = s => s.split('\n')[0]
function describeScope(scope) {
  if (scope.whole) return `whole repo (${scope.reason})`
  const extra = scope.units.length - scope.seeds.length
  return `${scope.units.length} unit(s)${extra ? `, ${extra} of them dependents` : ''}`
}

export function formatBaseline(r) {
  if (r.verdict === 'not configured') return `GATE: not configured (no ${CONFIG_NAME} and no --gate-config)`
  if (!r.result) return `GATE ERROR: baseline could not start: ${r.error}\nDetails: ${r.file}`
  const res = r.result
  const lines = []
  if (res.complete)
    lines.push(`GATE BASELINE: ${res.findings.length} finding(s) from ${res.commands.length} command(s) in ${secs(res.durationMs)} · scope ${describeScope(res.scope)}`)
  else lines.push(`GATE ERROR: the baseline could not run`)
  for (const c of res.commands) lines.push(`  ${c.error ? 'ERROR' : 'ok   '} ${c.id}  ${secs(c.durationMs)}${c.error ? `  ${c.error}` : `  ${c.findings} finding(s)`}`)
  for (const c of res.commands.filter(c => c.error && c.stderrTail)) lines.push(`stderr of ${c.id}:`, c.stderrTail.replace(/^/gm, '  '))
  lines.push(`Details: ${r.file}`)
  return lines.join('\n')
}

export function formatCheck(r) {
  if (r.verdict === 'not configured') return 'GATE: not configured'
  const lines = []
  const counts = `${r.added?.length ?? 0} added, ${r.removed?.length ?? 0} removed`
  if (r.verdict === 'error') lines.push(`GATE ERROR: could not run (round ${r.round}): ${r.errors.join('; ')}`)
  else lines.push(`GATE ${r.verdict === 'ok' ? 'OK' : 'FAILED'}: ${counts}${r.outsideScope.length ? `, ${r.outsideScope.length} file(s) outside baseline scope` : ''} · round ${r.round} · ${secs(r.durationMs)}`)
  for (const f of (r.added ?? []).slice(0, 60)) lines.push(`  + ${f.rule}  ${where(f)}  ${firstLine(f.message)}`)
  if ((r.added?.length ?? 0) > 60) lines.push(`  … ${r.added.length - 60} more in ${r.file}`)
  for (const o of r.outsideScope ?? []) lines.push(`  outside baseline scope: ${o.file} (${o.reason})`)
  const removed = Object.entries(r.countsByRule ?? {}).filter(([, c]) => c.removed)
  if (removed.length) lines.push(`Removed: ${removed.map(([rule, c]) => `${rule} ${c.removed}`).join(', ')}`)
  lines.push(`Details: ${r.file}`)
  return lines.join('\n')
}

// CLI: jobs.mjs gate baseline|check

const GATE_USAGE = `Usage: jobs.mjs gate baseline --job <job> [--gate-config <path>] [--paths '<globs>']
       jobs.mjs gate check --job <job> [--round <n>]
Exit 0 clean (baseline recorded), 1 findings added or files outside the baseline scope,
2 could not run, 3 not configured.`

// resolveJob exits 1 on an unknown job, which callers would read as "findings added".
function jobOrExit2(ref) {
  const exit = process.exit
  process.exit = code => exit(code === EXIT.failed ? EXIT.error : code)
  try {
    return resolveJob(ref)
  } finally {
    process.exit = exit
  }
}

export async function cmdGate(args) {
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const sub = args[0]
  if (!['baseline', 'check'].includes(sub) || !opt('--job')) {
    console.log(GATE_USAGE)
    process.exit(EXIT.error)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => {
      killActive()
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig])
    })
  const job = jobOrExit2(opt('--job'))
  let r
  if (sub === 'baseline') {
    const top = job.toplevel ?? job.cwd ?? process.cwd()
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: top, encoding: 'utf8' }).stdout.trim() || top
    const pathsValue = opt('--paths') ?? briefPaths(job.dir)
    r = await gateBaseline({ jobDir: job.dir, root, configPath: findConfig(root, opt('--gate-config')), paths: pathsValue == null ? null : parsePaths(pathsValue) })
    console.log(formatBaseline(r))
  } else {
    const round = opt('--round') ? Number(opt('--round')) : undefined
    if (round !== undefined && !(round > 0)) {
      console.log(GATE_USAGE)
      process.exit(EXIT.error)
    }
    r = await gateCheck({ jobDir: job.dir, round })
    console.log(formatCheck(r))
  }
  process.exit(r.exitCode)
}
