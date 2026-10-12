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
  let tmp, root, takeLock, releaseLock, removeIf, lockState
  const lockDir = name => path.join(root, '.locks', name)
  const ownerFile = name => path.join(lockDir(name), 'owner.json')
  const readOwner = name => JSON.parse(fs.readFileSync(ownerFile(name), 'utf8'))
  const leftovers = name => fs.readdirSync(path.join(root, '.locks')).filter(n => n.startsWith(name) && n !== name)
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
  const plant = (name, owner) => {
    fs.mkdirSync(lockDir(name), { recursive: true })
    if (owner) fs.writeFileSync(ownerFile(name), JSON.stringify(owner))
  }
  const age = (dir, seconds) => {
    const t = new Date(Date.now() - seconds * 1000)
    fs.utimesSync(dir, t, t)
  }

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locks-')))
    root = path.join(tmp, 'jobs')
    process.env.DELEGATE_JOBS_DIR = root
    ;({ takeLock, releaseLock, removeIf, lockState } = await import(`${pathToFileURL(JOBS).href}?locks`))
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  test('a free lock is taken, a held one is busy with its owner named, a released one is free again', () => {
    const a = takeLock('basic', 'job-a')
    assert.equal(a.dir, lockDir('basic'))
    assert.deepEqual(takeLock('basic', 'job-b'), { busy: 'job-a' })
    assert.equal(releaseLock(a), true)
    assert.deepEqual(leftovers('basic'), [])
    assert.equal(takeLock('basic', 'job-b').dir, lockDir('basic'))
  })

  test('a lock whose owner is gone is taken over, and nothing is left behind', () => {
    plant('dead-owner', { owner: 'old job', pid: deadPid() })
    const lock = takeLock('dead-owner', 'new job')
    assert.equal(lock.dir, lockDir('dead-owner'))
    assert.equal(readOwner('dead-owner').owner, 'new job')
    assert.deepEqual(leftovers('dead-owner'), [])
  })

  test('a lock without owner.json is busy while young and taken over after a minute', () => {
    plant('no-owner')
    assert.deepEqual(takeLock('no-owner', 'x'), { busy: 'another process' })
    age(lockDir('no-owner'), 120)
    assert.equal(takeLock('no-owner', 'x').dir, lockDir('no-owner'))
    assert.deepEqual(leftovers('no-owner'), [])
  })

  test('release removes only the lock this process took: a lock taken over meanwhile stays', () => {
    const a = takeLock('release', 'job-a')
    const theirs = { owner: 'job-b', pid: process.pid, token: 'taken-over' }
    fs.writeFileSync(ownerFile('release'), JSON.stringify(theirs))
    assert.equal(releaseLock(a), false)
    assert.deepEqual(readOwner('release'), theirs)
    assert.deepEqual(leftovers('release'), [])
    assert.equal(releaseLock({ busy: 'job-b' }), undefined)
    assert.equal(releaseLock(null), undefined)
    // Once it carries our token again, it goes.
    fs.writeFileSync(ownerFile('release'), JSON.stringify(a.owner))
    assert.equal(releaseLock(a), true)
    assert.equal(fs.existsSync(lockDir('release')), false)
  })

  test('removeIf puts back a directory that is not the one it was asked to remove', () => {
    const live = { owner: 'live job', pid: process.pid, token: 'live' }
    plant('swapped', { owner: 'old job', pid: deadPid(), token: 'old' })
    const stale = readOwner('swapped')
    // After the first check and before the move, a live lock takes the place of the stale one.
    const removed = removeIf(lockDir('swapped'), stale, 0, () => fs.writeFileSync(ownerFile('swapped'), JSON.stringify(live)))
    assert.equal(removed, false)
    assert.deepEqual(readOwner('swapped'), live)
    assert.deepEqual(leftovers('swapped'), [])
    // One that is too young is put back too.
    plant('too-young', { owner: 'x', pid: process.pid, token: 't' })
    assert.equal(removeIf(lockDir('too-young'), readOwner('too-young'), 60_000), false)
    assert.deepEqual(readOwner('too-young'), { owner: 'x', pid: process.pid, token: 't' })
    assert.deepEqual(leftovers('too-young'), [])
  })

  test('a guard left by a dead taker is reaped after 10 s, with or without an owner file', () => {
    for (const [name, owner] of [['guarded', { pid: deadPid(), token: 'g' }], ['guarded-bare', null]]) {
      plant(name, { owner: 'old job', pid: deadPid() })
      plant(`${name}.takeover`, owner)
      age(lockDir(`${name}.takeover`), 30)
      assert.equal(takeLock(name, 'x').dir, lockDir(name))
      assert.deepEqual(leftovers(name), [])
    }
  })

  test('a guard younger than 10 s holds takeovers off, and neither it nor the stale lock is touched', () => {
    const stale = { owner: 'old job', pid: deadPid() }
    plant('held-off', stale)
    plant('held-off.takeover', { pid: process.pid, token: 'other taker' })
    assert.deepEqual(takeLock('held-off', 'x'), { busy: 'another process' })
    assert.deepEqual(readOwner('held-off'), stale)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockDir('held-off.takeover'), 'owner.json'), 'utf8')), { pid: process.pid, token: 'other taker' })
    assert.deepEqual(leftovers('held-off'), ['held-off.takeover'])
  })

  test('a taker whose guard was reaped while it was paused leaves the stale lock alone and keeps the new guard', () => {
    const stale = { owner: 'old job', pid: deadPid(), token: 'old' }
    plant('paused', stale)
    const newGuard = { pid: process.pid, token: 'the taker that reaped it' }
    const beforeMove = () => fs.writeFileSync(path.join(lockDir('paused.takeover'), 'owner.json'), JSON.stringify(newGuard))
    assert.deepEqual(takeLock('paused', 'x', { beforeMove }), { busy: 'another process' })
    assert.deepEqual(readOwner('paused'), stale)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lockDir('paused.takeover'), 'owner.json'), 'utf8')), newGuard)
  })

  test('a live taker paused under its guard for more than 10 s keeps it: no other taker gets in', () => {
    const stale = { owner: 'old job', pid: deadPid(), token: 'old' }
    plant('stalled', stale)
    let inner
    // While the outer taker is paused, its guard ages past 10 s and a second taker tries the same lock.
    const beforeMove = () => {
      age(lockDir('stalled.takeover'), 30)
      inner = takeLock('stalled', 'inner')
    }
    const outer = takeLock('stalled', 'outer', { beforeMove })
    assert.deepEqual(inner, { busy: 'another process' })
    assert.equal(outer.dir, lockDir('stalled'))
    assert.equal(readOwner('stalled').owner, 'outer')
    assert.deepEqual(leftovers('stalled'), [])
  })

  test('a stale lock replaced by a live one under the guard is not moved', () => {
    plant('replaced', { owner: 'old job', pid: deadPid(), token: 'old' })
    const live = { owner: 'live job', pid: process.pid, token: 'live' }
    const beforeMove = () => {
      fs.rmSync(lockDir('replaced'), { recursive: true })
      plant('replaced', live)
    }
    assert.deepEqual(takeLock('replaced', 'x', { beforeMove }), { busy: 'live job' })
    assert.deepEqual(readOwner('replaced'), live)
    assert.deepEqual(leftovers('replaced'), [])
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
    const dead = { owner: 'job', pid: deadPid(), token: 'old' }
    plant('aba2', dead)
    assert.deepEqual(lockState(lockDir('aba2')), { stale: true, owner: dead })
  })

  // Workers take the lock in turns and bump a counter with a read, a pause and a write, which loses
  // updates when two hold the lock at once. A worker that is meant to crash ends without releasing, so
  // its lock goes stale under the others. Most workers also exit just after releasing, which is how a
  // taker comes to read an owner that has already gone.
  const WORKER = `import { releaseLock, takeLock } from ${JSON.stringify(pathToFileURL(JOBS).href)}
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
  if (!releaseLock(lock)) fs.writeFileSync(path.join(scratch, 'lost-lock-' + id + '-' + i), '')
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
    assert.deepEqual(fs.readdirSync(scratch).filter(n => n.startsWith('overlap-') || n.startsWith('lost-lock-')), [])
    assert.equal(Number(fs.readFileSync(path.join(scratch, 'counter'), 'utf8')), workers * rounds)
    assert.deepEqual(leftovers('stress'), [])
  })
})
