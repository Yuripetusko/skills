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
  console.log('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)')
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
const callHook = (h, input) => {
  const r = spawnSync('sh', ['-c', h.command], { cwd: path.dirname(hooksFile), input: JSON.stringify(input), encoding: 'utf8' })
  try {
    return JSON.parse(r.stdout)
  } catch {
    return {}
  }
}
const useHooks = env.FAKE_HOOKS !== '0' && !env.FAKE_FORGE
const common = { conversationId: 'fake-conv', workspacePaths: [addDir, cwd], modelName: opt('--model') }
if (env.FAKE_DELAY_START) sleep(env.FAKE_DELAY_START)
if (env.FAKE_FORGE) fs.writeFileSync(path.join(env.AGY_DELEGATE_JOB, 'loaded'), '{"agent":"delegate-implementer"}\n')
if (useHooks) for (const h of handlers('PreInvocation')) callHook(h, { ...common, invocationNum: 0 })
if (env.FAKE_TAMPER) {
  const file = path.join(env.AGY_DELEGATE_JOB, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), paths: ['**'] }))
}
const calls = env.FAKE_CALLS_FILE ? JSON.parse(fs.readFileSync(env.FAKE_CALLS_FILE, 'utf8')) : []
let step = 0
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
const text = 'Fake agy finished.'
out({ event: 'step_update', step_update: { step_index: step + 1, state: 'DONE', step_type: 'agent_response', text_delta: text } })
out({ event: 'result', result: { status: 'SUCCESS', response: text, duration_seconds: 1, conversation_id: 'fake-conv', denied_actions: [] } })
