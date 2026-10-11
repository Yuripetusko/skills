#!/usr/bin/env node
// Runs one Google Antigravity (agy) job headless for a Claude subagent and classifies the outcome.
// stdout gets agy's final answer, minus leading waiting-status lines; stderr and <job>/report.md get the runner's report: exit
// reason, files agy wrote (from its tool calls), commands it ran, calls the job's hooks blocked, and git
// status after the run. agy runs as the per-job agent in $JOB/agy/, whose hooks enforce the job rules.
// Behaviour this relies on was measured on agy 1.3.3; see SKILL.md, "Measured on agy 1.3.3".

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANARY, readHookLog, STATE, stateHash } from './hooks/job.mjs'
import { updateMeta } from './jobs.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODEL = 'gemini-3.8-flash-high'
const DEFAULT_TIMEOUT = '30m'
const MAX_TIMEOUT_S = 110 * 60 // the relay's background Bash call dies at 2 h
const GUARD_S = 120 // wall clock past --print-timeout before the runner kills agy itself
const EXIT = { ok: 0, usage: 1, failed: 2, empty: 3, quota: 10, auth: 11, timeout: 12, missing: 13, model: 14, denied: 15, setup: 18 }
// The job's main agent. AGY_DELEGATE_AGENT overrides the --agent name only, for testing the setup checks.
const AGENT = 'delegate-implementer'
// Names from agy 1.3.3's init event. Left out: subagent, browser, MCP, image and permission tools.
const AGENT_TOOLS = [
  'view_file', 'list_dir', 'find_by_name', 'grep_search',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file',
  'run_command', 'command_status', 'send_command_input', 'manage_task', 'schedule', 'wait',
  'search_web', 'read_url_content',
]
const LABEL = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k]))
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

const log = msg => process.stderr.write(`[agy] ${msg}\n`)
const die = (code, msg) => {
  log(msg)
  process.exit(code)
}
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
const size = file => (fs.existsSync(file) ? fs.statSync(file).size : 0)
// Reads from byte `from` on, so a rerun in the same job dir ignores the earlier executions' output.
const readFrom = (file, from = 0) => (fs.existsSync(file) ? fs.readFileSync(file).subarray(from).toString('utf8') : '')
const readEvents = (file, from = 0) =>
  readFrom(file, from)
    .split('\n')
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })

// agy narrates while it waits on a background command ("I am waiting for the type-check to complete")
// and those lines can lead its final answer. out.md drops them; events.jsonl keeps the raw text.
// Each template is a status sentence seen in the field. A line that fits none of them stays.
const CHECK = String.raw`(?:type-?check|lint(?:er)?|checks?|task|command|tests?)`
const WAITING = [
  // "I am waiting for the lint check on a package to finish." / "Waiting for task to complete."
  new RegExp(String.raw`^(?:I am waiting|I'm waiting|Waiting) for [^.!?]{0,100}?\b${CHECK}\b[^.!?]{0,60}? to (?:complete|finish)\.$`, 'i'),
  // "I have started the lint check and will wait for it to complete."
  /^I have (?:launched|started|run) [^.!?]{1,120}? and (?:will wait|am waiting) for (?:it|them|the command|the check) to (?:complete|finish)\.$/i,
  // "The type-check command is running in the background." / "Baseline lint check is running across packages."
  /^(?:(?:the|this) )?(?:(?:baseline|total|target|full) )*(?:type-?check|lint(?:er)?)(?: (?:check|command|task))? is running (?:in the background|across [^.!?]{0,60})\.$/i,
  // "I will await its completion." / "I will wait for it to complete."
  /^I will (?:await its completion|wait for it to (?:complete|finish))\.$/i,
]
const isWaitingLine = line =>
  line
    .trim()
    .split(/(?<=[.!?])\s+/)
    .every(s => WAITING.some(re => re.test(s)))
// Only leading lines go, up to the first line that is not a waiting line. An answer that is nothing
// but waiting lines stays as it is.
function dropWaitingLines(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && (!lines[i].trim() || isWaitingLine(lines[i]))) i++
  const dropped = lines.slice(0, i).filter(l => l.trim()).length
  const rest = lines.slice(i).join('\n')
  return dropped && rest.trim() ? { text: rest, dropped } : { text, dropped: 0 }
}

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--read-only') opts.readOnly = true
    else if (['--job-dir', '--mode', '--model', '--timeout', '--resume'].includes(a)) opts[a.slice(2)] = argv[++i]
    else if (a.startsWith('-')) die(EXIT.usage, `unknown option ${a}`)
    else opts._.push(a)
  }
  return opts
}

