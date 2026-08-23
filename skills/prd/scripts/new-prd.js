#!/usr/bin/env node
/**
 * Create a new PRD markdown file using house conventions and the PRD template.
 *
 * PRDs live at: <root>/plans/<scope>/prds/<slug>-prd.md
 * (the scope groups a plan.md + its prds/ + spikes/ — see references/prd-conventions.md)
 *
 * Safe defaults, no external deps. Rendering is token-based ({{TITLE}}, {{SCOPE}}) — a PRD has no
 * YAML front matter, unlike an ADR.
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

function slugify(text) {
  const t = String(text || '')
    .trim()
    .toLowerCase()
  const dashed = t
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
  return dashed.replace(/^-+/, '').replace(/-+$/, '') || 'prd'
}

function parseArgs(argv) {
  const out = {
    repoRoot: '.',
    scope: null,
    dir: null,
    title: null,
    updateIndex: false,
    indexFile: null,
    json: false,
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) die(`Missing value for ${a}`)
      return argv[++i]
    }

    if (a === '--repo-root') out.repoRoot = next()
    else if (a === '--scope') out.scope = next()
    else if (a === '--dir') out.dir = next()
    else if (a === '--title') out.title = next()
    else if (a === '--update-index') out.updateIndex = true
    else if (a === '--index-file') out.indexFile = next()
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'Usage: node new-prd.js --scope <scope> --title "Phase 1 MVP" [options]',
          '',
          'Creates <root>/plans/<scope>/prds/<slug>-prd.md from the PRD template.',
          '',
          'Options:',
          '  --repo-root <path>   Repo root (default: .)',
          '  --scope <name>       Scope / epic / branch dir under plans/ (required)',
          '  --dir <path>         Override the prds dir (default: plans/<scope>/prds)',
          '  --title <text>       PRD title (required)',
          '  --update-index       Add a plain link under "## PRDs" in plans/<scope>/README.md',
          '                       (optional status-free map; creates it from prd-readme.md if absent)',
          '  --index-file <path>  Override the index file (relative to repo root unless absolute)',
          '  --json               Output machine-readable JSON (default: off)',
          '',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      die(`Unknown arg: ${a}`)
    }
  }

  if (!out.scope) die('Missing required --scope')
  if (!out.title) die('Missing required --title')
  return out
}

function loadTemplate() {
  const templatePath = path.resolve(__dirname, '..', 'assets', 'templates', 'prd-template.md')
  if (!fs.existsSync(templatePath)) die(`Template not found: ${templatePath}`)
  return fs.readFileSync(templatePath, 'utf8')
}

function loadReadmeTemplate() {
  const templatePath = path.resolve(__dirname, '..', 'assets', 'templates', 'prd-readme.md')
  if (!fs.existsSync(templatePath)) die(`README template not found: ${templatePath}`)
  return fs.readFileSync(templatePath, 'utf8')
}

function updateIndex(indexFile, { relLink, title, scope }) {
  // The index is an optional, status-free map — born here from prd-readme.md on first use.
  const content = fs.existsSync(indexFile)
    ? fs.readFileSync(indexFile, 'utf8')
    : loadReadmeTemplate().replaceAll('{{SCOPE}}', scope)
  if (content.includes(relLink)) return false

  const entryLine = `- [${title}](${relLink})`
  const normalized = content.replace(/\r\n/g, '\n')
  const hadTrailingNewline = normalized.endsWith('\n')
  let lines = normalized.split('\n')
  if (hadTrailingNewline && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1)
  }

  const headingIdx = lines.findIndex(l => /^##\s+PRDs\s*$/i.test(l))
  if (headingIdx !== -1) {
    let insertAt = headingIdx + 1
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++
    let lastItem = insertAt - 1
    for (let i = insertAt; i < lines.length && !/^##\s+/.test(lines[i]); i++) {
      if (/^[-*]\s+/.test(lines[i])) lastItem = i
    }
    lines.splice(lastItem + 1, 0, entryLine)
  } else {
    lines.push('', '## PRDs', entryLine)
  }

  let next = lines.join('\n')
  if (hadTrailingNewline) next += '\n'
  fs.mkdirSync(path.dirname(indexFile), { recursive: true })
  fs.writeFileSync(indexFile, next, 'utf8')
  return true
}

function main() {
  const args = parseArgs(process.argv)

  const repoRoot = path.resolve(process.cwd(), args.repoRoot)
  if (!fs.existsSync(repoRoot)) die(`Repo root does not exist: ${repoRoot}`)

  const prdsDir = args.dir
    ? path.resolve(repoRoot, args.dir)
    : path.join(repoRoot, 'plans', args.scope, 'prds')
  fs.mkdirSync(prdsDir, { recursive: true })

  const slug = slugify(args.title).replace(/-prd$/, '') // avoid "...-prd-prd.md"
  let out = path.join(prdsDir, `${slug}-prd.md`)
  let i = 2
  while (fs.existsSync(out)) {
    out = path.join(prdsDir, `${slug}-${i}-prd.md`)
    i++
  }

  const rendered = loadTemplate()
    .replaceAll('{{TITLE}}', String(args.title).trim())
    .replaceAll('{{SCOPE}}', String(args.scope).trim())
  fs.writeFileSync(out, `${rendered.trimEnd()}\n`, 'utf8')

  let indexFile = null
  let indexChanged = false
  if (args.updateIndex) {
    indexFile = args.indexFile
      ? path.isAbsolute(args.indexFile)
        ? args.indexFile
        : path.resolve(repoRoot, args.indexFile)
      : path.join(repoRoot, 'plans', args.scope, 'README.md')
    const relLink = toPosix(path.relative(path.dirname(indexFile), out))
    indexChanged = updateIndex(indexFile, {
      relLink,
      title: String(args.title).trim(),
      scope: String(args.scope).trim(),
    })
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        repoRoot,
        scope: args.scope,
        prdsDir,
        createdPrdPath: out,
        createdPrdRelPath: toPosix(path.relative(repoRoot, out)),
        title: String(args.title).trim(),
        indexUpdated: Boolean(indexFile),
        indexChanged,
        indexPath: indexFile,
      })}\n`,
    )
  } else {
    process.stdout.write(`${out}\n`)
  }
}

main()
