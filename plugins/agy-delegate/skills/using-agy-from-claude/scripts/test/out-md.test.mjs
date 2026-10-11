// Run with: node --test plugins/agy-delegate/skills/using-agy-from-claude/scripts/test/*.test.mjs
// Replays recorded-style agy events through a fake AGY_BIN and checks the out.md that `exec` writes.
// Nothing here needs a live agy or a sign-in.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const JOBS = path.join(SCRIPTS, 'jobs.mjs')
const AGY_RUN = path.join(SCRIPTS, 'agy-run.mjs')
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'out-md-test-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

// The fake agy answers `models` with one model and otherwise replays $FAKE_AGY_EVENTS on stdout,
// pointing the init event at its own cwd, which is the check agy-run makes.
const fakeAgy = path.join(scratch, 'fake-agy')
fs.writeFileSync(
  fakeAgy,
  `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === 'models') {
  console.log('gemini-3.8-flash-high')
  process.exit(0)
}
for (const line of fs.readFileSync(process.env.FAKE_AGY_EVENTS, 'utf8').split('\\n').filter(Boolean)) {
  const e = JSON.parse(line)
  if (e.event === 'init') e.init.cwd = process.cwd()
  console.log(JSON.stringify(e))
}
`,
)
fs.chmodSync(fakeAgy, 0o755)

const env = { ...process.env, DELEGATE_JOBS_DIR: path.join(scratch, 'jobs-root'), AGY_BIN: fakeAgy }
let counter = 0

// What agy streams: one agent_response step per paragraph it says, then the result with the whole text.
function events(response) {
  const say = (i, text) => ({ event: 'step_update', step_update: { step_index: i, state: 'DONE', step_type: 'agent_response', text_delta: text } })
  const lines = response.split('\n')
  return [
    { event: 'init', init: { model: 'gemini-3.8-flash-high', cwd: '/replaced', tools: ['run_command'] } },
    ...lines.map((l, i) => say(i + 1, `${l}\n`)),
    { event: 'result', result: { status: 'SUCCESS', response, duration_seconds: 5, conversation_id: 'replay' } },
  ]
}

// Runs the fake agy through `jobs.mjs exec`, the way a relay does, and returns the job's files.
function replay(response, mode = 'task') {
  const work = path.join(scratch, `work-${counter++}`)
  fs.mkdirSync(work)
  const eventsFile = path.join(work, 'fixture-events.jsonl')
  fs.writeFileSync(eventsFile, `${events(response).map(e => JSON.stringify(e)).join('\n')}\n`)
  const run = (...args) => spawnSync(process.execPath, args, { cwd: work, env: { ...env, FAKE_AGY_EVENTS: eventsFile }, encoding: 'utf8' })
  const dir = run(JOBS, 'new', 'agy', '--label', 'replay').stdout.trim()
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Review the change.\n')
  const r = run(JOBS, 'exec', dir, '--', process.execPath, AGY_RUN, 'run', '--job-dir', dir, '--mode', mode)
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8')
  const prompt = JSON.parse(read('input.jsonl')).message.content
  return { exit: r.status, out: read('out.md'), err: read('err.log'), events: read('events.jsonl'), prompt }
}

const ANSWER = '## Agent Execution Summary\n\n- What was done: reviewed the change.\n- Files changed: none.'

describe('waiting lines in out.md', () => {
  test('the validation run: three waiting lines before the heading are dropped', () => {
    const waiting = [
      'I am waiting for the background type-check command to complete.',
      'The type-check command is running in the background. I will await its completion.',
      'The linter is running in the background. I will await its completion.',
    ]
    const r = replay(`${waiting.join('\n')}\n${ANSWER}`)
    assert.equal(r.exit, 0)
    assert.ok(r.out.startsWith('## Agent Execution Summary\n'), r.out)
    assert.equal(r.out, `${ANSWER}\n`)
    assert.match(r.err, /dropped 3 leading waiting line/)
    for (const line of waiting) assert.ok(r.events.includes(JSON.stringify(line).slice(1, -1)), `events.jsonl lost: ${line}`)
  })

  test('a long run of waiting phrases and blank lines before a heading', () => {
    const waiting = [
      'I have started the baseline lint check and am waiting for the command to finish.',
      'baseline lint check is running in the background.',
      'Baseline lint check is running across packages. I will wait for it to complete.',
      'Waiting for task to complete.',
      '',
      'Waiting for the storage type-check to finish.',
      'I will wait for it to finish.',
    ]
    const r = replay(`${waiting.join('\n')}\n### Summary of work\n\nFixed 3 findings.`)
    assert.equal(r.out, '### Summary of work\n\nFixed 3 findings.\n')
    assert.match(r.err, /dropped 6 leading waiting line/)
  })

  test('only leading lines go: a waiting line inside the answer stays', () => {
    const answer = `${ANSWER}\nI am waiting for the maintainers to complete the review.\nDone.`
    const r = replay(`Waiting for task to complete.\n${answer}`)
    assert.equal(r.out, `${answer}\n`)
  })

  test('an answer with no waiting lines is written as is', () => {
    const r = replay(ANSWER)
    assert.equal(r.out, `${ANSWER}\n`)
    assert.doesNotMatch(r.err, /dropped/)
  })

  test('a real first line stays when waiting words or "running" appear in it', () => {
    const firstLines = [
      'The build is running and has failed with 3 errors.',
      'I waited for the check to complete and found 3 errors.',
      'I am waiting for the check to complete and will report 3 errors.',
      'I removed the wait timeout so the task can finish.',
      'Unauthorized commands are running in the background.',
      'I am waiting for the maintainers to complete the review.',
      'I have started the migration and will wait for the DBA to finish.',
      'Waiting for the approval to finish.',
    ]
    for (const line of firstLines) {
      const answer = `${line}\nTests passed.`
      assert.equal(replay(answer).out, `${answer}\n`, line)
    }
  })

  test('a waiting line goes but the real line after it stays', () => {
    const r = replay('Waiting for task to complete.\nI removed the wait timeout so the task can finish.\nTests passed.')
    assert.equal(r.out, 'I removed the wait timeout so the task can finish.\nTests passed.\n')
  })

  test('progress narration other than waiting is left alone', () => {
    const answer = 'I am checking the lint status for a.ts.\n## Report\n\nDone.'
    assert.equal(replay(answer).out, `${answer}\n`)
  })

  test('an answer that is only waiting lines is not emptied', () => {
    const answer = 'I am waiting for the type-check to complete.\nWaiting for task to complete.'
    const r = replay(answer)
    assert.equal(r.exit, 0)
    assert.equal(r.out, `${answer}\n`)
  })
})

describe('rules in the assembled prompt', () => {
  const noAiClis = 'Do not run other AI CLIs (claude, codex, gemini, agy)'

  test('task mode, the read-only review case, gets the preamble rules and no implementer rules', () => {
    const { prompt } = replay(ANSWER, 'task')
    assert.ok(prompt.includes(noAiClis), 'task prompt lacks the no-other-AI-CLIs rule')
    assert.ok(prompt.includes('states results, not progress'))
    assert.ok(!prompt.includes('Rules for this job'), 'task prompt carries the implementer rules')
  })

  test('implement mode gets the preamble and the implementer rules', () => {
    const { prompt } = replay(ANSWER, 'implement')
    assert.ok(prompt.includes(noAiClis))
    assert.ok(prompt.includes('Rules for this job'))
    assert.ok(prompt.includes('Never edit ticket files, MAP.md or SPEC.md'))
  })
})
