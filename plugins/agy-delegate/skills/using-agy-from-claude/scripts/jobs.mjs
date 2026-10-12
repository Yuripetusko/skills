#!/usr/bin/env node
// Job registry and worktree helpers shared by the using-codex-from-claude and using-agy-from-claude
// skills. The same file sits in both skills' scripts/ folders; keep the two copies identical.
//
// Every delegated job gets a directory under ROOT (default ~/.claude/delegate-jobs, override with
// DELEGATE_JOBS_DIR) holding brief.md, meta.json, out.md, err.log and, for agy, events.jsonl. The
// parent session and the user find jobs there without knowing which relay launched them, and
// ROOT/jobs.mjs is a copy of this script at a path that does not depend on how the plugin is installed.
// Commands whose logic lives in a sibling module (SIBLINGS) load it with a dynamic import, and `new`
// copies those modules next to ROOT/jobs.mjs.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.DELEGATE_JOBS_DIR || path.join(os.homedir(), '.claude', 'delegate-jobs')
const KEEP_JOBS = 50
const KEEP_DAYS = 7
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
const SIBLINGS = ['diff.mjs', 'gate.mjs']

const USAGE = `Usage: node jobs.mjs <command>
  new <tool> [--label <text>]          create a job dir under ${ROOT}, print its path
  exec <job> [--write] -- <cmd...>     run <cmd> as the job's runner; --write takes this checkout's write lock
  jobs [--all] [--json]                list running and recent jobs (all checkouts)
  tail [<job>|--next] [-n <lines>] [-f] [--every <dur>]  recent progress (default: newest job);
                                       -f follows it to the end, --every condenses to one line per interval
  cancel <job>                         stop a running job
  wt-setup [--base <ref>] [--install [full|deps]] [--allow-main]
  wt-finish --paths '<path|glob> ...' | --path <p> [--path <p>…] [--message <msg>] [--job <job>]
  diff [--job <job>] [--base <ref>] [--pr <n>] [--json] [--out <dir>]  numbered diff, changed files, applicable AGENTS.md
  gate baseline --job <job> [--gate-config <path>] [--paths '<globs>'] | gate check --job <job> [--round <n>]
                                       lint and type-check findings added since the baseline
<job> is a job dir, its name, or a unique prefix of the name.`

const git = (args, opts = {}) =>
  spawnSync('git', args, { encoding: 'utf8', cwd: opts.cwd ?? process.cwd() })
