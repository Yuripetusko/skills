#!/usr/bin/env node
// agy PreInvocation hook: writes the canary $JOB/loaded once, before the first model call. agy-run.mjs
// fails the job with exit 18 when it is missing, because then the job's hooks never ran.

import fs from 'node:fs'
import path from 'node:path'
import { CANARY, isVerifier, jobDir, logLine, readState, readStdin } from './job.mjs'

const raw = await readStdin()
try {
  if (!isVerifier()) {
    const dir = jobDir()
    const file = path.join(dir, CANARY)
    if (!fs.existsSync(file)) {
      const input = JSON.parse(raw || '{}')
      const canary = { agent: readState(dir).agent, at: new Date().toISOString(), conversationId: input.conversationId, model: input.modelName }
      fs.writeFileSync(file, `${JSON.stringify(canary)}\n`)
      logLine(dir, { hook: 'PreInvocation', decision: 'loaded', agent: canary.agent, keys: Object.keys(input) })
    }
  }
} catch (error) {
  process.stderr.write(`pre-invocation: ${error.message}\n`)
}
console.log('{}')
