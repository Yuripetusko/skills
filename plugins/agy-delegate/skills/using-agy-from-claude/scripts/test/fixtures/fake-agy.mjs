#!/usr/bin/env node
// Offline stand-in for agy 1.3.3, for agy-run.mjs tests (AGY_BIN). Answers `models`, `-p /hooks` and
// `-p /agents` from the --add-dir config, and plays a stream-json run that calls the configured hooks.
// FAKE_CALLS_FILE   JSON list of {name, args} tool calls to make
// FAKE_HOOKS=0      never call the hooks
// FAKE_DELAY_START  seconds to wait before the first PreInvocation
// FAKE_SLEEP        seconds to wait after each tool step
// FAKE_TAMPER=1     rewrite $AGY_DELEGATE_JOB/state.json after PreInvocation, as a shell command could
// FAKE_FORGE=1      write a canary without the run id instead of calling the hooks
// FAKE_SLASH_FAIL   <hooks|agents>:<exit|signal>, print the JSON and then fail that call
// FAKE_AGY_EVENTS   after PreInvocation, replay this stream-json file's events (its init skipped)
//                   instead of the tool calls, answer and result
// FAKE_ROUNDS_FILE  JSON list of tool-call lists, one per round after a Stop hook answers continue
// FAKE_STOP_HOOK=0  never call the Stop hooks
// FAKE_HOOK_TIMEOUT_S  kill a hook after this many seconds instead of its configured timeout
// FAKE_BUSY_STOP    `mid`: one Stop with fullyIdle false before the answer, as at a `wait` step;
//                   `mid-idle`: the same Stop with fullyIdle true; `last`: every Stop says fullyIdle false
// FAKE_AFTER_MID_FILE  JSON list of tool calls to make after that mid-job Stop
// FAKE_KILL_STOP=final  kill the Stop hooks after the answer within 1 ms, before they can write anything
// FAKE_VERIFIER     for `--agent delegate-verifier` runs: comma-separated answer per gate round (the
//                   input dir's number), the last one repeating. PASS, FAIL (one finding), none (no
//                   structured output), invalid, hang, crash (exit 1, no result), write and mcp (a
//                   write call or an MCP write the hook should block, then PASS), scribble (edits
//                   the worktree, then PASS), pass-exit1 and pass-kill (a PASS result, then exit 1 or
//                   SIGKILL). Like a model that saw nothing, it answers FAIL when its hook denies
//                   the read of diff-numbered.txt or the file is missing.
// FAKE_VERIFIER_LOG file that gets one JSON line per verifier run: round, cwd, args and env
// Like agy 1.3.3, a Stop hook that exits non-zero, prints no JSON or times out lets the run stop, and
// the 11th consecutive continue is ignored. Each Stop answer is logged as a `fake_stop_hook` event.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const env = process.env
const opt = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const addDir = opt('--add-dir')
const hooksFile = addDir && path.join(addDir, '.agents', 'hooks.json')
const config = hooksFile && fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, 'utf8')) : {}
const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
const sleep = s => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(s) * 1000)

function slash(name, data) {
  out({ conversation_id: '', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 0, command: { name, data } })
  const [which, how] = (env.FAKE_SLASH_FAIL ?? '').split(':')
  if (which === name && how === 'signal') process.kill(process.pid, 'SIGKILL')
  process.exit(which === name && how === 'exit' ? 1 : 0)
}

if (argv[0] === 'models') {
  console.log('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)')
  process.exit(0)
}
if (argv[0] === '--version') {
  console.log('1.3.3-fake')
  process.exit(0)
}
if (argv[0] === '-p' && argv[1] === '/hooks') {
  const hooks = Object.entries(config).map(([name, spec]) => ({
    name,
    enabled: spec.enabled !== false,
    source: hooksFile,
    actions: Object.entries(spec)
      .filter(([, list]) => Array.isArray(list))
      .flatMap(([event, list]) => list.flatMap(h => h.hooks ?? [h]).map(a => ({ event, type: 'command', command: a.command }))),
  }))
  slash('hooks', { hooks })
}
if (argv[0] === '-p' && argv[1] === '/agents') {
  const dir = addDir && path.join(addDir, '.agents', 'agents')
  slash('agents', { agents: dir && fs.existsSync(dir) ? fs.readdirSync(dir).map(f => f.replace(/\.md$/, '')) : [] })
}

