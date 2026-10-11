#!/usr/bin/env node
/**
 * Progress dashboard feed for one implementation plan. Lives in the to-implementation-plan skill
 * and runs against the plan folder given by --scope (the folder holding MAP.md and tickets/,
 * relative to the cwd or absolute). Zero deps.
 *
 * Status is never stored here: every run re-derives tickets, tasks and the frontier from the
 * tickets' yaml and checkboxes. The only state of its own is what tickets can't hold, kept in
 * .dashboard/state.json: questions waiting on the user (with the default taken meanwhile), stuck
 * items, the orchestrator's subagent ledger and a short activity log.
 *
 * Every command rewrites .dashboard/data.js (`window.DASH = {...}`), which .dashboard/index.html
 * loads via <script src> so the page works from file:// and picks up changes on its 10s refresh.
 *
 * Every command takes --scope <plan folder>, e.g. `--scope specs/<scope>`:
 *
 *   node dashboard.js --scope <dir>                     regenerate data.js
 *   node dashboard.js --scope <dir> ask "<question>" --default "<if unanswered>" [--ticket <t>]
 *   node dashboard.js --scope <dir> answer <id> ["<answer>"]
 *   node dashboard.js --scope <dir> stuck "<what>" [--ticket <t>]
 *   node dashboard.js --scope <dir> unstuck <id>
 *   node dashboard.js --scope <dir> agent <ticket> <state> [--note "<text>"]
 *       state: dispatched|running|reported|merging|merged|failed|gone
 *   node dashboard.js --scope <dir> log "<text>"
 *   node dashboard.js --scope <dir> path                print the page's path from the repo root
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const now = () => new Date().toISOString()

function die(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v ?? null
}

const args = process.argv.slice(2)
const scopeArg = flag(args, '--scope')
if (!scopeArg) die(`usage: node ${__filename} --scope <plan folder> [command] (see its header)`)
const scopeDir = path.resolve(scopeArg)
if (!fs.existsSync(path.join(scopeDir, 'MAP.md')))
  die(`No MAP.md in ${scopeDir}: --scope must be the plan folder holding MAP.md and tickets/`)
const ticketsDir = path.join(scopeDir, 'tickets')
const dashDir = path.join(scopeDir, '.dashboard')
const statePath = path.join(dashDir, 'state.json')
const dataPath = path.join(dashDir, 'data.js')
const pagePath = path.join(dashDir, 'index.html')

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// Relative to the repo root, so the Claude app can open it as a markdown link; absolute outside git.
function pagePathFromRepoRoot() {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: scopeDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return path.relative(root.trim(), pagePath)
  } catch {
    return pagePath
  }
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) return { status: null, blockedBy: [] }
  const lines = m[1].split('\n')
  const strip = v => v.replace(/\s+#.*$/, '').trim()
  const unquote = v => v.trim().replace(/^['"]|['"]$/g, '')
  let status = null
  const blockedBy = []
  for (let i = 0; i < lines.length; i++) {
    const s = /^status:\s*(.*)$/.exec(lines[i])
    if (s) status = strip(s[1].replace(/#.*$/, ''))
    const b = /^blockedBy:\s*(.*)$/.exec(lines[i])
    if (!b) continue
    const v = strip(b[1])
    if (v.startsWith('['))
      v.replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean)
        .forEach(x => blockedBy.push(x))
    else if (v) blockedBy.push(unquote(v))
    else
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
        const item = /^\s*-\s*(.*)$/.exec(lines[j])
        if (item) blockedBy.push(unquote(strip(item[1])))
      }
  }
  return { status, blockedBy }
}

function section(text, heading) {
  const m = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)
  return m ? m[1].trim() : ''
}

function loadTickets(map) {
  if (!fs.existsSync(ticketsDir)) die(`No tickets/ in ${scopeDir}`)
  const files = fs
    .readdirSync(ticketsDir)
    .filter(f => f.endsWith('-ticket.md'))
    .sort()
  const tickets = files.map(file => {
    const full = path.join(ticketsDir, file)
    const text = read(full)
    const fm = frontmatter(text)
    const tasksBody = section(text, 'Tasks')
    const tasksTotal = (tasksBody.match(/^\s*- \[[ xX]\]/gm) || []).length
    const tasksDone = (tasksBody.match(/^\s*- \[[xX]\]/gm) || []).length
    const nextTask = (/^\s*- \[ \]\s*(.+)$/m.exec(tasksBody) || [])[1] || null
    const updates = [
      ...text.matchAll(/\*\*Update \((\d{4}-\d{2}-\d{2})\)\.\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/g),
    ]
    const last = updates.at(-1)
    const mapLine =
      section(map, 'Tickets')
        .split('\n')
        .find(l => l.includes(`tickets/${file}`)) || ''
    const gist = mapLine.replace(/^.*?\]\([^)]*\)\s*[:—–-]?\s*/, '').trim() || null
    return {
      file,
      id: file.replace(/\.md$/, ''),
      title: ((/^# Ticket:\s*(.+)$/m.exec(text) || [])[1] || file).trim(),
      status: fm.status || 'unknown',
      blockedBy: fm.blockedBy,
      tasksDone,
      tasksTotal,
      nextTask: nextTask && nextTask.replace(/\s+/g, ' ').slice(0, 160),
      lastUpdate: last ? { date: last[1], text: last[2].replace(/\s+/g, ' ').slice(0, 280) } : null,
      gist,
      modifiedAt: fs.statSync(full).mtime.toISOString(),
    }
  })
  const byFile = Object.fromEntries(tickets.map(t => [t.file, t]))
  for (const t of tickets) {
    const human = t.blockedBy.filter(b => !b.endsWith('-ticket.md'))
    const siblings = t.blockedBy.filter(b => b.endsWith('-ticket.md')).map(b => b.split('/').pop())
    t.waitingOnHuman = human
    t.openBlockers = siblings.filter(b => byFile[b]?.status !== 'done')
    t.frontier =
      (t.status === 'ready' || (t.status === 'blocked' && t.blockedBy.length > 0)) &&
      human.length === 0 &&
      t.openBlockers.length === 0
  }
  return tickets
}

