#!/usr/bin/env node
// Offline stand-in for `jobs.mjs`'s gate command, for agy-run tests (AGY_DELEGATE_GATE_BIN). Takes the
// same arguments and exit codes, and writes the baseline and delta files the runner and stop.mjs read.
// FAKE_GATE_BASELINE  exit status of `baseline`: 0 (default), 2 (could not run) or 3 (not configured)
// FAKE_GATE_CHECKS    comma-separated result of each `check` round, the last one repeating:
//                     0 clean, 1 one finding added, 2 could not run, `kill` SIGKILLs the calling
//                     hook, `hang` never answers
// FAKE_GATE_LOG       file that gets one JSON line of arguments per call

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(3) // after `gate`
const env = process.env
const opt = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const dir = path.join(opt('--job'), 'gate')
const write = (name, data) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`)
}
if (env.FAKE_GATE_LOG) fs.appendFileSync(env.FAKE_GATE_LOG, `${JSON.stringify(argv)}\n`)

if (argv[0] === 'baseline') {
  const status = Number(env.FAKE_GATE_BASELINE ?? 0)
  if (status === 0) {
    const scope = { whole: false, reason: null, paths: ['src/**'], seeds: ['src'], units: ['src'] }
    write('baseline.json', { phase: 'baseline', configured: true, complete: true, config: 'fake-gate.json', scope, findings: [] })
    console.log('GATE BASELINE: 0 finding(s) from 1 command(s) in 0s · scope 1 unit(s)')
  } else if (status === 3) console.log('GATE: not configured (no .agents/delegate-gate.json and no --gate-config)')
  else console.log('GATE ERROR: the baseline could not run\n  ERROR lint:src  0s  exited 2 without diagnostics')
  process.exit(status)
}

const round = Number(opt('--round'))
const results = (env.FAKE_GATE_CHECKS ?? '0').split(',')
const result = results[Math.min(round, results.length) - 1]
if (result === 'kill') {
  process.kill(process.ppid, 'SIGKILL')
  process.exit(0)
}
if (result === 'hang') setInterval(() => {}, 1000)
else if (result === '2') {
  write(`delta-${round}.json`, { round, verdict: 'error', complete: false, errors: ['lint:src: exited 2'] })
  console.log(`GATE ERROR: could not run (round ${round}): lint:src: exited 2`)
  process.exit(2)
} else {
  const added =
    result === '1'
      ? [{ tool: 'lint', rule: 'typescript(no-explicit-any)', file: 'src/b.ts', line: 1, column: 18, severity: 'warning', message: 'Unexpected any. Specify a different type.' }]
      : []
  write(`delta-${round}.json`, { round, verdict: added.length ? 'failed' : 'ok', complete: true, added, removed: [], outsideScope: [] })
  console.log(`GATE ${added.length ? 'FAILED' : 'OK'}: ${added.length} added, 0 removed · round ${round} · 0s`)
  for (const f of added) console.log(`  + ${f.rule}  ${f.file}:${f.line}:${f.column}  ${f.message}`)
  console.log(`Details: ${path.join(dir, `delta-${round}.json`)}`)
  process.exit(added.length ? 1 : 0)
}