function findAgy() {
  const local = path.join(os.homedir(), '.local', 'bin', 'agy')
  for (const c of [process.env.AGY_BIN, local]) if (c && fs.existsSync(c)) return c
  const r = spawnSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

// `agy models` checks sign-in and the model in ~2 s. An unauthenticated `agy -p` would instead open
// a browser login and block for 60 s.
function preflight(agy, model) {
  const r = spawnSync(agy, ['models'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    const text = `${r.stdout}\n${r.stderr}`.trim()
    if (/sign in|authenticat/i.test(text)) die(EXIT.auth, 'agy is not signed in; the user must run `agy` once in a terminal.')
    die(EXIT.failed, `\`agy models\` failed (${r.status ?? r.signal}): ${text.split('\n').at(-1)}`)
  }
  const models = r.stdout.split('\n').map(l => l.split('\t')[0].trim()).filter(l => /^[\w.-]+$/.test(l))
  if (model && !models.includes(model)) die(EXIT.model, `model "${model}" is not in \`agy models\`: ${models.join(', ')}`)
  return models
}

// The brief's `paths:` header, split like wt-finish's --paths.
function briefPaths(brief) {
  for (const line of brief.split('\n')) {
    const m = /^([a-z]+):\s*(.*)$/.exec(line.trim())
    if (!m) break
    if (m[1] === 'paths') return [...m[2].matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)].map(x => x[1] ?? x[2] ?? x[3]).filter(Boolean)
  }
  return []
}

const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`

// $JOB/agy/ is passed with --add-dir and holds config only: agy can read it, and write it through shell
// commands. The hooks keep their state, log and canary directly under $JOB/.
function writeJobConfig({ dir, cwd, mode, readOnly, model, paths }) {
  // The hooks resolve paths: against the checkout's top level, as wt-finish does.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  const worktree = fs.realpathSync(top.status === 0 ? top.stdout.trim() : cwd)
  const agyDir = path.join(dir, 'agy')
  fs.mkdirSync(path.join(agyDir, '.agents', 'agents'), { recursive: true })
  const hook = (name, timeout) => ({
    type: 'command',
    command: `${shellQuote(process.execPath)} ${shellQuote(path.join(SKILL_DIR, 'scripts', 'hooks', `${name}.mjs`))}`,
    timeout,
  })
  const hooks = {
    'agy-delegate-job': {
      PreToolUse: [{ matcher: '', hooks: [hook('pre-tool', 30)] }],
      PreInvocation: [hook('pre-invocation', 30)],
    },
  }
  fs.writeFileSync(path.join(agyDir, '.agents', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`)

  const implement = mode === 'implement'
  const scope = readOnly
    ? 'This job is read-only: every file write is blocked.'
    : implement && paths.length
      ? `Change only these paths: ${paths.map(p => `\`${p}\``).join(' ')}. Ticket files (\`*-ticket.md\`), MAP.md and SPEC.md stay unchanged even when listed.`
      : implement
        ? 'Change only the files the task names.'
        : ''
  const blocked = [
    'git commands that change repository state',
    'other AI CLIs',
    ...(implement ? ['`gh` commands that write to GitHub', 'dependency changes'] : []),
    ...(implement ? [paths.length ? 'file writes outside the paths above' : 'file writes outside the worktree'] : []),
    ...(readOnly ? ['file writes'] : []),
  ]
  const vars = {
    job: path.basename(dir),
    model,
    mode,
    tools: AGENT_TOOLS.join(', '),
    cwd,
    scope,
    blocked: `${blocked.slice(0, -1).join(', ')} and ${blocked.at(-1)}`,
  }
  const template = read(path.join(SKILL_DIR, 'prompts', 'agents', `${AGENT}.md`))
  const agent = template.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m).replace(/ +\n/g, '\n')
  fs.writeFileSync(path.join(agyDir, '.agents', 'agents', `${AGENT}.md`), agent)
  const state = { job: dir, worktree, mode, readOnly: Boolean(readOnly), paths, agent: AGENT, model, createdAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, STATE), `${JSON.stringify(state, null, 2)}\n`)
  return { agyDir, stateSha: stateHash(state) }
}

const SLASH_TIMEOUT_S = 60

