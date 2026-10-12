#!/usr/bin/env node
// agy PreToolUse hook: applies the job's deny rules and logs every decision to $JOB/hook.log. Under
// AGY_DELEGATE_ROLE=verifier it serves the nested verifier run and allows reads only.
// agy denies on empty output, a crash or a timeout, so every path prints an explicit decision.
// Matching a command line stops accidents, not intent: a script file or an alias gets past it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVerifier, jobDir, logLine, readState, readStdin, stateHash } from './job.mjs'

// A copy of globToRegExp in jobs.mjs, which wt-finish uses, so the hook never depends on that module
// loading. hooks.test.mjs checks the two agree.
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
// Words that start a shell construct; the command follows them.
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'for', 'select', 'case', 'esac', '{', '}', '!'])
// Programs that run the rest of their arguments, with the options that take a value.
const WRAPPERS = {
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'],
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  command: [],
  builtin: [],
  exec: ['-a'],
  time: ['-f', '--format', '-o', '--output'],
  nohup: [],
  nice: ['-n', '--adjustment'],
  xargs: ['-I', '-i', '-L', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-E', '-e', '-d', '--delimiter', '-a', '--arg-file'],
  npx: ['-p', '--package', '-c', '--call'],
  bunx: ['-p', '--package'],
  pnpx: ['-p', '--package', '-c'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
}
// `pnpm exec`, `pnpm dlx`, `npm exec`, `yarn dlx`, `bun x` also run a program.
const RUNNER_SUBCOMMANDS = { pnpm: ['exec', 'dlx'], npm: ['exec', 'x'], yarn: ['exec', 'dlx'], bun: ['x'] }
const RUNNER_VALUED = ['-p', '--package', '-c', '--call', '--shell-mode']
// Skips leading options, and the value of each option in `valued`. Returns [the rest, {option: value}].
const skipOptions = (words, valued = []) => {
  const seen = {}
  let i = 0
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') return [words.slice(i + 1), seen]
    if (valued.includes(words[i])) seen[words[i]] = words[++i]
    i++
  }
  return [words.slice(i), seen]
}
const program = word => path.basename(word ?? '').replace(/(.)@[^/]*$/, '$1')

// Strips what runs another program (shell keywords, env assignments, sudo, env, timeout, npx,
// pnpm exec, ...) and expands `sh -c`, `eval`, `env -S` and `npx -c`, so the rules see the program
// that runs.
export function commandsIn(line, depth = 0) {
  if (depth > 3) return []
  return simpleCommands(line).flatMap(raw => {
    let w = raw
    const nested = []
    for (let guard = 0; guard < 20 && w.length; guard++) {
      const head = program(w[0])
      if (SHELL_KEYWORDS.has(w[0]) || ASSIGNMENT.test(w[0])) w = w.slice(1)
      else if (WRAPPERS[head]) {
        const [rest, seen] = skipOptions(w.slice(1), WRAPPERS[head])
        // A command string passed as an option value runs too.
        for (const opt of ['-S', '--split-string', '-c', '--call']) if (seen[opt] != null) nested.push(seen[opt])
        w = head === 'timeout' ? rest.slice(1) : rest
      } else if (RUNNER_SUBCOMMANDS[head]?.includes(w[1])) {
        const [rest, seen] = skipOptions(w.slice(2), RUNNER_VALUED)
        for (const opt of ['-c', '--call', '--shell-mode']) if (seen[opt] != null) nested.push(seen[opt])
        w = rest
      } else break
    }
    const inner = nested.flatMap(n => commandsIn(n, depth + 1))
    const head = program(w[0])
    if (['sh', 'bash', 'zsh', 'dash'].includes(head)) {
      const flag = w.findIndex(x => /^-[a-z]*c[a-z]*$/.test(x))
      if (flag > 0 && w[flag + 1] != null) return [...inner, ...commandsIn(w[flag + 1], depth + 1)]
    }
    if (head === 'eval') return [...inner, ...commandsIn(w.slice(1).join(' '), depth + 1)]
    return w.length ? [...inner, [head, ...w.slice(1)]] : inner
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
// Per package manager, the global options that take a value. pnpm's -w is a flag; npm's takes a name.
const PM_VALUED = {
  pnpm: new Set(['--filter', '-F', '-C', '--dir', '--reporter', '--loglevel', '--store-dir', '--lockfile-dir', '--modules-dir']),
  npm: new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel', '--registry', '--cache', '--userconfig']),
  yarn: new Set(['--cwd', '--modules-folder', '--registry', '--cache-folder']),
  bun: new Set(['--cwd', '-c', '--config']),
}
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
  if (!PM_VALUED[head]) return false
  if (head === 'yarn' && rest.length === 0) return true
  const [sub, ...args] = positionals(rest, PM_VALUED[head])
  // yarn workspace <name> add x
  if (head === 'yarn' && sub === 'workspace') return DEP_CHANGES.has(args[1])
  return DEP_CHANGES.has(sub)
}

const ALL = ['task', 'implement']
export const COMMAND_RULES = [
  { id: 'git-state', modes: ALL, test: gitStateChange, why: 'git commands that change repository state are blocked; the calling agent commits' },
  { id: 'ai-cli', modes: ALL, test: ([head]) => AI_CLIS.has(head), why: 'other AI CLIs and AI review tools are blocked in delegated jobs' },
  { id: 'gh-write', modes: ['implement'], test: ghWrite, why: 'gh commands that write to GitHub are blocked' },
  { id: 'dependencies', modes: ['implement'], test: dependencyChange, why: 'adding, removing, updating or installing dependencies is blocked' },
]

// Rules on a tool by name. agy adds MCP tools whatever the `tools` allowlist says, so a rule keeps them out of implement jobs.
export const TOOL_RULES = [
  {
    id: 'mcp',
    modes: ['implement'],
    tools: new Set(['call_mcp_tool']),
    why: 'MCP calls can change things outside the checkout; implement jobs make none',
  },
]
const GUARDED_TOOLS = new Set(TOOL_RULES.flatMap(r => [...r.tools]))
const mcpTarget = args => (args.ServerName ? `${args.ServerName}/${args.ToolName ?? ''}` : '')

// A read-only job may call an MCP tool unless its name has a write verb as a word. No verb at all: allowed and logged.
const MCP_WRITE_VERBS = new Set(['write', 'create', 'update', 'delete', 'remove', 'edit', 'move', 'rename', 'post', 'put', 'patch', 'set', 'insert', 'upsert', 'send', 'comment', 'add', 'archive', 'close', 'merge'])
const MCP_READ_VERBS = new Set(['list', 'get', 'read', 'search', 'query', 'find', 'fetch', 'describe'])
// Words of a tool name: write_file, writeFile, write-file and write.file all give [write, file].
const nameWords = name => String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const verbIn = (words, verbs) => words.find(w => [w, w.replace(/s$/, ''), w.replace(/es$/, '')].some(v => verbs.has(v)))

// Case-insensitive: macOS file systems treat spec.md and SPEC.md as one file.
const PLAN_FILE = /(^|-)ticket\.md$|^(map|spec)\.md$/i

// Resolves a write target one component at a time, following every symlink (dangling ones too)
// before applying the `..` that comes after it, as the kernel does. Returns null when it can't.
export function resolveTarget(file) {
  const queue = file.split('/')
  let cur = '/'
  let hops = 0
  while (queue.length) {
    const part = queue.shift()
    if (part === '' || part === '.') continue
    if (part === '..') {
      cur = path.dirname(cur)
      continue
    }
    const next = path.join(cur, part)
    let stat
    try {
      stat = fs.lstatSync(next)
    } catch (error) {
      if (error.code !== 'ENOENT') return null
      cur = next // missing from here on: nothing below it can be a link
      continue
    }
    if (!stat.isSymbolicLink()) {
      cur = next
      continue
    }
    if (++hops > 40) return null
    let link
    try {
      link = fs.readlinkSync(next)
    } catch {
      return null
    }
    queue.unshift(...link.split('/'))
    if (path.isAbsolute(link)) cur = '/'
  }
  return cur
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

const JOB_FILES = { id: 'job-files', why: "the job's own files and settings are off limits to shell commands" }
const STATE_CHANGED = { id: 'state-changed', why: "the job's state.json changed during the run, so no rule can be trusted" }
const NO_TARGET = { id: 'no-target', why: 'the write names no target path to check' }
const UNRESOLVED = { id: 'unresolved-target', why: 'the target path could not be resolved (a symlink loop or an unreadable directory)' }
const blocked = (rule, target) => ({
  decision: 'deny',
  rule: rule.id,
  target,
  reason: `Blocked by job rules (${rule.id}): ${rule.why}. Do not try another way; name it in your final report.`,
})

// The job dir holds state.json, hook.log and the canary, which the runner trusts.
function mentionsJob(line, state) {
  if (/AGY_DELEGATE_/.test(line)) return true
  if (!state.job) return false
  const forms = new Set([state.job])
  try {
    forms.add(fs.realpathSync(state.job))
  } catch {}
  return [...forms].some(dir => line.includes(dir))
}

// Returns {decision, rule?, reason?, target} for one tool call under the job's state. A tool no rule covers gets an explicit allow.
export function decide(call, state) {
  const args = call?.args ?? {}
  const toolRule = TOOL_RULES.find(r => r.modes.includes(state.mode) && r.tools.has(call?.name))
  if (toolRule) return blocked(toolRule, call.name === 'call_mcp_tool' ? mcpTarget(args) : '')
  if (call?.name === 'call_mcp_tool' && state.readOnly) {
    const words = nameWords(args.ToolName)
    const write = verbIn(words, MCP_WRITE_VERBS)
    if (write) return blocked({ id: 'mcp-write', why: `this job is read-only, and the MCP tool ${args.ToolName} names a write (${write})` }, mcpTarget(args))
    if (!verbIn(words, MCP_READ_VERBS)) return { decision: 'allow', target: mcpTarget(args), note: 'mcp-unclassified' }
  }
  if (call?.name === 'run_command') {
    const line = String(args.CommandLine ?? '')
    if (mentionsJob(line, state)) return blocked(JOB_FILES, line)
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
    if (!rules.length) return { decision: 'allow', target: String(raw) }
    // Joined as text, not with path.resolve, which would apply `..` before following symlinks.
    const given = String(raw).replace(/^file:\/\//, '')
    const abs = resolveTarget(path.isAbsolute(given) ? given : `${state.worktree}/${given}`)
    if (abs == null) return blocked(rules.find(r => r.id === 'read-only') ?? UNRESOLVED, given)
    const rel = path.relative(state.worktree, abs)
    const file = { abs, rel, outside: rel === '' || rel.startsWith('..') || path.isAbsolute(rel) }
    const rule = rules.find(r => r.test(file, state))
    return rule ? blocked(rule, abs) : { decision: 'allow', target: abs }
  }
  const target = args.AbsolutePath ?? args.SearchPath ?? args.DirectoryPath ?? args.Query ?? mcpTarget(args)
  return { decision: 'allow', target: String(target) }
}

const VERIFIER_ONLY = { id: 'verifier-read-only', why: 'the verifier may only view and search files and call finish' }
const VERIFIER_NO_PATH = { id: 'verifier-no-path', why: 'the verifier must name the file or directory it reads' }
const VERIFIER_OUTSIDE = { id: 'verifier-outside', why: 'the verifier reads only the worktree, its input dir and its config dir' }
// The verifier's read tools and the argument that holds each one's path, as agy 1.3.3 sends them.
const VERIFIER_READS = { view_file: 'AbsolutePath', list_dir: 'DirectoryPath', find_by_name: 'SearchDirectory', grep_search: 'SearchPath' }
const within = (file, root) => file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`)

// The nested verifier run: only the four read tools, each on a path inside `roots`, and `finish`, which
// carries its verdict. Everything else is denied: commands, writes, MCP and any tool agy adds.
export function decideVerifier(call, roots) {
  const args = call?.args ?? {}
  if (call?.name === 'finish') return { decision: 'allow', target: '' }
  const key = VERIFIER_READS[call?.name]
  if (!key) return blocked(VERIFIER_ONLY, call?.name === 'call_mcp_tool' ? mcpTarget(args) : String(args.CommandLine ?? args.TargetFile ?? call?.name ?? ''))
  if (typeof args[key] !== 'string' || !args[key]) return blocked(VERIFIER_NO_PATH, '')
  const given = args[key].replace(/^file:\/\//, '')
  const abs = path.isAbsolute(given) ? resolveTarget(given) : resolveTarget(`${roots[0]}/${given}`)
  if (abs == null || !roots.some(r => within(abs, r))) return blocked(VERIFIER_OUTSIDE, given)
  return { decision: 'allow', target: abs }
}

// The worktree, the round's input dir and the verifier's config dir. A run without its input dir is
// broken, so every call is denied, `finish` included.
function verifierRoots(dir, state) {
  const input = process.env.AGY_DELEGATE_VERIFIER_INPUT
  if (!input) throw new Error('AGY_DELEGATE_VERIFIER_INPUT is not set')
  return [state.worktree, input, path.join(dir, 'agy-verifier')].map(r => resolveTarget(r) ?? r)
}

async function main() {
  const raw = await readStdin()
  let call
  const role = isVerifier() ? { role: 'verifier' } : {}
  try {
    call = JSON.parse(raw).toolCall
    const dir = jobDir()
    const state = readState(dir)
    // A changed state.json could widen paths:, so every call is denied, reads included.
    const d =
      stateHash(state) !== process.env.AGY_DELEGATE_STATE_SHA
        ? blocked(STATE_CHANGED, '')
        : role.role
          ? decideVerifier(call, verifierRoots(dir, state))
          : decide(call, state)
    const target = d.target.length > 300 ? `${d.target.slice(0, 297)}...` : d.target
    logLine(dir, { hook: 'PreToolUse', ...role, decision: d.decision, rule: d.rule, note: d.note, tool: call?.name, target, ...(target ? {} : { keys: Object.keys(call?.args ?? {}) }) })
    console.log(JSON.stringify(d.decision === 'deny' ? { decision: 'deny', reason: d.reason } : { decision: 'allow' }))
  } catch (error) {
    // Fail closed for the calls the rules cover, open for the rest. The verifier's rules cover every
    // call, `finish` included: a verdict from a run whose reads were all denied must not count.
    const covered = Boolean(role.role) || !call || call.name === 'run_command' || GUARDED_TOOLS.has(call.name) || isWrite(call)
    const reason = `Blocked by job rules: the rule check failed (${error.message}).`
    console.log(JSON.stringify(covered ? { decision: 'deny', reason } : { decision: 'allow' }))
    try {
      logLine(jobDir(), { hook: 'PreToolUse', ...role, decision: covered ? 'deny' : 'allow', rule: 'error', tool: call?.name, error: error.message })
    } catch {}
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
