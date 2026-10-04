#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs, splitRawArgumentString } from './lib/args.mjs'
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
  interruptActiveTurns,
  interruptAppServerTurn,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn,
} from './lib/codex.mjs'
import { readStdinIfPiped } from './lib/fs.mjs'
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from './lib/git.mjs'
import { INVOKER_ENV, resolveInvokerKey, resolveSessionId } from './lib/invoker.mjs'
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst,
} from './lib/job-control.mjs'
import { binaryAvailable, terminateProcessTree } from './lib/process.mjs'
import { loadPromptTemplate, interpolateTemplate } from './lib/prompts.mjs'
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
} from './lib/render.mjs'
import { generateJobId, listJobs, upsertJob, writeJobFile } from './lib/state.mjs'
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
} from './lib/tracked-jobs.mjs'
import { resolveWorkspaceRoot } from './lib/workspace.mjs'

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REVIEW_SCHEMA = path.join(ROOT_DIR, 'schemas', 'review-output.schema.json')
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000
// max/ultra efforts are deliberately not accepted: xhigh is the ceiling we pay for.
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
const DEFAULT_REASONING_EFFORT = 'xhigh'
const SUPPORTED_MODELS = new Set(['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol'])
const MODEL_ALIASES = new Map([
  ['astra', 'gpt-6-astra'],
  ['sol', 'gpt-6-sol'],
])
const TERMINATION_SIGNALS = new Map([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGTERM', 15],
])

function printUsage() {
  console.log(
    [
      'Usage (every subcommand also takes --invoker <name>; see SKILL.md):',
      '  node scripts/codex-companion.mjs setup [--json]',
      '  node scripts/codex-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>]',
      '  node scripts/codex-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>] [focus text]',
      '  node scripts/codex-companion.mjs task [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <effort>] [--prompt-file <path>] [prompt]',
      '    <model>: gpt-6-astra (astra) | gpt-6-sol (sol) | gpt-6.1-sol; default from ~/.codex/config.toml',
      '    <effort>: medium for small tasks, xhigh (default) for most; also low | high',
      '  node scripts/codex-companion.mjs status [job-id] [--all] [--json]',
      '  node scripts/codex-companion.mjs result [job-id] [--json]',
      '  node scripts/codex-companion.mjs cancel [job-id] [--json]',
    ].join('\n'),
  )
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2))
  } else {
    process.stdout.write(value)
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson)
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null
  }
  const normalized = String(model).trim()
  if (!normalized) {
    return null
  }
  const resolved = MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized
  if (!SUPPORTED_MODELS.has(resolved)) {
    throw new Error(
      `Unsupported model "${model}". Use one of: ${[...SUPPORTED_MODELS].join(', ')} (aliases: astra, sol).`,
    )
  }
  return resolved
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return DEFAULT_REASONING_EFFORT
  }
  const normalized = String(effort).trim().toLowerCase()
  if (!normalized) {
    return DEFAULT_REASONING_EFFORT
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${[...VALID_REASONING_EFFORTS].join(', ')}.`,
    )
  }
  return normalized
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv
    if (!raw || !raw.trim()) {
      return []
    }
    return splitRawArgumentString(raw)
  }
  return argv
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    valueOptions: [...(config.valueOptions ?? []), 'invoker'],
    booleanOptions: [...(config.booleanOptions ?? []), 'background', 'wait'],
    aliasMap: {
      C: 'cwd',
      ...(config.aliasMap ?? {}),
    },
  })
  if (parsed.options.background) {
    throw new Error(
      '--background was removed: run the command itself as a background Bash task (run_in_background) instead.',
    )
  }
  // Set before any job record or broker is created so both are keyed to this invoker.
  if (parsed.options.invoker) {
    process.env[INVOKER_ENV] = parsed.options.invoker
  }
  return parsed
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd()
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!normalized) {
    return ''
  }
  if (normalized.length <= limit) {
    return normalized
  }
  return `${normalized.slice(0, limit - 3)}...`
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(Boolean)
  return line ?? fallback
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const nodeStatus = binaryAvailable('node', ['--version'], { cwd })
  const npmStatus = binaryAvailable('npm', ['--version'], { cwd })
  const codexStatus = getCodexAvailability(cwd)
  const authStatus = await getCodexAuthStatus(cwd)
  const nextSteps = []
  if (!codexStatus.available) {
    nextSteps.push('Install Codex with `npm install -g @openai/codex`.')
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push('Run `!codex login`.')
    nextSteps.push(
      'If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.',
    )
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    actionsTaken,
    nextSteps,
  }
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  })

  const cwd = resolveCommandCwd(options)
  const finalReport = await buildSetupReport(cwd)
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json)
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, 'adversarial-review')
  return interpolateTemplate(template, {
    REVIEW_KIND: 'Adversarial Review',
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || 'No extra focus provided.',
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
  })
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd)
  if (!availability.available) {
    throw new Error(
      'Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `codex-companion.mjs setup`.',
    )
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === 'working-tree') {
    return { type: 'uncommittedChanges' }
  }

  if (target.mode === 'branch') {
    return { type: 'baseBranch', branch: target.baseRef }
  }

  return null
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`review\` maps directly to the built-in reviewer and does not support custom focus text. Retry with \`adversarial-review ${focusText.trim()}\` for focused review instructions.`,
    )
  }

  const nativeTarget = buildNativeReviewTarget(target)
  if (!nativeTarget) {
    throw new Error(
      'This `review` target is not supported by the built-in reviewer. Retry with `adversarial-review` for custom targeting.',
    )
  }

  return nativeTarget
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report)
}