function loadState() {
  const raw = read(statePath)
  const s = raw ? JSON.parse(raw) : {}
  return {
    seq: s.seq || 0,
    questions: s.questions || [],
    stuck: s.stuck || [],
    agents: s.agents || [],
    log: s.log || [],
  }
}

function saveState(s) {
  fs.mkdirSync(dashDir, { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`)
}

// The plan's own commits: everything since the commit that added SPEC.md (none until it's committed).
function recentCommits() {
  const git = args =>
    execFileSync('git', args, {
      cwd: scopeDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  try {
    const born = git(['log', '--diff-filter=A', '--format=%H', '--', 'SPEC.md'])
      .trim()
      .split('\n')
      .pop()
    if (!born) return []
    let range = `${born}^..HEAD`
    try {
      git(['rev-parse', '--verify', '--quiet', `${born}^`])
    } catch {
      range = 'HEAD' // SPEC.md landed in the root commit
    }
    return git(['log', '-8', '--format=%h%x09%cI%x09%s', range])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [hash, at, subject] = l.split('\t')
        return { hash, at, subject }
      })
  } catch {
    return []
  }
}

function build(state) {
  const spec = read(path.join(scopeDir, 'SPEC.md')) || ''
  const map = read(path.join(scopeDir, 'MAP.md')) || ''
  const tickets = loadTickets(map)
  const counts = { total: tickets.length }
  for (const t of tickets) counts[t.status] = (counts[t.status] || 0) + 1
  const nextUp = (/\*\*Next up:\*\*.*?([\w.-]+-ticket)\.md/.exec(map) || [])[1] || null
  return {
    scope: path.basename(scopeDir),
    generatedAt: now(),
    spec: {
      title: ((/^# Spec:\s*(.+)$/m.exec(spec) || [])[1] || path.basename(scopeDir)).trim(),
      goal: section(spec, 'Goal').split('\n\n')[0].replace(/\s+/g, ' ') || null,
    },
    nextUp,
    counts,
    tasks: {
      done: tickets.reduce((n, t) => n + t.tasksDone, 0),
      total: tickets.reduce((n, t) => n + t.tasksTotal, 0),
    },
    frontier: tickets.filter(t => t.frontier).map(t => t.id),
    tickets,
    agents: state.agents,
    questions: state.questions,
    stuck: state.stuck,
    log: state.log.slice(-40),
    commits: recentCommits(),
  }
}

function write(state) {
  saveState(state)
  const gi = path.join(dashDir, '.gitignore')
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n')
  const data = build(state)
  fs.writeFileSync(dataPath, `window.DASH = ${JSON.stringify(data, null, 1)}\n`)
  if (!fs.existsSync(pagePath))
    process.stderr.write(`note: ${pagePath} missing; dispatch dashboard-builder\n`)
  return data
}

function main() {
  const cmd = args.shift()
  const state = loadState()
  const nextId = prefix => `${prefix}${++state.seq}`
  const logIt = text => state.log.push({ at: now(), text })

  switch (cmd) {
    case undefined:
    case 'refresh':
      break
    case 'ask': {
      const def = flag(args, '--default')
      const ticket = flag(args, '--ticket')
      if (!args[0] || !def)
        die('usage: ask "<question>" --default "<default action>" [--ticket <t>]')
      const id = nextId('q')
      state.questions.push({
        id,
        question: args[0],
        default: def,
        ticket,
        askedAt: now(),
        answer: null,
        answeredAt: null,
      })
      logIt(`asked ${id}: ${args[0]}`)
      process.stdout.write(`${id}\n`)
      break
    }
    case 'answer': {
      const q = state.questions.find(x => x.id === args[0]) || die(`no question ${args[0]}`)
      q.answer = args[1] || q.default
      q.answeredAt = now()
      logIt(`answered ${q.id}`)
      break
    }
    case 'stuck': {
      const ticket = flag(args, '--ticket')
      if (!args[0]) die('usage: stuck "<what>" [--ticket <t>]')
      const id = nextId('s')
      state.stuck.push({ id, what: args[0], ticket, since: now(), resolvedAt: null })
      logIt(`stuck ${id}: ${args[0]}`)
      process.stdout.write(`${id}\n`)
      break
    }
    case 'unstuck': {
      const s = state.stuck.find(x => x.id === args[0]) || die(`no stuck item ${args[0]}`)
      s.resolvedAt = now()
      logIt(`unstuck ${s.id}`)
      break
    }
    case 'agent': {
      const note = flag(args, '--note')
      const [ticket, st] = args
      if (!ticket || !st) die('usage: agent <ticket> <state> [--note "<text>"]')
      const a = state.agents.find(x => x.ticket === ticket)
      if (a) Object.assign(a, { state: st, note: note ?? a.note, since: now() })
      else state.agents.push({ ticket, state: st, note, since: now() })
      logIt(`${ticket}: ${st}${note ? ` (${note})` : ''}`)
      break
    }
    case 'log':
      if (!args[0]) die('usage: log "<text>"')
      logIt(args[0])
      break
    case 'path':
      process.stdout.write(`${pagePathFromRepoRoot()}\n`)
      return
    default:
      die(`unknown command: ${cmd} (see the header of ${__filename})`)
  }
  const data = write(state)
  if (!cmd || cmd === 'refresh')
    process.stdout.write(
      `${data.scope}: ${data.counts.done || 0}/${data.counts.total} tickets done, ${data.tasks.done}/${data.tasks.total} tasks, ` +
        `${data.questions.filter(q => !q.answeredAt).length} open questions -> ${pagePathFromRepoRoot()}\n`,
    )
}

main()