// A run.
fs.readFileSync(0, 'utf8')
const cwd = process.cwd()
out({ event: 'init', init: { model: opt('--model'), cwd, tools: [], permission_mode: 'bypass' } })
const handlers = event => Object.values(config).flatMap(spec => (spec[event] ?? []).flatMap(h => h.hooks ?? [h]))
const callHook = (h, input, timeoutMs) => {
  const timeout = timeoutMs ?? (Number(env.FAKE_HOOK_TIMEOUT_S) || h.timeout || 30) * 1000
  const r = spawnSync('sh', ['-c', h.command], { cwd: path.dirname(hooksFile), input: JSON.stringify(input), encoding: 'utf8', timeout, killSignal: 'SIGKILL' })
  if (r.status !== 0) return { failed: r.error?.code ?? r.signal ?? `exit ${r.status}` }
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { failed: 'not JSON' }
  }
}
const useHooks = env.FAKE_HOOKS !== '0' && !env.FAKE_FORGE
const common = { conversationId: 'fake-conv', workspacePaths: [addDir, cwd], modelName: opt('--model') }

if (opt('--agent') === 'delegate-verifier') {
  const input = env.AGY_DELEGATE_VERIFIER_INPUT ?? ''
  const round = Number(/input-(\d+)$/.exec(input)?.[1] ?? 1)
  const answers = (env.FAKE_VERIFIER ?? 'PASS').split(',')
  const answer = answers[Math.min(round, answers.length) - 1]
  if (env.FAKE_VERIFIER_LOG)
    fs.appendFileSync(env.FAKE_VERIFIER_LOG, `${JSON.stringify({ round, cwd, args: argv, role: env.AGY_DELEGATE_ROLE, input, answer })}\n`)
  // Returns true when every hook allowed the call.
  const tool = (name, args) => {
    const decisions = handlers('PreToolUse').map(h => callHook(h, { ...common, toolCall: { name, args } }))
    const allowed = decisions.every(d => d.decision === 'allow')
    out({ event: 'step_update', step_update: { step_index: 1, state: allowed ? 'DONE' : 'ERROR', step_type: 'tool', tool_name: name, tool_info: { name, parameters: args } } })
    return allowed
  }
  const diffFile = path.join(input, 'diff-numbered.txt')
  const read = tool('view_file', { AbsolutePath: diffFile }) && fs.existsSync(diffFile)
  if (answer === 'write') tool('write_to_file', { TargetFile: path.join(cwd, 'verifier-was-here.txt'), CodeContent: 'x' })
  if (answer === 'mcp') tool('call_mcp_tool', { ServerName: 'filesystem', ToolName: 'write_file', Arguments: { path: path.join(cwd, 'verifier-was-here.txt'), content: 'x' } })
  if (answer === 'scribble') fs.writeFileSync(path.join(cwd, 'verifier-was-here.txt'), 'x')
  if (answer === 'hang') sleep(3600)
  if (answer === 'crash') process.exit(1)
  const finding = { file: 'pkg/src/b.ts', line: 1, rule: 'SAFETY comments are true', why: 'Nothing checks the value before the cast.', fix: 'Narrow it with a type guard first.' }
  const unread = { file: 'diff-numbered.txt', line: 0, rule: 'input', why: 'The input could not be read.', fix: 'Let the verifier read its input.' }
  const structured = !read
    ? { verdict: 'FAIL', findings: [unread] }
    : ({ PASS: { verdict: 'PASS', findings: [] }, FAIL: { verdict: 'FAIL', findings: [finding] }, invalid: { verdict: 'MAYBE' } }[answer] ??
      (answer === 'none' ? undefined : { verdict: 'PASS', findings: [] }))
  out({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(structured ?? 'no json'), duration_seconds: 1, conversation_id: 'fake-verifier', ...(structured ? { structured_output: structured } : {}) } })
  if (answer === 'pass-exit1') process.exit(1)
  if (answer === 'pass-kill') process.kill(process.pid, 'SIGKILL')
  process.exit(0)
}
if (env.FAKE_DELAY_START) sleep(env.FAKE_DELAY_START)
if (env.FAKE_FORGE) fs.writeFileSync(path.join(env.AGY_DELEGATE_JOB, 'loaded'), '{"agent":"delegate-implementer"}\n')
if (useHooks) for (const h of handlers('PreInvocation')) callHook(h, { ...common, invocationNum: 0 })
if (env.FAKE_TAMPER) {
  const file = path.join(env.AGY_DELEGATE_JOB, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), paths: ['**'] }))
}
if (env.FAKE_AGY_EVENTS) {
  for (const line of fs.readFileSync(env.FAKE_AGY_EVENTS, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line)
    if (e.event !== 'init') out(e)
  }
  process.exit(0)
}
const readList = file => (file ? JSON.parse(fs.readFileSync(file, 'utf8')) : [])
let step = 0
const play = calls => {
  for (const call of calls) {
    step++
    const tool_info = { name: call.name, parameters: call.args }
    out({ event: 'step_update', step_update: { step_index: step, state: 'ACTIVE', step_type: 'tool', tool_name: call.name, tool_info } })
    const decisions = useHooks ? handlers('PreToolUse').map(h => callHook(h, { ...common, toolCall: call, stepIdx: step })) : []
    const denied = decisions.some(d => d.decision !== 'allow')
    if (!denied && call.name === 'write_to_file') {
      fs.mkdirSync(path.dirname(call.args.TargetFile), { recursive: true })
      fs.writeFileSync(call.args.TargetFile, call.args.CodeContent ?? '')
    }
    out({ event: 'step_update', step_update: { step_index: step, state: denied ? 'ERROR' : 'DONE', step_type: 'tool', tool_name: call.name, tool_info } })
    if (env.FAKE_SLEEP) sleep(env.FAKE_SLEEP)
  }
}
const answer = text => {
  step++
  out({ event: 'step_update', step_update: { step_index: step, state: 'DONE', step_type: 'agent_response', text_delta: text } })
  return text
}
play(readList(env.FAKE_CALLS_FILE))
const stopInput = (executionNum, fullyIdle, terminationReason = 'NO_TOOL_CALL') => ({ ...common, executionNum, terminationReason, fullyIdle })
if (useHooks && env.FAKE_BUSY_STOP?.startsWith('mid')) {
  const input = stopInput(0, env.FAKE_BUSY_STOP === 'mid-idle', 'TERMINAL_STEP_TYPE')
  for (const h of handlers('Stop')) out({ event: 'fake_stop_hook', executionNum: 0, answer: callHook(h, input) })
  play(readList(env.FAKE_AFTER_MID_FILE))
}
let response = answer('Fake agy finished.')
const rounds = readList(env.FAKE_ROUNDS_FILE)
for (let executionNum = 0; useHooks && env.FAKE_STOP_HOOK !== '0'; executionNum++) {
  const kill = env.FAKE_KILL_STOP === 'final' ? 1 : undefined
  const idle = env.FAKE_BUSY_STOP !== 'last'
  const answers = handlers('Stop').map(h => callHook(h, stopInput(executionNum, idle, idle ? 'NO_TOOL_CALL' : 'TERMINAL_STEP_TYPE'), kill))
  const cont = answers.find(a => a.decision === 'continue')
  for (const a of answers) out({ event: 'fake_stop_hook', executionNum, answer: a })
  if (!cont || executionNum >= 10) break
  play(rounds[executionNum] ?? [])
  response += `\n${answer(`Fake agy round ${executionNum + 2}.`)}`
}
out({ event: 'result', result: { status: 'SUCCESS', response, duration_seconds: 1, conversation_id: 'fake-conv', denied_actions: [] } })
