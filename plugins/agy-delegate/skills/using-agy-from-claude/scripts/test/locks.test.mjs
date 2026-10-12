// takeLock in jobs.mjs: mutual exclusion while stale locks are being taken over.
// Run: node --test 'scripts/test/*.test.mjs'

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const JOBS = path.join(HERE, '..', 'jobs.mjs')

describe('takeLock', () => {
  let tmp, root, takeLock, lockState
  const lockDir = name => path.join(root, '.locks', name)
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
  const plant = (name, owner) => {
    fs.mkdirSync(lockDir(name), { recursive: true })
    if (owner) fs.writeFileSync(path.join(lockDir(name), 'owner.json'), JSON.stringify(owner))
  }
  const age = (dir, seconds) => {
    const t = new Date(Date.now() - seconds * 1000)
    fs.utimesSync(dir, t, t)
  }

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locks-')))
    root = path.join(tmp, 'jobs')
    process.env.DELEGATE_JOBS_DIR = root
    ;({ takeLock, lockState } = await import(`${pathToFileURL(JOBS).href}?locks`))
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  test('a free lock is taken, a held one is busy with its owner named, a released one is free again', () => {
    const a = takeLock('basic', 'job-a')
    assert.equal(a.dir, lockDir('basic'))
    assert.deepEqual(takeLock('basic', 'job-b'), { busy: 'job-a' })
    fs.rmSync(a.dir, { recursive: true })
    assert.equal(takeLock('basic', 'job-b').dir, lockDir('basic'))
  })

  test('a lock whose owner is gone is taken over, and nothing is left behind', () => {
    plant('dead-owner', { owner: 'old job', pid: deadPid() })
    const lock = takeLock('dead-owner', 'new job')
    assert.equal(lock.dir, lockDir('dead-owner'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock.dir, 'owner.json'), 'utf8')).owner, 'new job')
    assert.deepEqual(fs.readdirSync(path.join(root, '.locks')).filter(n => n.startsWith('dead-owner')), ['dead-owner'])
  })

  test('a lock without owner.json is busy while young and taken over after a minute', () => {
    plant('no-owner')
    assert.deepEqual(takeLock('no-owner', 'x'), { busy: 'another process' })
    age(lockDir('no-owner'), 120)
    assert.equal(takeLock('no-owner', 'x').dir, lockDir('no-owner'))
  })

  test('a guard left by a dead taker is removed after 10 s, not before', () => {
    plant('guarded', { owner: 'old job', pid: deadPid() })
    plant('guarded.takeover')
    age(lockDir('guarded.takeover'), 30)
    assert.equal(takeLock('guarded', 'x').dir, lockDir('guarded'))
    assert.equal(fs.existsSync(lockDir('guarded.takeover')), false)
  })

  test('a lock released and taken again after the owner was read is not stale, though the old owner is gone', () => {
    const dir = lockDir('aba')
    const owner = pid => JSON.stringify({ owner: 'job', pid, token: `t${pid}` })
    plant('aba', { owner: 'job', pid: deadPid(), token: 'old' })
    // Between the read and the liveness check, the owner releases and exits, and a live process takes the name.
    const state = lockState(dir, () => fs.writeFileSync(path.join(dir, 'owner.json'), owner(process.pid)))
    assert.deepEqual(state, { changed: true })
    assert.deepEqual(lockState(dir), { busy: 'job' })
    // Without the swap the same lock is stale.
    plant('aba2', { owner: 'job', pid: deadPid(), token: 'old' })
    assert.deepEqual(lockState(lockDir('aba2')), { stale: true })
  })

  // Workers take the lock in turns and bump a counter with a read, a pause and a write, which loses
  // updates when two hold the lock at once. A worker that is meant to crash ends without releasing, so
  // its lock goes stale under the others. Most workers also exit just after releasing, which is how a
  // taker comes to read an owner that has already gone.
  const WORKER = `import { takeLock } from ${JSON.stringify(pathToFileURL(JOBS).href)}
import fs from 'node:fs'
import path from 'node:path'
const [scratch, id, rounds, crash] = process.argv.slice(2)
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const counter = path.join(scratch, 'counter')
for (let i = 0; i < Number(rounds); i++) {
  let lock
  while ((lock = takeLock('stress', 'worker ' + id)).busy) sleep(Math.random() * 0.4)
  try {
    fs.mkdirSync(path.join(scratch, 'inside'))
  } catch {
    fs.writeFileSync(path.join(scratch, 'overlap-' + id + '-' + i), '')
  }
  const n = Number(fs.readFileSync(counter, 'utf8'))
  sleep(Math.random() * 0.5)
  fs.writeFileSync(counter, String(n + 1))
  fs.rmSync(path.join(scratch, 'inside'), { recursive: true, force: true })
  if (crash === '1' && i === Number(rounds) - 1) process.exit(0)
  fs.rmSync(lock.dir, { recursive: true, force: true })
}
`

  test('sixty workers, half of them dying with the lock held: no overlap, no lost update', async () => {
    const scratch = path.join(tmp, 'stress')
    fs.mkdirSync(scratch)
    fs.writeFileSync(path.join(scratch, 'counter'), '0')
    const script = path.join(tmp, 'stress-worker.mjs')
    fs.writeFileSync(script, WORKER)
    const [workers, rounds] = [60, 5]
    const codes = await Promise.all(
      Array.from({ length: workers }, (_, id) =>
        new Promise(resolve => {
          const child = spawn(process.execPath, [script, scratch, String(id), String(rounds), id % 2 ? '1' : '0'], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] })
          child.on('exit', code => resolve(code))
        }),
      ),
    )
    assert.deepEqual(new Set(codes), new Set([0]))
    assert.deepEqual(fs.readdirSync(scratch).filter(n => n.startsWith('overlap-')), [])
    assert.equal(Number(fs.readFileSync(path.join(scratch, 'counter'), 'utf8')), workers * rounds)
    assert.deepEqual(fs.readdirSync(path.join(root, '.locks')).filter(n => n.startsWith('stress') && n !== 'stress'), [])
  })
})