const gitOut = (args, opts) => {
  const r = git(args, opts)
  return r.status === 0 ? r.stdout.trim() : null
}
const fail = (msg, code = 1) => {
  process.stderr.write(`jobs: ${msg}\n`)
  process.exit(code)
}
const alive = pid => {
  try {
    return Boolean(pid) && (process.kill(pid, 0), true)
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readMeta(dir) {
  // A job that `new` is still creating has no meta.json yet.
  const meta = readJson(path.join(dir, 'meta.json')) ?? {
    id: path.basename(dir),
    status: 'created',
    createdAt: new Date(fs.statSync(dir).mtimeMs).toISOString(),
  }
  if (meta.status === 'running' && !alive(meta.pid)) meta.status = 'lost'
  return { ...meta, dir }
}
// Every writer reads, merges and writes under a per-job lock, so overlapping writers (exec, wt-finish,
// gate check, the stop gate) cannot drop each other's fields. `patch` is an object, or a function
// that gets the current meta and returns the object to merge: use the function to change a nested
// field (meta.gate) from its fresh value. After 10 s without the lock the write goes ahead unlocked.
function lockMeta(dir) {
  const name = `meta-${createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16)}`
  const deadline = Date.now() + 10_000
  let lock
  while ((lock = takeLock(name, 'meta.json')).busy) {
    if (Date.now() > deadline) return null
    sleepMs(15 + Math.random() * 15)
  }
  return lock
}
export function updateMeta(dir, patch) {
  const lock = lockMeta(dir)
  try {
    const file = path.join(dir, 'meta.json')
    const current = readJson(file) ?? {}
    const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
    return next
  } finally {
    if (lock) fs.rmSync(lock.dir, { recursive: true, force: true })
  }
}
function allJobs() {
  if (!fs.existsSync(ROOT)) return []
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => readMeta(path.join(ROOT, d.name)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}
export function resolveJob(ref) {
  if (ref && fs.existsSync(path.join(ref, 'meta.json'))) return readMeta(path.resolve(ref))
  const jobs = allJobs()
  if (!ref) return jobs[0] ?? fail('no jobs yet')
  const hits = jobs.filter(j => j.id.startsWith(ref))
  if (hits.length !== 1) fail(hits.length ? `"${ref}" is ambiguous` : `no job "${ref}"`)
  return hits[0]
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5
  allJobs().forEach((j, i) => {
    if (j.status === 'running') return
    const last = Date.parse(j.endedAt ?? j.createdAt)
    if (last < cutoff || (i >= KEEP_JOBS && Date.now() - last > 3600e3))
      fs.rmSync(j.dir, { recursive: true, force: true })
  })
}

function cmdNew(args) {
  const tool = args[0]?.replace(/[^a-z0-9-]/gi, '') || fail('new needs a tool name')
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : null
  fs.mkdirSync(ROOT, { recursive: true })
  prune()
  const self = fileURLToPath(import.meta.url)
  for (const name of ['jobs.mjs', ...SIBLINGS]) {
    const from = path.join(path.dirname(self), name)
    const to = path.join(ROOT, name)
    if (from !== to && fs.existsSync(from) && fs.readFileSync(from, 'utf8') !== (fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : ''))
      fs.copyFileSync(from, to)
  }
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const dir = fs.mkdtempSync(path.join(ROOT, `${tool}-${stamp}-`))
  const cwd = process.cwd()
  updateMeta(dir, {
    id: path.basename(dir),
    tool,
    label,
    cwd,
    toplevel: gitOut(['rev-parse', '--show-toplevel']) ?? cwd,
    branch: gitOut(['branch', '--show-current']),
    head: gitOut(['rev-parse', '--short', 'HEAD']),
    // Relays inherit the dispatching session's id, so a job can be traced back to its orchestrator.
    session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    status: 'created',
    createdAt: new Date().toISOString(),
  })
  console.log(dir)
}

// mkdir is atomic, so two processes cannot both take a lock. A lock is stale when its owner process is
// gone; one without owner.json is mid-acquire, unless that was over a minute ago.
// Removing a stale lock on an old read deletes a live one: the owner may have released and exited, and
// another process may have taken the name since (two holders, or a taker whose owner.json write fails).
// So the verdict must be about one lock. Each owner.json carries a token. The owner is found dead, then
// the file is read again, and the lock is stale only if the token is still the same: it belongs to a dead
// owner, which nobody releases. Stale locks are removed only under a second lock, `<name>.takeover`, so
// takers don't race each other either. A taker that dies inside the few ms of the takeover leaves a
// guard that anyone may remove after 10 s.
export function lockState(dir, afterRead = () => {}) {
  const file = path.join(dir, 'owner.json')
  const held = readJson(file)
  afterRead() // lets a test change the lock between the read and the liveness check
  let young
  try {
    young = Date.now() - fs.statSync(dir).mtimeMs < 60_000
  } catch {
    return { gone: true }
  }
  if (!held) return young ? { busy: 'another process' } : { stale: true }
  if (alive(held.pid)) return { busy: held.owner }
  return JSON.stringify(readJson(file)) === JSON.stringify(held) ? { stale: true } : { changed: true }
}
export function takeLock(name, owner) {
  const dir = path.join(ROOT, '.locks', name)
  const guard = `${dir}.takeover`
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  for (let attempt = 0; attempt < 500; attempt++) {
    let made = false
    try {
      fs.mkdirSync(dir)
      made = true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    if (made) {
      try {
        fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ owner, pid: process.pid, token: randomUUID() }))
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw e
      }
      return { dir }
    }
    const state = lockState(dir)
    if (state.busy) return state
    if (state.gone || state.changed) continue // released, or replaced, since the failed mkdir: look again
    try {
      fs.mkdirSync(guard)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > 10_000) fs.rmSync(guard, { recursive: true, force: true })
      } catch {}
      sleepMs(1 + Math.random() * 4)
      continue
    }
    try {
      if (lockState(dir).stale) {
        // A rename frees the name at once; the old contents are deleted afterwards.
        const old = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`
        try {
          fs.renameSync(dir, old)
          fs.rmSync(old, { recursive: true, force: true })
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      }
    } finally {
      fs.rmSync(guard, { recursive: true, force: true })
    }
  }
  return { busy: 'another process' }
}
// One write job per checkout.
const takeWriteLock = job =>
  takeLock(createHash('sha256').update(job.toplevel).digest('hex').slice(0, 16), job.id)

// The runner sends the agent's answer and log to out.md and err.log and prints progress on its own
// stdout, so the background Bash call (and the desktop app's task panel) shows a live tail.
function cmdExec(args) {
  const sep = args.indexOf('--')
  if (sep < 1 || sep === args.length - 1) fail('usage: exec <job> [--write] -- <cmd...>')
  const job = resolveJob(args[0])
  const write = args.slice(1, sep).includes('--write')
  const cmd = args.slice(sep + 1)
  const end = (status, exitCode, extra = {}) =>
    updateMeta(job.dir, { status, exitCode, endedAt: new Date().toISOString(), ...extra })
  const lock = write ? takeWriteLock(job) : null
  if (lock?.busy) {
    const error = `checkout ${job.toplevel} already has a running write job: ${lock.busy}`
    end('failed', 16, { error })
    fail(error, 16)
  }
  const out = fs.openSync(path.join(job.dir, 'out.md'), 'w')
  const err = fs.openSync(path.join(job.dir, 'err.log'), 'w')
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', out, err] })
  updateMeta(job.dir, {
    status: 'running',
    write,
    pid: process.pid,
    command: cmd.slice(0, 3).map(a => path.basename(a)).join(' '),
    // Recorded here, not at `new`: wt-setup may have reset the worktree in between.
    head: gitOut(['rev-parse', '--short', 'HEAD']),
    branch: gitOut(['branch', '--show-current']),
    startedAt: new Date().toISOString(),
  })
  console.log(`${job.id} started in ${home(job.cwd)}`)
  let shown = 0
  const pump = () => {
    const lines = progressLines(readMeta(job.dir))
    for (const line of lines.slice(shown)) console.log(line.length > 200 ? `${line.slice(0, 197)}...` : line)
    shown = lines.length
  }
  const timer = setInterval(pump, 3000)
  for (const sig of Object.keys(SIGNALS)) process.on(sig, () => child.kill(sig))
  child.on('error', error => {
    end('failed', 127, { error: error.message })
    fail(`could not start ${cmd[0]}: ${error.message}`, 127)
  })
  child.on('exit', (code, signal) => {
    clearInterval(timer)
    pump()
    const exitCode = code ?? 128 + (SIGNALS[signal] ?? 9)
    const cancelled = fs.existsSync(path.join(job.dir, 'cancel-requested'))
    const status = cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed'
    // The runner's verdict (agy) or the last log line (Codex) says why, e.g. a timeout that agy itself
    // reported as SUCCESS.
    const verdict = readJson(path.join(job.dir, 'meta.json'))?.verdict ?? (exitCode ? progressLines(job).at(-1) : null)
    end(status, exitCode, verdict ? { verdict } : {})
    if (lock) fs.rmSync(lock.dir, { recursive: true, force: true })
    console.log(`${job.id} ${status} (exit ${exitCode}${verdict ? `: ${verdict}` : ''})`)
    console.log(`Answer: ${job.dir}/out.md · log: ${job.dir}/err.log`)
    process.exit(exitCode)
  })
}

const dur = (from, to) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000))
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}
const home = p => String(p ?? '').replace(os.homedir(), '~')

function cmdJobs(args) {
  const day = Date.now() - 864e5
  const jobs = allJobs().filter(
    j => args.includes('--all') || j.status === 'running' || Date.parse(j.createdAt) > day,
  )
  if (args.includes('--json')) return console.log(JSON.stringify(jobs, null, 2))
  if (!jobs.length) return console.log(`No jobs in the last 24 h under ${home(ROOT)}.`)
  for (const j of jobs) {
    const start = j.startedAt ?? j.createdAt
    const took = j.endedAt ? `took ${dur(start, j.endedAt)}` : `${j.status} for ${dur(start)}`
    const exit = j.exitCode != null ? ` exit ${j.exitCode}` : ''
    const scope = j.scope ? `  scope ${j.scope === 'ok' ? 'OK' : 'VIOLATION'}${j.commit ? ` · commit ${j.commit}` : ''}` : ''
    // meta.gate.verifier is set when an agy job with a gate ends.
    const v = j.gate?.verifier
    const verifier = v?.verdict ? ` · verifier ${v.verdict}${v.verdict === 'FAIL' ? ` (${v.findings ?? '?'})` : ''}` : ''
    const gate = j.gate?.verdict ? `  gate ${j.gate.verdict}${verifier}` : ''
    console.log(`${j.id}  ${j.endedAt ? j.status + exit + '  ' : ''}${took}${scope}${gate}  ${j.label ?? ''}`.trimEnd())
    console.log(`    ${home(j.cwd)}${j.branch ? ` (${j.branch})` : ''}  ${lastLine(j) ?? ''}`.trimEnd())
  }
  console.log(`\nProgress: node ${home(path.join(ROOT, 'jobs.mjs'))} tail <job>   Stop: … cancel <job>`)
}

// agy's stream has no hook events, so the gate's hooks write progress.jsonl themselves: one line when a
// gate check or a verifier run starts and ends. `offset` is the size of events.jsonl when the line was
// written, so the line goes after the events that end at or before it and the list only grows at the end.
function readHookProgress(dir) {
  let text
  try {
    text = fs.readFileSync(path.join(dir, 'progress.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(raw => {
    try {
      const e = JSON.parse(raw)
      return typeof e.text === 'string' ? [{ offset: Number(e.offset) || 0, text: e.text.replace(/\s+/g, ' ').trim().slice(0, 240) }] : []
    } catch {
      return []
    }
  })
}

// agy writes stream-json events; render them as one line per tool call or finished answer, with the
// gate's progress lines between them. Entries are {text, hook}, hook being true for a progress line.
function renderAgyEvents(file, cwd, partial, hooks = []) {
  const lines = []
  const add = (text, hook = false) => lines.push({ text, hook })
  let text = ''
  let next = 0
  const seen = new Set()
  const flush = upTo => {
    while (next < hooks.length && hooks[next].offset <= upTo) add(hooks[next++].text, true)
  }
  const buf = fs.readFileSync(file)
  for (let pos = 0; pos < buf.length; ) {
    // Byte positions, to match the size the hook recorded.
    const nl = buf.indexOf(10, pos)
    const end = nl < 0 ? buf.length : nl
    const [raw, start] = [buf.toString('utf8', pos, end), pos]
    pos = end + 1
    flush(start)
    let e
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    const s = e.step_update
    if (e.event === 'init') add(`agy started: ${e.init?.model} in ${home(e.init?.cwd)}`)
    if (e.event === 'result') {
      const r = e.result ?? {}
      add(`agy's turn ended: ${r.status} after ${Math.round(r.duration_seconds ?? 0)}s${r.error ? `: ${r.error.split('\n')[0]}` : ''}`)
    }
    if (!s) continue
    if (s.step_type === 'tool' && !seen.has(s.step_index)) {
      seen.add(s.step_index)
      const p = s.tool_info?.parameters ?? {}
      const target = p.TargetFile ?? p.AbsolutePath ?? p.CommandLine ?? p.Query ?? ''
      add(`${s.tool_name}  ${path.isAbsolute(target) ? path.relative(cwd, target) || '.' : target}`.trimEnd())
    }
    if (s.step_type === 'agent_response') {
      text += s.text_delta ?? ''
      if (s.state === 'DONE' && text.trim()) {
        add(`says: ${text.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
        text = ''
      }
    }
  }
  flush(Infinity)
  if (partial && text.trim()) add(`writing: …${text.trim().replace(/\s+/g, ' ').slice(-160)}`)
  return lines
}
// Streams (exec, tail -f) take only finished lines; snapshots also show the answer being written.
function progressEntries(job, { partial = false } = {}) {
  const events = path.join(job.dir, 'events.jsonl')
  if (fs.existsSync(events)) return renderAgyEvents(events, job.cwd ?? process.cwd(), partial, readHookProgress(job.dir))
  const err = path.join(job.dir, 'err.log')
  return (fs.existsSync(err) ? fs.readFileSync(err, 'utf8').split('\n').filter(Boolean) : []).map(text => ({ text, hook: false }))
}
const progressLines = (job, opts) => progressEntries(job, opts).map(e => e.text)
function lastLine(job) {
  const line = progressLines(job, { partial: true }).at(-1)
  return line && line.length > 110 ? `${line.slice(0, 107)}...` : line
}

// -f keeps following until the job ends and then prints its outcome, so `tail -f` works as an event
// stream for Claude Code's Monitor tool. --next waits for the next job to start, for a caller that
// has just dispatched a relay and does not know its job yet. --every <dur> condenses the stream to
// one summary line per interval, so a watching agent spends little context on it; the gate's progress
// lines (check and verifier start and result) still come through as they happen.
function cmdTail(args) {
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  const n = Number(opt('-n')) || 20
  const every = opt('--every')
  const everyMs = every ? (Number(/^(\d+)([sm]?)$/.exec(every)?.[1]) || 0) * (every.endsWith('m') ? 60e3 : 1e3) : 0
  if (every && !everyMs) fail(`bad --every "${every}"; use e.g. 30s or 2m`)
  const ref = args.find((a, i) => !a.startsWith('-') && !['-n', '--every'].includes(args[i - 1]))
  const keep = args.includes('-f') || args.includes('--next')
  if (!args.includes('--next')) return follow(resolveJob(ref), n, keep, everyMs)
  const since = Date.now() - 1000
  const timer = setInterval(() => {
    const job = allJobs().find(j => Date.parse(j.createdAt) >= since)
    if (!job) return
    clearInterval(timer)
    follow(job, n, true, everyMs)
  }, 1000)
}
function follow(job, n, keep, everyMs) {
  const clip = l => (l.length > 140 ? `${l.slice(0, 137)}...` : l)
  console.log(`${job.id} · ${job.status} · ${home(job.cwd)} · ${home(job.dir)}`)
  if (!keep) return progressLines(job, { partial: true }).slice(-n).forEach(l => console.log(l))
  let shown = progressEntries(job)
  if (!everyMs) shown.slice(-n).forEach(e => console.log(e.text))
  let pending = 0
  let latest = null
  let lastEmit = Date.now()
  const timer = setInterval(() => {
    const now = progressEntries(job)
    const fresh = now.slice(shown.length)
    shown = now
    if (!everyMs) fresh.forEach(e => console.log(e.text))
    else {
      // The gate's lines are few and say what a stalled-looking job is doing, so they are never condensed.
      for (const e of fresh) {
        if (e.hook) console.log(`${job.id} · ${clip(e.text)}`)
        else [pending, latest] = [pending + 1, e.text]
      }
    }
    if (everyMs && pending && Date.now() - lastEmit >= everyMs) {
      console.log(`${job.id} · +${pending} step(s) · ${clip(latest)}`)
      ;[pending, lastEmit] = [0, Date.now()]
    }
    const meta = readMeta(job.dir)
    if (['created', 'running'].includes(meta.status)) return
    clearInterval(timer)
    const exit = meta.exitCode == null ? '' : ` (exit ${meta.exitCode}${meta.verdict ? `: ${meta.verdict}` : ''})`
    console.log(`${job.id} ${meta.status}${exit}`)
  }, 2000)
}

function cmdCancel(args) {
  const job = resolveJob(args[0])
  if (job.status !== 'running') fail(`${job.id} is ${job.status}, not running`)
  fs.writeFileSync(path.join(job.dir, 'cancel-requested'), new Date().toISOString())
  process.kill(job.pid, 'SIGTERM')
  console.log(`Sent SIGTERM to ${job.id} (runner pid ${job.pid}); it stops the agent and records the exit.`)
}

// Worktree implementer helpers. They run on the Claude side, which can write the worktree's git
// metadata (it lives in the main checkout's .git/worktrees/) when the delegated agent cannot.
function cmdWtSetup(args) {
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  const top = gitOut(['rev-parse', '--show-toplevel']) ?? fail('not inside a git checkout')
  const gitDir = path.resolve(gitOut(['rev-parse', '--git-dir']))
  const commonDir = path.resolve(gitOut(['rev-parse', '--git-common-dir']))
  if (gitDir === commonDir && !args.includes('--allow-main'))
    fail(`${top} is a main checkout, not a linked worktree; pass --allow-main if that is intended`)
  if (gitOut(['status', '--porcelain', '--untracked-files=no']))
    fail(`${top} has uncommitted changes to tracked files; refusing to reset`)
  const base = opt('--base')
  if (base) {
    let sha = gitOut(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    if (!sha) {
      git(['fetch', '--quiet', 'origin', base])
      sha = gitOut(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) ?? fail(`unknown ref ${base}`)
    }
    const head = gitOut(['rev-parse', 'HEAD'])
    const kept = git(['merge-base', '--is-ancestor', head, sha]).status === 0 ||
      gitOut(['for-each-ref', '--contains', head, '--format=%(refname)'])
        ?.split('\n').some(r => r && r !== `refs/heads/${gitOut(['branch', '--show-current'])}`)
    if (!kept) fail(`HEAD ${head.slice(0, 10)} has commits no other ref holds; refusing to reset`)
    // `reset --keep` refuses to overwrite untracked files but not gitignored ones, so check those.
    const target = new Set(gitOut(['ls-tree', '-r', '--name-only', sha]).split('\n'))
    const ignored = (gitOut(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']) ?? '')
      .split('\n')
      .filter(Boolean)
    const hit = ignored.filter(p => (p.endsWith('/') ? [...target].some(t => t.startsWith(p)) : target.has(p)))
    if (hit.length) fail(`${base} tracks paths that are gitignored local files here: ${hit.slice(0, 5).join(', ')}`)
    const r = git(['reset', '--keep', sha])
    if (r.status !== 0) fail(`git reset --keep ${base} refused:\n${r.stderr.trim()}`)
  }
  if (args.includes('--install')) {
    const pm = [
      ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
      ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
      ['bun.lockb', 'bun', ['install', '--frozen-lockfile']],
      ['yarn.lock', 'yarn', ['install', '--immutable']],
      ['package-lock.json', 'npm', ['ci']],
    ].find(([lock]) => fs.existsSync(path.join(top, lock)))
    if (!pm) fail('--install: no lockfile found')
    // `full` (default) prefers the repo's own bootstrap (env files, dev-branch sync); `deps` only
    // installs dependencies, which is enough for lint, type-check and most tests.
    const mode = opt('--install') === 'deps' ? 'deps' : 'full'
    const scripts = readJson(path.join(top, 'package.json'))?.scripts ?? {}
    const bootstrap = mode === 'full' && scripts['setup-worktree']
    const run = bootstrap ? [pm[1], ['run', 'setup-worktree']] : [pm[1], pm[2]]
    // Bootstraps can prompt (1Password for env files) and collide when worktrees start together, so
    // only one runs at a time on this machine; wait up to 5 minutes for the previous one.
    let lock = null
    if (bootstrap) {
      const deadline = Date.now() + 5 * 60_000
      while ((lock = takeLock('setup-worktree', top)).busy) {
        if (Date.now() > deadline)
          fail(`another setup-worktree (${lock.busy}) is still running after 5 min; retry, or use --install deps`)
        spawnSync('sleep', ['5'])
      }
    }
    console.log(`$ ${run[0]} ${run[1].join(' ')}`)
    const r = spawnSync(run[0], run[1], { cwd: top, stdio: ['ignore', 'inherit', 'inherit'] })
    if (lock?.dir) fs.rmSync(lock.dir, { recursive: true, force: true })
    if (r.status !== 0) fail(`${run[0]} ${run[1].join(' ')} exited ${r.status}`)
  }
  console.log(`ready: ${top} · branch ${gitOut(['branch', '--show-current']) || '(detached)'} · HEAD ${gitOut(['rev-parse', '--short', 'HEAD'])}`)
}

function changedPaths() {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.split('\0')
  const files = []
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) continue
    files.push({ code: out[i].slice(0, 2), file: out[i].slice(3) })
    if (/[RC]/.test(out[i].slice(0, 2))) files.push({ code: 'D ', file: out[++i] })
  }
  return files
}
// `**/` spans whole directories (zero or more), `**` anything, `*` and `?` stay within one segment.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 1
    } else if (glob[i] === '*') re += '[^/]*'
    else if (glob[i] === '?') re += '[^/]'
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
// Prints the verdict first (SCOPE OK / SCOPE VIOLATION) and, with --job, records it in that job's
// meta.json so `jobs` shows it. Out-of-scope paths are never committed.
function cmdWtFinish(args) {
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
  // --paths takes the brief's `paths:` value as one argument; quote an entry that contains spaces.
  // --path <p> can be repeated instead.
  const scope = [
    ...[...(opt('--paths') ?? '').matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)].map(m => m[1] ?? m[2] ?? m[3]),
    ...args.flatMap((a, i) => (a === '--path' && args[i + 1] ? [args[i + 1]] : [])),
  ].filter(Boolean)
  if (!scope.length) fail('wt-finish needs --paths or --path')
  const job = opt('--job') ? resolveJob(opt('--job')) : null
  const record = patch => job && updateMeta(job.dir, patch)
  const top = gitOut(['rev-parse', '--show-toplevel'])
  process.chdir(top)
  const inScope = file =>
    scope.some(p => {
      const clean = p.replace(/^\.\//, '')
      if (clean.endsWith('/') || (fs.existsSync(clean) && fs.statSync(clean).isDirectory()))
        return file.startsWith(clean.replace(/\/?$/, '/'))
      return globToRegExp(clean).test(file)
    })
  const changed = changedPaths()
  if (!changed.length) {
    record({ scope: 'ok', scopeDetail: 'no changes' })
    return console.log('SCOPE OK: no changes in the checkout.')
  }
  const outside = changed.filter(c => !inScope(c.file))
  if (outside.length) {
    record({ scope: 'violation', outside: outside.map(c => c.file) })
    console.log(`SCOPE VIOLATION: ${outside.length} of ${changed.length} changed path(s) are outside --paths. Nothing committed.`)
    outside.forEach(c => console.log(`  outside: ${c.code} ${c.file}`))
    console.log('In scope:')
    changed.filter(c => inScope(c.file)).forEach(c => console.log(`  ${c.code} ${c.file}`))
    process.exit(2)
  }
  console.log(`SCOPE OK: all ${changed.length} changed path(s) are inside --paths.`)
  changed.forEach(c => console.log(`  ${c.code} ${c.file}`))
  const message = opt('--message')
  if (!message) {
    record({ scope: 'ok', commit: null })
    return console.log('Not committing (no --message).')
  }
  const add = git(['add', '-A', '--', ...new Set(changed.map(c => c.file))])
  if (add.status !== 0) fail(add.stderr.trim())
  const commit = git(['commit', '-q', '-m', message])
  if (commit.status !== 0) {
    record({ scope: 'ok', commit: 'failed' })
    fail(`git commit failed:\n${commit.stdout}${commit.stderr}`)
  }
  record({ scope: 'ok', commit: gitOut(['rev-parse', '--short', 'HEAD']) })
  console.log(git(['show', '--stat', '--format=committed %h %s', 'HEAD']).stdout.trim())
}

// The logic is in diff.mjs. It is loaded here, not at the top, so the copy at ROOT/jobs.mjs still starts
// when the module next to it is missing.
async function cmdDiff(args) {
  const ref = args.includes('--job') ? args[args.indexOf('--job') + 1] : null
  const job = ref ? resolveJob(ref) : null
  const mod = await import('./diff.mjs').catch(e =>
    fail(e.code === 'ERR_MODULE_NOT_FOUND' ? "diff.mjs is missing next to this jobs.mjs, probably an old copy. Use the plugin's delegate-jobs, or start any delegate job to refresh the copy" : e.message),
  )
  try {
    mod.cmdDiff(args, job)
  } catch (e) {
    fail(e.message)
  }
}

// The logic is in gate.mjs, one of SIBLINGS. A crash exits 2 (could not run), never 1 (findings added).
async function cmdGate(args) {
  const mod = await import('./gate.mjs').catch(e =>
    fail(e.code === 'ERR_MODULE_NOT_FOUND' ? "gate.mjs is missing next to this jobs.mjs, probably an old copy. Use the plugin's delegate-jobs, or start any delegate job to refresh the copy" : e.message, 2),
  )
  await mod.cmdGate(args).catch(e => fail(`GATE ERROR: ${e.stack ?? e.message}`, 2))
}

const commands = {
  new: cmdNew,
  exec: cmdExec,
  jobs: cmdJobs,
  status: cmdJobs,
  tail: cmdTail,
  cancel: cmdCancel,
  'wt-setup': cmdWtSetup,
  'wt-finish': cmdWtFinish,
  diff: cmdDiff,
  gate: cmdGate,
}
if (path.basename(process.argv[1] ?? '') === 'jobs.mjs') {
  const [cmd, ...args] = process.argv.slice(2)
  if (!commands[cmd]) {
    console.log(USAGE)
    process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0)
  }
  commands[cmd](args)
}