// `/hooks` and `/agents` answer from config without calling a model. Our hooks must be listed from our
// hooks.json, and the --agent name must be listed: agy runs its default agent for an unknown one.
// Returns null when both pass, else what failed.
function checkJobConfig(agy, cwd, agyDir, agent) {
  // Only a clean exit counts: a call that timed out or crashed may still have printed JSON.
  const slash = command => {
    const r = spawnSync(agy, ['-p', command, '--output-format', 'json', '--add-dir', agyDir, '--agent', agent], {
      cwd,
      encoding: 'utf8',
      timeout: SLASH_TIMEOUT_S * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const call = `\`agy -p ${command}\``
    if (r.error?.code === 'ETIMEDOUT') throw new Error(`${call} timed out after ${SLASH_TIMEOUT_S}s`)
    if (r.error) throw new Error(`${call} could not run: ${r.error.message}`)
    if (r.signal) throw new Error(`${call} was killed by ${r.signal}`)
    if (r.status !== 0) throw new Error(`${call} exited ${r.status}: ${r.stderr.trim().split('\n').at(-1) || 'no detail'}`)
    try {
      return JSON.parse(r.stdout).command?.data ?? null
    } catch {
      throw new Error(`${call} printed no JSON`)
    }
  }
  try {
    return checkListings(slash, agyDir, agent)
  } catch (error) {
    return error.message
  }
}
function checkListings(slash, agyDir, agent) {
  const real = file => {
    try {
      return fs.realpathSync(file)
    } catch {
      return file
    }
  }
  const ours = real(path.join(agyDir, '.agents', 'hooks.json'))
  const listed = (slash('/hooks')?.hooks ?? []).filter(h => h.enabled !== false && real(h.source ?? '') === ours)
  const events = new Set(listed.flatMap(h => (h.actions ?? []).map(a => a.event)))
  const missing = ['PreToolUse', 'PreInvocation'].filter(e => !events.has(e))
  if (missing.length) return `\`agy -p /hooks\` does not list this job's ${missing.join(' and ')} hook from ${ours}`
  const agents = slash('/agents')?.agents ?? []
  if (!agents.includes(agent)) return `\`agy -p /agents\` does not list agent "${agent}" (it lists: ${agents.join(', ') || 'none'})`
  return null
}

function seconds(text) {
  const m = /^(\d+)([smh]?)$/.exec(String(text).trim())
  if (!m) die(EXIT.usage, `bad --timeout "${text}"; use e.g. 90s, 30m, 1h`)
  const s = Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600 }[m[2]]
  if (s > MAX_TIMEOUT_S) log(`--timeout capped at ${MAX_TIMEOUT_S / 60}m (the relay's Bash call ends at 2 h)`)
  return Math.min(s, MAX_TIMEOUT_S)
}

function gitStatus(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8' })
  if (r.status !== 0) return null
  return new Map(r.stdout.split('\n').filter(Boolean).map(l => [l.slice(3), l.slice(0, 2)]))
}

function classifyError(text) {
  if (/sign in|authenticat|unauthorized|reauth/i.test(text)) return EXIT.auth
  if (/quota|rate.?limit|resource.?exhausted|\b429\b/i.test(text)) return EXIT.quota
  if (/not recognized as a known model|invalid model/i.test(text)) return EXIT.model
  if (/deadline exceeded|timed out/i.test(text)) return EXIT.timeout
  return EXIT.failed
}

// agy runs shell commands in their own process groups and can leave them behind when it exits (seen
// after --print-timeout). macOS gives no containment, so the runner snapshots agy's descendants every
// second, remembers their process groups, and at the end stops every group that still holds one of
// them: SIGTERM, then SIGKILL after 5 s. A command that starts and detaches within one snapshot
// interval can still escape.
const psTable = () =>
  spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map(l => /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(l))
    .filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4].trim() }))
