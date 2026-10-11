import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createBrokerEndpoint, parseBrokerEndpoint } from './broker-endpoint.mjs'
import { resolveInvokerKey, resolveOwnerPid, resolveSessionId } from './invoker.mjs'
import { runCommand } from './process.mjs'
import { resolveStateDir } from './state.mjs'

export const PID_FILE_ENV = 'CODEX_COMPANION_APP_SERVER_PID_FILE'
export const LOG_FILE_ENV = 'CODEX_COMPANION_APP_SERVER_LOG_FILE'
const BROKERS_DIR_NAME = 'brokers'
const BROKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function createBrokerSessionDir(prefix = 'cxc-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint)
  return net.createConnection({ path: target.path })
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise(resolve => {
      const socket = connectToEndpoint(endpoint)
      socket.on('connect', () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (ready) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise(resolve => {
    const socket = connectToEndpoint(endpoint)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'broker/shutdown', params: {} })}\n`)
    })
    socket.on('data', () => {
      socket.end()
      resolve()
    })
    socket.on('error', resolve)
    socket.on('close', resolve)
  })
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  ownerPid = null,
  idleTimeoutMs = BROKER_IDLE_TIMEOUT_MS,
  env = process.env,
}) {
  const logFd = fs.openSync(logFile, 'a')
  const args = [scriptPath, 'serve', '--endpoint', endpoint, '--cwd', cwd, '--pid-file', pidFile]
  if (ownerPid) {
    args.push('--owner-pid', String(ownerPid))
  }
  args.push('--idle-timeout-ms', String(idleTimeoutMs))
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)
  return child
}

function resolveBrokersDir(cwd) {
  return path.join(resolveStateDir(cwd), BROKERS_DIR_NAME)
}

function resolveBrokerStateFile(cwd, invokerKey) {
  return path.join(resolveBrokersDir(cwd), `${invokerKey}.json`)
}

function readCodexVersion(cwd, env) {
  const result = runCommand('codex', ['--version'], { cwd, env })
  return result.error || result.status !== 0 ? null : result.stdout.trim() || null
}

export function loadBrokerSession(cwd, invokerKey = resolveInvokerKey()) {
  const stateFile = resolveBrokerStateFile(cwd, invokerKey)
  if (!fs.existsSync(stateFile)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

export function listBrokerSessions(cwd) {
  const brokersDir = resolveBrokersDir(cwd)
  if (!fs.existsSync(brokersDir)) {
    return []
  }
  return fs
    .readdirSync(brokersDir)
    .filter(name => name.endsWith('.json'))
    .map(name => loadBrokerSession(cwd, path.basename(name, '.json')))
    .filter(Boolean)
}

export function saveBrokerSession(cwd, session) {
  fs.mkdirSync(resolveBrokersDir(cwd), { recursive: true })
  fs.writeFileSync(
    resolveBrokerStateFile(cwd, session.invokerKey),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  )
}

export function clearBrokerSession(cwd, invokerKey = resolveInvokerKey()) {
  const stateFile = resolveBrokerStateFile(cwd, invokerKey)
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile)
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150)
  } catch {
    return false
  }
}

export async function shutdownBrokerSession(cwd, session, options = {}) {
  if (session.endpoint) {
    await sendBrokerShutdown(session.endpoint)
  }
  teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    killProcess: options.killProcess ?? null,
  })
  clearBrokerSession(cwd, session.invokerKey)
}

export async function ensureBrokerSession(cwd, options = {}) {
  const env = options.env ?? process.env
  const invokerKey = options.invokerKey ?? resolveInvokerKey(env)
  const codexVersion = readCodexVersion(cwd, env)
  const existing = loadBrokerSession(cwd, invokerKey)
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    // A broker outlives `npm i -g @openai/codex` and keeps serving the old binary.
    if (!codexVersion || existing.codexVersion === codexVersion) {
      return existing
    }
    await shutdownBrokerSession(cwd, existing, { killProcess: options.killProcess })
  } else if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null,
    })
    clearBrokerSession(cwd, invokerKey)
  }

  const sessionDir = createBrokerSessionDir()
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint
  const endpoint = endpointFactory(sessionDir, options.platform)
  const pidFile = path.join(sessionDir, 'broker.pid')
  const logFile = path.join(sessionDir, 'broker.log')
  const scriptPath =
    options.scriptPath ?? fileURLToPath(new URL('../app-server-broker.mjs', import.meta.url))
  const ownerPid = resolveOwnerPid(env)

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    ownerPid,
    env,
  })

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000)
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null,
    })
    return null
  }

  const session = {
    invokerKey,
    sessionId: resolveSessionId(env),
    ownerPid,
    codexVersion,
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    createdAt: new Date().toISOString(),
  }
  saveBrokerSession(cwd, session)
  return session
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null,
}) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid)
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile)
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile)
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint)
      if (target.kind === 'unix' && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path)
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null)
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir)
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