function isActiveJobStatus(status) {
  return status === 'queued' || status === 'running'
}

function getCurrentClaudeSessionId() {
  return resolveSessionId()
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId()
  if (!sessionId) {
    return jobs
  }
  return jobs.filter(job => job.sessionId === sessionId)
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      job =>
        job.jobClass === 'task' &&
        job.threadId &&
        job.status !== 'queued' &&
        job.status !== 'running',
    ) ?? null
  )
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS)
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS,
  )
  const deadline = Date.now() + timeoutMs
  let snapshot = buildSingleJobSnapshot(cwd, reference)

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
    snapshot = buildSingleJobSnapshot(cwd, reference)
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs,
  }
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  const sessionId = getCurrentClaudeSessionId()
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    job => job.id !== options.excludeJobId,
  )
  // Concurrent orchestrators share one Claude session; a named invoker only resumes its own thread.
  const sessionJobs = filterJobsForCurrentClaudeSession(jobs)
  const visibleJobs = process.env[INVOKER_ENV]
    ? sessionJobs.filter(job => job.invoker === resolveInvokerKey())
    : sessionJobs
  const activeTask = visibleJobs.find(
    job => job.jobClass === 'task' && (job.status === 'queued' || job.status === 'running'),
  )
  if (activeTask) {
    throw new Error(
      `Task ${activeTask.id} is still running. Check "codex-companion.mjs status" before continuing it.`,
    )
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs)
  if (trackedTask) {
    return { id: trackedTask.threadId }
  }

  if (sessionId) {
    return null
  }

  return findLatestTaskThread(workspaceRoot)
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd)
  ensureGitRepository(request.cwd)

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope,
  })
  const focusText = request.focusText?.trim() ?? ''
  const reviewName = request.reviewName ?? 'Review'
  if (reviewName === 'Review') {
    const reviewTarget = validateNativeReviewRequest(target, focusText)
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      effort: request.effort,
      onProgress: request.onProgress,
    })
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary,
      },
    }
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr,
      },
      {
        reviewLabel: reviewName,
        targetLabel: target.label,
        reasoningSummary: result.reasoningSummary,
      },
    )

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: 'review',
      targetLabel: target.label,
    }
  }

  const context = collectReviewContext(request.cwd, target)
  const prompt = buildAdversarialReviewPrompt(context, focusText)
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    sandbox: 'read-only',
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
  })
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr,
  })
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary,
  }

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary,
    }),
    summary:
      parsed.parsed?.summary ??
      parsed.parseError ??
      firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: 'review',
    targetLabel: context.target.label,
  }
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd)
  ensureCodexAvailable(request.cwd)

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
  })

  let resumeThreadId = null
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId,
    })
    if (!latestThread) {
      throw new Error('No previous Codex task thread was found for this repository.')
    }
    resumeThreadId = latestThread.id
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error('Provide a prompt, a prompt file, piped stdin, or use --resume-last.')
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : '',
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? 'workspace-write' : 'read-only',
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId
      ? null
      : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
  })

  const rawOutput = typeof result.finalMessage === 'string' ? result.finalMessage : ''
  const failureMessage = result.error?.message ?? result.stderr ?? ''
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary,
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
    },
  )
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
  }

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(
      rawOutput,
      firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`),
    ),
    jobTitle: taskMetadata.title,
    jobClass: 'task',
    write: Boolean(request.write),
  }
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === 'Adversarial Review' ? 'adversarial-review' : 'review',
    title: reviewName === 'Review' ? 'Codex Review' : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`,
  }
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? 'Codex Resume' : 'Codex Task'
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : 'Task'
  return {
    title,
    summary: shorten(prompt || fallbackSummary),
  }
}