function descendants(rootPid, into) {
  const rows = psTable()
  const stack = [rootPid]
  while (stack.length) {
    const parent = stack.pop()
    for (const row of rows.filter(r => r.ppid === parent)) {
      into.set(row.pid, row)
      stack.push(row.pid)
    }
  }
}
async function reap(tracked, agyPid) {
  const own = psTable().find(r => r.pid === process.pid)?.pgid
  // A tracked pid counts only while it still runs the same command: pids get reused.
  const survivors = () => {
    const now = new Map(psTable().map(r => [r.pid, r]))
    return [...tracked.values()].filter(t => now.get(t.pid)?.command === t.command)
  }
  const first = survivors()
  const groups = new Set([agyPid, ...first.map(t => t.pgid)].filter(g => g > 1 && g !== own))
  const signal = sig => {
    for (const g of groups) {
      try {
        process.kill(-g, sig)
      } catch {}
    }
    for (const t of survivors()) {
      try {
        process.kill(t.pid, sig)
      } catch {}
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 25 && survivors().length; i++) await new Promise(r => setTimeout(r, 200))
  if (survivors().length) signal('SIGKILL')
  return first.map(t => t.command)
}

function report({ cwd, dir, model, exit, why, result, events, before, readOnly, stopped, denies, loaded }) {
  // Count a tool call when it starts: a backgrounded command never reaches DONE.
  const byStep = new Map()
  for (const s of events.map(e => e.step_update)) if (s?.step_type === 'tool') byStep.set(s.step_index, s)
  const tools = [...byStep.values()]
  const rel = p => (path.isAbsolute(p) ? path.relative(cwd, p) : p)
  const writes = [...new Set(tools.map(t => t.tool_info?.parameters?.TargetFile).filter(Boolean).map(rel))]
  const inside = writes.filter(w => !w.startsWith('..') && !path.isAbsolute(w))
  const ignored = new Set(
    inside.length ? spawnSync('git', ['check-ignore', ...inside], { cwd, encoding: 'utf8' }).stdout.split('\n') : [],
  )
  const commands = tools.filter(t => t.tool_name === 'run_command').map(t => t.tool_info?.parameters?.CommandLine)
  const blockedTargets = new Set(denies.map(d => (d.tool === 'run_command' ? d.target : rel(d.target ?? ''))))
  const mark = item => (blockedTargets.has(item) ? '   (blocked)' : '')
  const after = gitStatus(cwd)
  const changed = after ? [...after].filter(([f, code]) => before?.get(f) !== code) : []
  const preDirty = after ? [...after].filter(([f, code]) => before?.get(f) === code).length : 0
  const lines = [
    '## agy runner report',
    `- exit ${exit} (${LABEL[exit] ?? 'signal'}): ${why}`,
    `- model ${model} · ${Math.round(result?.duration_seconds ?? 0)}s · conversation ${result?.conversation_id || '-'}`,
    `- files agy wrote with its edit tools${writes.length ? ':' : ': none'}`,
    ...writes.map(w => {
      const flag = mark(w) || (!inside.includes(w) ? '   ⚠ outside the checkout' : ignored.has(w) ? '   ⚠ gitignored' : '')
      return `  - ${w}${flag}`
    }),
    `- commands agy ran${commands.length ? ' (shell writes do not show up above):' : ': none'}`,
    ...commands.map(c => `  - \`${String(c).replace(/`/g, "'")}\`${mark(c)}`),
    loaded
      ? `- blocked by job rules${denies.length ? ` (${denies.length}):` : ': none'}`
      : '- ⚠ job rules did not load (no canary): nothing was blocked or logged',
    ...denies.map(d => {
      const target = d.tool === 'run_command' ? `\`${String(d.target ?? '').replace(/`/g, "'")}\`` : d.target ? rel(d.target) : d.error ?? ''
      return `  - ${d.tool ?? 'unknown tool'} ${target} (${d.rule})`
    }),
    after ? `- git status after the run${changed.length ? ':' : ': no new changes'}` : '- not a git checkout',
    ...changed.map(([f, code]) => `  - ${code} ${f}`),
    ...(preDirty ? [`  (${preDirty} path(s) were already dirty before the run and are not listed)`] : []),
    ...(tools.some(t => /subagent/.test(t.tool_name ?? ''))
      ? ["- ⚠ agy ran its own subagents: their edits and commands are not listed above; git status is the full record"]
      : []),
    ...(readOnly && (writes.some(w => !mark(w)) || changed.length) ? ['- ⚠ read-only job, but files changed'] : []),
    ...(stopped.length ? [`- stopped processes agy left running: ${stopped.map(c => `\`${c.slice(0, 80)}\``).join(', ')}`] : []),
    `- job dir: ${dir}`,
  ]
  fs.writeFileSync(path.join(dir, 'report.md'), `${lines.join('\n')}\n`)
  process.stderr.write(`${lines.join('\n')}\n`)
}

function run(opts) {
  const dir = path.resolve(opts['job-dir'] ?? die(EXIT.usage, 'run needs --job-dir'))
  const brief = read(path.join(dir, 'brief.md')).trim() || die(EXIT.usage, `${dir}/brief.md is missing or empty`)
  const mode = opts.mode ?? 'task'
  if (!['task', 'implement'].includes(mode)) die(EXIT.usage, `--mode must be task or implement`)
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutS = seconds(opts.timeout ?? DEFAULT_TIMEOUT)
  const cwd = process.cwd()
  const agy = findAgy() ?? die(EXIT.missing, 'agy is not installed (looked in $AGY_BIN, ~/.local/bin, PATH)')
  preflight(agy, model)
  const realCwd = fs.realpathSync(cwd)
  const agent = process.env.AGY_DELEGATE_AGENT || AGENT
  const setupFailed = msg => {
    updateMeta(dir, { verdict: msg })
    die(EXIT.setup, msg)
  }
  let agyDir
  let stateSha
  try {
    ;({ agyDir, stateSha } = writeJobConfig({ dir, cwd: realCwd, mode, readOnly: opts.readOnly, model, paths: briefPaths(brief) }))
  } catch (error) {
    setupFailed(`could not write the job config: ${error.message}`)
  }
  const problem = checkJobConfig(agy, cwd, agyDir, agent)
  if (problem) setupFailed(`job rules did not load: ${problem}`)

  const prompt = [
    read(path.join(SKILL_DIR, 'prompts', 'preamble.md')).trim(),
    mode === 'implement' ? read(path.join(SKILL_DIR, 'prompts', 'implementer.md')).trim() : '',
    opts.readOnly ? 'This is a read-only job: do not create, modify or delete any files.' : '',
    '--- task ---',
    brief,
  ].filter(Boolean)
  // The brief goes in through stdin as one stream-json message, so it never shows up in `ps`.
  const input = path.join(dir, 'input.jsonl')
  fs.writeFileSync(input, `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt.join('\n\n') } })}\n`)
  const eventsFile = path.join(dir, 'events.jsonl')
  const agyErr = path.join(dir, 'agy-stderr.log')
  const before = gitStatus(cwd)
  // This execution's evidence only: a rerun in the same job dir appends to both logs, and an old
  // canary or hook.log line must not count.
  const [eventsStart, errStart] = [size(eventsFile), size(agyErr)]
  const runId = randomUUID()
  const canary = path.join(dir, CANARY)
  fs.rmSync(canary, { force: true })

  const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model]
  args.push('--dangerously-skip-permissions', '--print-timeout', `${timeoutS}s`, '--add-dir', agyDir, '--agent', agent)
  if (opts.resume) args.push('--conversation', opts.resume)
  const child = spawn(agy, args, {
    cwd,
    detached: true, // own process group, so cancel and timeouts also stop the commands agy started
    env: {
      ...process.env,
      AGY_DELEGATE_JOB: dir,
      AGY_DELEGATE_RUN: runId,
      AGY_DELEGATE_STATE_SHA: stateSha,
      AGY_DELEGATE_ROLE: '',
    },
    stdio: [fs.openSync(input, 'r'), fs.openSync(eventsFile, 'a'), fs.openSync(agyErr, 'a')],
  })
  log(`${mode} job started: ${model}, print-timeout ${timeoutS}s, pid ${child.pid}, cwd ${cwd}`)

  let stopReason = null
  const stop = why => {
    stopReason ??= why
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 10_000).unref()
  }
  const guard = setTimeout(() => stop('guard'), (timeoutS + GUARD_S) * 1000)
  for (const sig of Object.keys(SIGNALS)) process.on(sig, () => stop(sig))
  // agy must bind to this checkout. It did on 1.3.3; fail fast if a later version picks another root.
  const checkBinding = () => {
    const init = readEvents(eventsFile, eventsStart).find(e => e.event === 'init')?.init
    if (!init) return false
    let bound = init.cwd
    try {
      bound = fs.realpathSync(init.cwd)
    } catch {}
    if (bound !== realCwd) stop(`workspace ${init.cwd}`)
    return true
  }
  const watcher = setInterval(() => checkBinding() && clearInterval(watcher), 1000)
  // PreInvocation writes the canary before the first model call. A finished step without it means the
  // job's hooks are not running, so nothing is enforced.
  const loadedNow = () => {
    try {
      return JSON.parse(fs.readFileSync(canary, 'utf8')).run === runId
    } catch {
      return false
    }
  }
  const checkCanary = () => {
    if (loadedNow()) return true
    const stepDone = readEvents(eventsFile, eventsStart).some(
      e => ['tool', 'agent_response'].includes(e.step_update?.step_type) && e.step_update.state === 'DONE',
    )
    if (stepDone) stop('setup')
    return stepDone
  }
  const canaryWatch = setInterval(() => checkCanary() && clearInterval(canaryWatch), 1000)
  const tracked = new Map()
  const tracker = setInterval(() => descendants(child.pid, tracked), 1000)

  child.on('exit', async code => {
    clearTimeout(guard)
    clearInterval(watcher)
    clearInterval(canaryWatch)
    clearInterval(tracker)
    const stopped = await reap(tracked, child.pid)
    checkBinding()
    const events = readEvents(eventsFile, eventsStart)
    const result = events.findLast(e => e.event === 'result')?.result
    const errText = readFrom(agyErr, errStart)
    const loaded = loadedNow()
    const said = events
      .map(e => e.step_update)
      .filter(s => s?.step_type === 'agent_response')
      .map(s => s.text_delta ?? '')
      .join('')
    let exit
    let why
    if (SIGNALS[stopReason]) [exit, why] = [128 + SIGNALS[stopReason], `runner got ${stopReason}; agy was stopped`]
    else if (stopReason?.startsWith('workspace')) [exit, why] = [EXIT.failed, `agy bound to ${stopReason.slice(10)}, not ${cwd}`]
    else if (stopReason === 'setup')
      [exit, why] = [EXIT.setup, `job rules did not load: agy finished a step with no canary ($JOB/${CANARY}) and was stopped`]
    else if (stopReason === 'guard') [exit, why] = [EXIT.timeout, `agy outlived --print-timeout by ${GUARD_S}s and was killed`]
    else if (!loaded) {
      const detail = `${result?.error ?? ''}\n${errText}`.trim().split('\n')[0]
      ;[exit, why] = [EXIT.setup, `job rules did not load: no canary ($JOB/${CANARY}) after the run${detail ? `; agy said: ${detail}` : ''}`]
    } else if (/print timeout after .*partial output/.test(errText))
      [exit, why] = [EXIT.timeout, `--print-timeout (${timeoutS}s) expired mid-turn; the answer is partial`]
    else if (result?.denied_actions?.length)
      [exit, why] = [EXIT.denied, `agy was denied: ${result.denied_actions.map(d => d.display_name ?? d.action).join(', ')}`]
    else if (!result || result.status !== 'SUCCESS' || result.error || /AGY_ERROR/.test(errText) || code !== 0) {
      const detail = `${result?.error ?? ''}\n${errText}`.trim()
      ;[exit, why] = [classifyError(detail), `agy ${result?.status ?? `exited ${code}`}: ${detail.split('\n')[0] || 'no detail'}`]
    } else if (!result.response?.trim()) [exit, why] = [EXIT.empty, 'agy reported success with an empty answer']
    else [exit, why] = [EXIT.ok, 'agy finished']

    const answer = result?.response?.trim() ? result.response : said
    const { text: shown, dropped } = dropWaitingLines(answer)
    if (dropped) log(`dropped ${dropped} leading waiting line(s) from the answer; events.jsonl keeps them`)
    if (shown.trim()) process.stdout.write(shown.endsWith('\n') ? shown : `${shown}\n`)
    const denies = readHookLog(dir).filter(e => e.run === runId && e.hook === 'PreToolUse' && e.decision === 'deny')
    report({ cwd, dir, model, exit, why, result, events, before, readOnly: opts.readOnly, stopped, denies, loaded })
    updateMeta(dir, { verdict: why, blocked: denies.length })
    process.exit(exit)
  })
}

const [cmd, ...rest] = process.argv.slice(2)
const opts = parseArgs(rest)
if (cmd === 'run') run(opts)
else if (cmd === 'check') {
  const agy = findAgy() ?? die(EXIT.missing, 'agy is not installed (looked in $AGY_BIN, ~/.local/bin, PATH)')
  const models = preflight(agy, opts.model ?? null)
  console.log(`agy ${spawnSync(agy, ['--version'], { encoding: 'utf8' }).stdout.trim()} at ${agy}, signed in`)
  console.log(`models: ${models.join(', ')}`)
} else {
  console.log(`Usage:
  node agy-run.mjs run --job-dir <dir> [--mode task|implement] [--read-only] [--model <id>] [--timeout 30m] [--resume <conversation-id>]
  node agy-run.mjs check [--model <id>]
Default model ${DEFAULT_MODEL}; exit codes: ${Object.entries(EXIT).map(([k, v]) => `${v} ${k}`).join(', ')}`)
  process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? EXIT.usage : 0)
}
