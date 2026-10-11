#!/usr/bin/env node
// agy PreToolUse hook: applies the job's deny rules and logs every decision to $JOB/hook.log.
// agy denies on empty output, a crash or a timeout, so every path prints an explicit decision.
// Matching a command line stops accidents, not intent: a script file or an alias gets past it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp } from '../jobs.mjs'
import { isVerifier, jobDir, logLine, readState, readStdin } from './job.mjs'

export const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
])
const READ_TOOLS = new Set(['view_file', 'list_dir', 'find_by_name', 'grep_search'])
const isWrite = call => WRITE_TOOLS.has(call?.name) || (!READ_TOOLS.has(call?.name) && call?.args?.TargetFile != null)

// Splits a shell line into simple commands (on ; & | && || newlines, parentheses, $( and backticks)
// and each command into words, with quotes and backslashes removed.
export function simpleCommands(line) {
  const out = []
  let words = []
  let word = null
  const push = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const end = () => {
    push()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) word = (word ?? '') + line[++i]
    else if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const stop = close < 0 ? line.length : close
      word = (word ?? '') + line.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      for (; j < line.length && line[j] !== '"'; j++) text += line[j] === '\\' && j + 1 < line.length ? line[++j] : line[j]
      word = (word ?? '') + text
      i = j
    } else if (c === '$' && line[i + 1] === '(') {
      end()
      i++
    } else if (/[;&|()`\n]/.test(c)) end()
    else if (/\s/.test(c)) push()
    else word = (word ?? '') + c
  }
  end()
  // A quoted word can still hold a command substitution.
  return out.concat(out.flat().filter(w => /\$\(|`/.test(w)).flatMap(w => simpleCommands(w.replace(/^[^$`]*/, ''))))
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'time', 'nohup', 'nice', 'xargs', 'npx', 'bunx', 'pnpx'])
const skipOptions = words => {
  let i = 0
  while (words[i]?.startsWith('-')) i++
  return words.slice(i)
}
const program = word => path.basename(word ?? '').replace(/(.)@[^/]*$/, '$1')

// Strips what runs another program (env assignments, sudo, env, timeout, npx, pnpm exec, ...) and
// expands `sh -c` and `eval`, so the rules see the program that runs.
export function commandsIn(line, depth = 0) {
  if (depth > 3) return []
  return simpleCommands(line).flatMap(raw => {
    let w = raw
    for (let guard = 0; guard < 10 && w.length; guard++) {
      const head = program(w[0])
      if (ASSIGNMENT.test(w[0])) w = w.slice(1)
      else if (WRAPPERS.has(head)) w = skipOptions(w.slice(1))
      else if (head === 'timeout') w = skipOptions(w.slice(1)).slice(1)
      else if (['pnpm', 'npm', 'yarn', 'bun'].includes(head) && ['exec', 'dlx', 'x'].includes(w[1])) w = skipOptions(w.slice(2))
      else break
    }
    const head = program(w[0])
    if (['sh', 'bash', 'zsh', 'dash'].includes(head)) {
      const flag = w.findIndex(x => /^-[a-z]*c[a-z]*$/.test(x))
      if (flag > 0 && w[flag + 1] != null) return commandsIn(w[flag + 1], depth + 1)
    }
    if (head === 'eval') return commandsIn(w.slice(1).join(' '), depth + 1)
    return w.length ? [[head, ...w.slice(1)]] : []
  })
}

// Positional arguments, skipping options and the values of the options named in `valued`.
const positionals = (words, valued = new Set()) => {
  const out = []
  for (let i = 0; i < words.length; i++) {
    if (!words[i].startsWith('-')) out.push(words[i])
    else if (valued.has(words[i])) i++
  }
  return out
}

const GIT_STATE = new Set(['commit', 'push', 'pull', 'reset', 'rebase', 'checkout', 'switch', 'restore', 'revert', 'stash', 'clean', 'worktree', 'merge', 'cherry-pick', 'tag', 'am'])
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const AI_CLIS = new Set(['claude', 'claude-code', 'codex', 'gemini', 'gemini-cli', 'agy', 'coderabbit', 'cr'])
const GH_WRITES = { pr: ['create', 'merge', 'review', 'comment', 'edit', 'close'], issue: ['create', 'comment', 'edit'] }
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PM_VALUED = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace', '--cwd'])
const DEP_CHANGES = new Set(['add', 'remove', 'rm', 'uninstall', 'un', 'install', 'i', 'ci', 'update', 'up', 'upgrade'])

function gitStateChange([head, ...rest]) {
  if (head !== 'git') return false
  const [sub, ...args] = positionals(rest, GIT_VALUED)
  return GIT_STATE.has(sub) || (sub === 'branch' && args.length > 0 && rest.some(a => ['-d', '-D', '--delete'].includes(a)))
}
function ghWrite([head, ...rest]) {
  if (head !== 'gh') return false
  const [group, verb] = positionals(rest, new Set(['-R', '--repo']))
  if (GH_WRITES[group]?.includes(verb)) return true
  if (group !== 'api') return false
  const method = rest
    .map((a, i) => (/^(-X|--method)$/.test(a) ? rest[i + 1] : /^(?:-X|--method=)(.+)$/.exec(a)?.[1]))
    .find(Boolean)
  // gh api sends a POST when it has fields and no explicit method.
  const fields = rest.some(a => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a))
  return method ? /^(POST|PATCH|PUT|DELETE)$/i.test(method) : fields
}
function dependencyChange([head, ...rest]) {
  if (!PACKAGE_MANAGERS.has(head)) return false
  if (head === 'yarn' && rest.length === 0) return true
  return DEP_CHANGES.has(positionals(rest, PM_VALUED)[0])
}

const ALL = ['task', 'implement']
export const COMMAND_RULES = [
  { id: 'git-state', modes: ALL, test: gitStateChange, why: 'git commands that change repository state are blocked; the calling agent commits' },
  { id: 'ai-cli', modes: ALL, test: ([head]) => AI_CLIS.has(head), why: 'other AI CLIs and AI review tools are blocked in delegated jobs' },
  { id: 'gh-write', modes: ['implement'], test: ghWrite, why: 'gh commands that write to GitHub are blocked' },
  { id: 'dependencies', modes: ['implement'], test: dependencyChange, why: 'adding, removing, updating or installing dependencies is blocked' },
]

const PLAN_FILE = /(^|-)ticket\.md$|^(MAP|SPEC)\.md$/
// The deepest existing ancestor goes through realpath, so /tmp and /private/tmp compare equal.
function realish(file) {
  const rest = []
  let cur = file
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) return file
    rest.unshift(path.basename(cur))
    cur = parent
  }
  return path.join(fs.realpathSync(cur), ...rest)
}
export function inPaths(rel, paths, worktree) {
  return paths.some(p => {
    const clean = p.replace(/^\.\//, '')
    const full = path.join(worktree, clean)
    if (clean.endsWith('/') || (fs.existsSync(full) && fs.statSync(full).isDirectory()))
      return rel.startsWith(clean.replace(/\/?$/, '/'))
    return globToRegExp(clean).test(rel)
  })
}

export const WRITE_RULES = [
  { id: 'read-only', applies: s => s.readOnly, test: () => true, why: 'this job is read-only' },
  { id: 'outside-worktree', applies: s => s.mode === 'implement', test: f => f.outside, why: 'writes outside the worktree are blocked' },
  {
    id: 'plan-file',
    applies: s => s.mode === 'implement',
    test: f => PLAN_FILE.test(path.basename(f.rel)),
    why: 'ticket, MAP.md and SPEC.md files belong to the orchestrator, which updates them after it verifies the work',
  },
  {
    id: 'outside-paths',
    applies: s => s.mode === 'implement' && s.paths?.length > 0,
    test: (f, s) => !inPaths(f.rel, s.paths, s.worktree),
    why: "this file is outside the job's paths",
  },
]

const NO_TARGET = { id: 'no-target', why: 'the write names no target path to check' }
const blocked = (rule, target) => ({
  decision: 'deny',
  rule: rule.id,
  target,
  reason: `Blocked by job rules (${rule.id}): ${rule.why}. Do not try another way; name it in your final report.`,
})

// Returns {decision, rule?, reason?, target} for one tool call under the job's state.
export function decide(call, state) {
  const args = call?.args ?? {}
  if (call?.name === 'run_command') {
    const line = String(args.CommandLine ?? '')
    const rules = COMMAND_RULES.filter(r => r.modes.includes(state.mode))
    for (const words of commandsIn(line)) {
      const rule = rules.find(r => r.test(words))
      if (rule) return blocked(rule, line)
    }
    return { decision: 'allow', target: line }
  }
  if (isWrite(call)) {
    const rules = WRITE_RULES.filter(r => r.applies(state))
    const raw = args.TargetFile ?? args.AbsolutePath ?? args.FilePath ?? args.Path
    if (raw == null) {
      if (!rules.length) return { decision: 'allow', target: '' }
      return blocked(rules.find(r => r.id === 'read-only') ?? NO_TARGET, '')
    }
    const abs = realish(path.resolve(state.worktree, String(raw).replace(/^file:\/\//, '')))
    const rel = path.relative(state.worktree, abs)
    const file = { abs, rel, outside: rel === '' || rel.startsWith('..') || path.isAbsolute(rel) }
    const rule = rules.find(r => r.test(file, state))
    return rule ? blocked(rule, abs) : { decision: 'allow', target: abs }
  }
  const target = args.AbsolutePath ?? args.SearchPath ?? args.DirectoryPath ?? args.Query ?? ''
  return { decision: 'allow', target: String(target) }
}

async function main() {
  const raw = await readStdin()
  let call
  try {
    call = JSON.parse(raw).toolCall
    if (isVerifier()) return console.log(JSON.stringify({ decision: 'allow' }))
    const dir = jobDir()
    const d = decide(call, readState(dir))
    const target = d.target.length > 300 ? `${d.target.slice(0, 297)}...` : d.target
    logLine(dir, { hook: 'PreToolUse', decision: d.decision, rule: d.rule, tool: call?.name, target, ...(target ? {} : { keys: Object.keys(call?.args ?? {}) }) })
    console.log(JSON.stringify(d.decision === 'deny' ? { decision: 'deny', reason: d.reason } : { decision: 'allow' }))
  } catch (error) {
    // Fail closed for the calls the rules cover, open for the rest.
    const covered = !call || call.name === 'run_command' || isWrite(call)
    const reason = `Blocked by job rules: the rule check failed (${error.message}).`
    console.log(JSON.stringify(covered ? { decision: 'deny', reason } : { decision: 'allow' }))
    try {
      logLine(jobDir(), { hook: 'PreToolUse', decision: covered ? 'deny' : 'allow', rule: 'error', tool: call?.name, error: error.message })
    } catch {}
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
