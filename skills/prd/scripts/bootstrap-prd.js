#!/usr/bin/env node
/**
 * Bootstrap a new plan scope:
 * - create plans/<scope>/prds/ and plans/<scope>/spikes/
 *
 * Deliberately does NOT create plan.md — the plan is a *designed* artifact (author it via your
 * planning / grilling process), not boilerplate.
 *
 * Deliberately does NOT create an index/README either — there's no status dashboard; status lives
 * inside each PRD. An optional status-free README is born on demand via `new-prd.js --update-index`
 * once a plan fans into several PRDs.
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
          'Usage: node bootstrap-prd.js --scope <scope> [options]',
          '',
          'Scaffolds plans/<scope>/{prds,spikes}/.',
          'Does not create plan.md — author the plan (the design source) yourself.',
          'Does not create an index — status lives inside each PRD; an optional status-free',
          'README is born on demand via `new-prd.js --update-index`.',
          '',
          'Options:',
          '  --repo-root <path>  Repo root (default: .)',
          '  --scope <name>      Scope / epic / branch name (required)',
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
  return out
}

function main() {
  const args = parseArgs(process.argv)

  const repoRoot = path.resolve(process.cwd(), args.repoRoot)
  if (!fs.existsSync(repoRoot)) die(`Repo root does not exist: ${repoRoot}`)

  const scopeDir = path.join(repoRoot, 'plans', args.scope)
  const prdsDir = path.join(scopeDir, 'prds')
  const spikesDir = path.join(scopeDir, 'spikes')
  fs.mkdirSync(prdsDir, { recursive: true })
  fs.mkdirSync(spikesDir, { recursive: true })

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        repoRoot,
        scope: args.scope,
        scopeDir,
        scopeRelPath: toPosix(path.relative(repoRoot, scopeDir)),
        prdsDir,
        spikesDir,
      })}\n`,
    )
    return
  }

  process.stdout.write(`Scaffolded plans/${args.scope}/ (prds/, spikes/)\n`)
  process.stdout.write(
    `Next: author plans/${args.scope}/plan.md (the design source) — e.g. via grill-me.\n`,
  )
  process.stdout.write(
    `If this fans into several PRDs, add a status-free index with: new-prd.js --update-index.\n`,
  )
}

main()
