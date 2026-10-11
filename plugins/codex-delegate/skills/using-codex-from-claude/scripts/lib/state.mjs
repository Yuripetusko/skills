import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWorkspaceRoot } from './workspace.mjs'

const STATE_VERSION = 1
// Deliberately not CLAUDE_PLUGIN_DATA: the installed openai-codex plugin injects that variable into
// every Bash env, and its SessionEnd hook deletes the jobs it finds there.
const DATA_DIR_ENV = 'CODEX_SKILL_DATA_DIR'
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.claude', 'codex-skill')
const STATE_FILE_NAME = 'state.json'
const STATE_LOCK_NAME = 'state.lock'
const JOBS_DIR_NAME = 'jobs'
const MAX_JOBS = 50
const STATE_LOCK_TIMEOUT_MS = 5000
const STATE_LOCK_STALE_MS = 10000

function nowIso() {
  return new Date().toISOString()
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: [],
  }
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  let canonicalWorkspaceRoot = workspaceRoot
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot)
  } catch {
    canonicalWorkspaceRoot = workspaceRoot
  }

  const slugSource = path.basename(workspaceRoot) || 'workspace'
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const hash = createHash('sha256').update(canonicalWorkspaceRoot).digest('hex').slice(0, 16)
  const stateRoot = path.join(process.env[DATA_DIR_ENV] || DEFAULT_DATA_DIR, 'state')
  return path.join(stateRoot, `${slug}-${hash}`)
}

export function resolveDataDir() {
  return process.env[DATA_DIR_ENV] || DEFAULT_DATA_DIR
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME)
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME)
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true })
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd)
  if (!fs.existsSync(stateFile)) {
    return defaultState()
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {}),
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    }
  } catch {
    return defaultState()
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) =>
      String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')),
    )
    .slice(0, MAX_JOBS)
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs
  ensureStateDir(cwd)
  const nextJobs = pruneJobs(state.jobs ?? [])
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {}),
    },
    jobs: nextJobs,
  }

  const retainedIds = new Set(nextJobs.map(job => job.id))
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue
    }
    removeJobFile(resolveJobFile(cwd, job.id))
    removeFileIfExists(job.logFile)
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, 'utf8')
  return nextState
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Several invokers update the same job index concurrently; without the lock one writer's stale copy
// both drops the other's job and makes saveState delete that job's files.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd)
  const lockDir = path.join(resolveStateDir(cwd), STATE_LOCK_NAME)
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmdirSync(lockDir)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the Codex state lock at ${lockDir}.`)
      }
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {
      // Already removed as stale by another process.
    }
  }
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd)
    mutate(state)
    return saveState(cwd, state)
  })
}

export function generateJobId(prefix = 'job') {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, state => {
    const timestamp = nowIso()
    const existingIndex = state.jobs.findIndex(job => job.id === jobPatch.id)
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch,
      })
      return
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp,
    }
  })
}

export function listJobs(cwd) {
  return loadState(cwd).jobs
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, state => {
    state.config = {
      ...state.config,
      [key]: value,
    }
  })
}

export function getConfig(cwd) {
  return loadState(cwd).config
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd)
  const jobFile = resolveJobFile(cwd, jobId)
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return jobFile
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, 'utf8'))
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile)
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd)
  return path.join(resolveJobsDir(cwd), `${jobId}.log`)
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd)
  return path.join(resolveJobsDir(cwd), `${jobId}.json`)
}
