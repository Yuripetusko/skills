#!/usr/bin/env node
// Runs one Google Antigravity (agy) job headless for a Claude subagent and classifies the outcome.
// stdout gets agy's final answer, minus leading waiting-status lines; stderr and <job>/report.md get the runner's report: exit
// reason, files agy wrote (from its tool calls), commands it ran, and git status after the run.
// Behaviour this relies on was measured on agy 1.3.3; see SKILL.md, "Measured on agy 1.3.3".

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateMeta } from './jobs.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODEL = 'gemini-3.8-flash-high'
const DEFAULT_TIMEOUT = '30m'
const MAX_TIMEOUT_S = 110 * 60 // the relay's background Bash call dies at 2 h
const GUARD_S = 120 // wall clock past --print-timeout before the runner kills agy itself
const EXIT = { ok: 0, usage: 1, failed: 2, empty: 3, quota: 10, auth: 11, timeout: 12, missing: 13, model: 14, denied: 15 }
const LABEL = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k]))
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

const log = msg => process.stderr.write(`[agy] ${msg}\n`)
const die = (code, msg) => {
  log(msg)
  process.exit(code)
}
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
const readEvents = file =>
  read(file)
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

function report({ cwd, dir, model, exit, why, result, events, before, readOnly, stopped }) {
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
  const after = gitStatus(cwd)
  const changed = after ? [...after].filter(([f, code]) => before?.get(f) !== code) : []
  const preDirty = after ? [...after].filter(([f, code]) => before?.get(f) === code).length : 0
  const lines = [
    '## agy runner report',
    `- exit ${exit} (${LABEL[exit] ?? 'signal'}): ${why}`,
    `- model ${model} · ${Math.round(result?.duration_seconds ?? 0)}s · conversation ${result?.conversation_id || '-'}`,
    `- files agy wrote with its edit tools${writes.length ? ':' : ': none'}`,
    ...writes.map(w => {
      const flag = !inside.includes(w) ? '   ⚠ outside the checkout' : ignored.has(w) ? '   ⚠ gitignored' : ''
      return `  - ${w}${flag}`
    }),
    `- commands agy ran${commands.length ? ' (shell writes do not show up above):' : ': none'}`,
    ...commands.map(c => `  - \`${String(c).replace(/`/g, "'")}\``),
    after ? `- git status after the run${changed.length ? ':' : ': no new changes'}` : '- not a git checkout',
    ...changed.map(([f, code]) => `  - ${code} ${f}`),
    ...(preDirty ? [`  (${preDirty} path(s) were already dirty before the run and are not listed)`] : []),
    ...(tools.some(t => /subagent/.test(t.tool_name ?? ''))
      ? ["- ⚠ agy ran its own subagents: their edits and commands are not listed above; git status is the full record"]
      : []),
    ...(readOnly && (writes.length || changed.length) ? ['- ⚠ read-only job, but files changed'] : []),
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

  const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model]
  args.push('--dangerously-skip-permissions', '--print-timeout', `${timeoutS}s`)
  if (opts.resume) args.push('--conversation', opts.resume)
  const child = spawn(agy, args, {
    cwd,
    detached: true, // own process group, so cancel and timeouts also stop the commands agy started
    env: { ...process.env, AGY_DELEGATE_JOB: dir },
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
  const realCwd = fs.realpathSync(cwd)
  const checkBinding = () => {
    const init = readEvents(eventsFile).find(e => e.event === 'init')?.init
    if (!init) return false
    let bound = init.cwd
    try {
      bound = fs.realpathSync(init.cwd)
    } catch {}
    if (bound !== realCwd) stop(`workspace ${init.cwd}`)
    return true
  }
  const watcher = setInterval(() => checkBinding() && clearInterval(watcher), 1000)
  const tracked = new Map()
  const tracker = setInterval(() => descendants(child.pid, tracked), 1000)

  child.on('exit', async code => {
    clearTimeout(guard)
    clearInterval(watcher)
    clearInterval(tracker)
    const stopped = await reap(tracked, child.pid)
    checkBinding()
    const events = readEvents(eventsFile)
    const result = events.findLast(e => e.event === 'result')?.result
    const errText = read(agyErr)
    const said = events
      .map(e => e.step_update)
      .filter(s => s?.step_type === 'agent_response')
      .map(s => s.text_delta ?? '')
      .join('')
    let exit
    let why
    if (SIGNALS[stopReason]) [exit, why] = [128 + SIGNALS[stopReason], `runner got ${stopReason}; agy was stopped`]
    else if (stopReason?.startsWith('workspace')) [exit, why] = [EXIT.failed, `agy bound to ${stopReason.slice(10)}, not ${cwd}`]
    else if (stopReason === 'guard') [exit, why] = [EXIT.timeout, `agy outlived --print-timeout by ${GUARD_S}s and was killed`]
    else if (/print timeout after .*partial output/.test(errText))
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
    report({ cwd, dir, model, exit, why, result, events, before, readOnly: opts.readOnly, stopped })
    updateMeta(dir, { verdict: why })
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
