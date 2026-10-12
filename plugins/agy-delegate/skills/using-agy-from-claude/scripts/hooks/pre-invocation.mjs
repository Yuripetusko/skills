#!/usr/bin/env node
// agy PreInvocation hook: writes the canary $JOB/loaded once per execution, before the first model
// call. agy-run.mjs fails the job with exit 18 when no canary carries this execution's AGY_DELEGATE_RUN.

import fs from 'node:fs'
import path from 'node:path'
import { CANARY, isVerifier, jobDir, logLine, readState, readStdin } from './job.mjs'

const raw = await readStdin()
try {
  if (!isVerifier()) {
    const dir = jobDir()
    const file = path.join(dir, CANARY)
    const run = process.env.AGY_DELEGATE_RUN ?? null
    let current = null
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    if (current?.run !== run) {
      const input = JSON.parse(raw || '{}')
      // agy 1.3.3's input names no agent, so the agent from state.json stands in; agy-run.mjs checks the
      // stream's init event for the agent that really ran.
      const named = [input.agentName, input.agent].find(a => typeof a === 'string' && a)
      const canary = { run, agent: named ?? readState(dir).agent, at: new Date().toISOString(), conversationId: input.conversationId, model: input.modelName }
      fs.writeFileSync(file, `${JSON.stringify(canary)}\n`)
      logLine(dir, { hook: 'PreInvocation', decision: 'loaded', agent: canary.agent, keys: Object.keys(input) })
    }
  }
} catch (error) {
  process.stderr.write(`pre-invocation: ${error.message}\n`)
}
console.log('{}')