function getJobKindLabel(kind, jobClass) {
  if (kind === 'adversarial-review') {
    return 'adversarial-review'
  }
  return jobClass === 'review' ? 'review' : 'rescue'
}

function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
  })
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title)
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  }
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: 'task',
    kind: 'task',
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: 'task',
    summary: taskMetadata.summary,
    write,
  })
}

function readTaskPrompt(cwd, options, positionals) {
  if (options['prompt-file']) {
    return fs.readFileSync(path.resolve(cwd, options['prompt-file']), 'utf8')
  }

  const positionalPrompt = positionals.join(' ')
  return positionalPrompt || readStdinIfPiped()
}

function markJobTerminated(job, errorMessage) {
  const completedAt = nowIso()
  const storedJob = readStoredJob(job.workspaceRoot, job.id) ?? job
  writeJobFile(job.workspaceRoot, job.id, {
    ...storedJob,
    status: 'failed',
    phase: 'terminated',
    pid: null,
    errorMessage,
    completedAt,
  })
  upsertJob(job.workspaceRoot, {
    id: job.id,
    status: 'failed',
    phase: 'terminated',
    pid: null,
    errorMessage,
    completedAt,
  })
}

// A Bash timeout or a closing session signals the runner. Record why the job ended and stop the Codex
// turn, instead of leaving a "running" job and a turn nobody will read.
function installTerminationHandlers(job, logFile) {
  const handlers = new Map()
  for (const [signal, signalNumber] of TERMINATION_SIGNALS) {
    const handler = async () => {
      const errorMessage = `Runner received ${signal} before Codex finished; the turn was interrupted.`
      appendLogLine(logFile, errorMessage)
      process.stderr.write(`[codex] ${errorMessage}\n`)
      markJobTerminated(job, errorMessage)
      await interruptActiveTurns()
      process.exit(128 + signalNumber)
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler)
    }
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json,
  })
  if (!options.json) {
    process.stderr.write(`[codex] Job ${job.id} (invoker ${job.invoker}), log: ${logFile}\n`)
  }
  const removeTerminationHandlers = installTerminationHandlers(job, logFile)
  try {
    const execution = await runTrackedJob(job, () => runner(progress), { logFile })
    outputResult(options.json ? execution.payload : execution.rendered, options.json)
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus
    }
    return execution
  } finally {
    removeTerminationHandlers()
  }
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['base', 'scope', 'model', 'effort', 'cwd'],
    booleanOptions: ['json', 'background', 'wait'],
    aliasMap: {
      m: 'model',
    },
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const focusText = positionals.join(' ').trim()
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope,
  })

  config.validateRequest?.(target, focusText)
  const metadata = buildReviewJobMetadata(config.reviewName, target)
  const job = createCompanionJob({
    prefix: 'review',
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: 'review',
    summary: metadata.summary,
  })
  await runForegroundCommand(
    job,
    progress =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        effort: normalizeReasoningEffort(options.effort),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
      }),
    { json: options.json },
  )
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: 'Review',
    validateRequest: validateNativeReviewRequest,
  })
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['model', 'effort', 'cwd', 'prompt-file'],
    booleanOptions: ['json', 'write', 'resume-last', 'resume', 'fresh', 'background'],
    aliasMap: {
      m: 'model',
    },
  })

  const cwd = resolveCommandCwd(options)
  const workspaceRoot = resolveCommandWorkspace(options)
  const model = normalizeRequestedModel(options.model)
  const effort = normalizeReasoningEffort(options.effort)
  const prompt = readTaskPrompt(cwd, options, positionals)

  const resumeLast = Boolean(options['resume-last'] || options.resume)
  const fresh = Boolean(options.fresh)
  if (resumeLast && fresh) {
    throw new Error('Choose either --resume/--resume-last or --fresh.')
  }
  const write = Boolean(options.write)
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
  })

  const job = buildTaskJob(workspaceRoot, taskMetadata, write)
  await runForegroundCommand(
    job,
    progress =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress,
      }),
    { json: options.json },
  )
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd', 'timeout-ms', 'poll-interval-ms'],
    booleanOptions: ['json', 'all', 'wait'],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ''
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options['timeout-ms'],
          pollIntervalMs: options['poll-interval-ms'],
        })
      : buildSingleJobSnapshot(cwd, reference)
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json)
    return
  }

  if (options.wait) {
    throw new Error('`status --wait` requires a job id.')
  }

  const report = buildStatusSnapshot(cwd, { all: options.all })
  outputResult(renderStatusPayload(report, options.json), options.json)
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ''
  const { workspaceRoot, job } = resolveResultJob(cwd, reference)
  const storedJob = readStoredJob(workspaceRoot, job.id)
  const payload = {
    job,
    storedJob,
  }

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json)
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  })

  const cwd = resolveCommandCwd(options)
  const reference = positionals[0] ?? ''
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env })
  const existing = readStoredJob(workspaceRoot, job.id) ?? {}
  const threadId = existing.threadId ?? job.threadId ?? null
  const turnId = existing.turnId ?? job.turnId ?? null

  const interrupt = await interruptAppServerTurn(cwd, {
    threadId,
    turnId,
    invokerKey: existing.invoker ?? job.invoker ?? null,
  })
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : '.'}`,
    )
  }

  terminateProcessTree(job.pid ?? Number.NaN)
  appendLogLine(job.logFile, 'Cancelled by user.')

  const completedAt = nowIso()
  const nextJob = {
    ...job,
    status: 'cancelled',
    phase: 'cancelled',
    pid: null,
    completedAt,
    errorMessage: 'Cancelled by user.',
  }

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
  })
  upsertJob(workspaceRoot, {
    id: job.id,
    status: 'cancelled',
    phase: 'cancelled',
    pid: null,
    errorMessage: 'Cancelled by user.',
    completedAt,
  })

  const payload = {
    jobId: job.id,
    status: 'cancelled',
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
  }

  outputCommandResult(payload, renderCancelReport(nextJob), options.json)
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2)
  // Without this, `adversarial-review --help` starts a real review with "--help" as the focus text.
  if (
    !subcommand ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    printUsage()
    return
  }

  switch (subcommand) {
    case 'setup':
      await handleSetup(argv)
      break
    case 'review':
      await handleReview(argv)
      break
    case 'adversarial-review':
      await handleReviewCommand(argv, {
        reviewName: 'Adversarial Review',
      })
      break
    case 'task':
      await handleTask(argv)
      break
    case 'status':
      await handleStatus(argv)
      break
    case 'result':
      handleResult(argv)
      break
    case 'cancel':
      await handleCancel(argv)
      break
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`)
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
