#!/usr/bin/env node
/**
 * Bootstrap a new implementation plan:
 * - create specs/<scope>/tickets/, specs/<scope>/spikes/ and specs/<scope>/assets/
 *
 * Deliberately does NOT create SPEC.md: the spec is a *designed* artifact (authored through the
 * spec gate, from notes or grilling), not boilerplate.
 *
 * Deliberately does NOT create MAP.md either: status lives inside each ticket. The status-free MAP.md is born via `new-ticket.js --update-index`.
 */

const fs = require('node:fs')
const path = require('node:path')

function die(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function parseArgs(argv) {
  const out = { repoRoot: '.', scope: null, json: false }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) die(`Missing value for ${a}`)
      return argv[++i]
    }

    if (a === '--repo-root') out.repoRoot = next()
    else if (a === '--scope') out.scope = next()
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'Usage: node bootstrap-spec.js --scope <scope> [options]',
          '',
          'Scaffolds specs/<scope>/{tickets,spikes,assets}/.',
          'Does not create SPEC.md: author the spec (the design source) through the spec gate.',
          'Does not create MAP.md: status lives inside each ticket; the status-free MAP.md is',
          'born via `new-ticket.js --update-index`.',
          '',
          'Options:',
          '  --repo-root <path>  Repo root (default: .)',
          '  --scope <name>      Implementation plan name, kebab-case, named for its intent (required)',
          '  --json              Output machine-readable JSON (default: off)',
          '',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      die(`Unknown arg: ${a}`)
    }
  }

  if (!out.scope) die('Missing required --scope')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.scope)) die(`--scope must be kebab-case: ${out.scope}`)
  return out
}

function main() {
  const args = parseArgs(process.argv)

  const repoRoot = path.resolve(process.cwd(), args.repoRoot)
  if (!fs.existsSync(repoRoot)) die(`Repo root does not exist: ${repoRoot}`)

  const scopeDir = path.join(repoRoot, 'specs', args.scope)
  const ticketsDir = path.join(scopeDir, 'tickets')
  const spikesDir = path.join(scopeDir, 'spikes')
  const assetsDir = path.join(scopeDir, 'assets')
  fs.mkdirSync(ticketsDir, { recursive: true })
  fs.mkdirSync(spikesDir, { recursive: true })
  fs.mkdirSync(assetsDir, { recursive: true })

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        repoRoot,
        scope: args.scope,
        scopeDir,
        scopeRelPath: toPosix(path.relative(repoRoot, scopeDir)),
        ticketsDir,
        spikesDir,
        assetsDir,
      })}\n`,
    )
    return
  }

  process.stdout.write(`Scaffolded specs/${args.scope}/ (tickets/, spikes/, assets/)\n`)
  process.stdout.write(
    `Next: author specs/${args.scope}/SPEC.md (the design source) through the spec gate.\n`,
  )
  process.stdout.write(`Then add tickets with: new-ticket.js --update-index (creates MAP.md).\n`)
}

main()
