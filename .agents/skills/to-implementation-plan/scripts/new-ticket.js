#!/usr/bin/env node
/**
 * Create a new ticket markdown file using house conventions and the ticket template.
 *
 * Tickets live at: <root>/specs/<scope>/tickets/<slug>-ticket.md
 * (the scope groups SPEC.md + its tickets/, assets/ and spikes/; see
 * references/ticket-conventions.md)
 *
 * Safe defaults, no external deps. Rendering is token-based ({{TITLE}}, {{SCOPE}}); the template's
 * yaml frontmatter (status/blockedBy) is copied as-is.
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
  return dashed.replace(/^-+/, '').replace(/-+$/, '') || 'ticket'
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
          'Usage: node new-ticket.js --scope <scope> --title "Deposit projection" [options]',
          '',
          'Creates <root>/specs/<scope>/tickets/<slug>-ticket.md from the ticket template.',
          '',
          'Options:',
          '  --repo-root <path>   Repo root (default: .)',
          '  --scope <name>       Implementation plan dir under specs/ (required)',
          '  --dir <path>         Override the tickets dir (default: specs/<scope>/tickets)',
          '  --title <text>       Ticket title (required)',
          '  --update-index       Add a plain link under "## Tickets" in specs/<scope>/MAP.md',
          '                       (the scope map; creates it and frontier.sh on first use)',
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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.scope)) die(`--scope must be kebab-case: ${out.scope}`)
  if (!out.title) die('Missing required --title')
  return out
}

function loadTemplate() {
  const templatePath = path.resolve(__dirname, '..', 'assets', 'templates', 'ticket-template.md')
  if (!fs.existsSync(templatePath)) die(`Template not found: ${templatePath}`)
  return fs.readFileSync(templatePath, 'utf8')
}

function loadMapTemplate() {
  const templatePath = path.resolve(__dirname, '..', 'assets', 'templates', 'map-template.md')
  if (!fs.existsSync(templatePath)) die(`MAP template not found: ${templatePath}`)
  return fs.readFileSync(templatePath, 'utf8')
}

function ensureScopeScripts(indexFile) {
  // Born alongside MAP.md: frontier.sh lists tickets takeable now. The gitignored .dashboard/
  // progress page, fed by the skill's assets/dashboard.js, starts as the fallback page until
  // dashboard-builder replaces it.
  const dir = path.dirname(indexFile)
  const assets = path.resolve(__dirname, '..', 'assets')
  fs.mkdirSync(dir, { recursive: true })
  const frontier = path.join(dir, 'frontier.sh')
  if (!fs.existsSync(frontier)) {
    const source = path.join(assets, 'frontier.sh')
    if (!fs.existsSync(source)) die(`frontier.sh asset not found: ${source}`)
    fs.copyFileSync(source, frontier)
    fs.chmodSync(frontier, 0o755)
  }
  const page = path.join(dir, '.dashboard', 'index.html')
  if (!fs.existsSync(page)) {
    fs.mkdirSync(path.dirname(page), { recursive: true })
    fs.writeFileSync(path.join(dir, '.dashboard', '.gitignore'), '*\n')
    fs.copyFileSync(path.join(assets, 'templates', 'dashboard.html'), page)
  }
}

function updateIndex(indexFile, { relLink, title, scope }) {
  // The index is a status-free map, born here from map-template.md on first use.
  const content = fs.existsSync(indexFile)
    ? fs.readFileSync(indexFile, 'utf8')
    : loadMapTemplate().replaceAll('{{SCOPE}}', scope)
  if (content.includes(relLink)) return false

  const entryLine = `- [${title}](${relLink})`
  const normalized = content.replace(/\r\n/g, '\n')
  const hadTrailingNewline = normalized.endsWith('\n')
  let lines = normalized.split('\n')
  if (hadTrailingNewline && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1)
  }

  const headingIdx = lines.findIndex(l => /^##\s+Tickets\s*$/i.test(l))
  if (headingIdx !== -1) {
    let insertAt = headingIdx + 1
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++
    let lastItem = insertAt - 1
    for (let i = insertAt; i < lines.length && !/^##\s+/.test(lines[i]); i++) {
      if (/^[-*]\s+/.test(lines[i])) lastItem = i
    }
    lines.splice(lastItem + 1, 0, entryLine)
  } else {
    lines.push('', '## Tickets', entryLine)
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

  const ticketsDir = args.dir
    ? path.resolve(repoRoot, args.dir)
    : path.join(repoRoot, 'specs', args.scope, 'tickets')
  fs.mkdirSync(ticketsDir, { recursive: true })

  const slug = slugify(args.title).replace(/-ticket$/, '') // avoid "...-ticket-ticket.md"
  let out = path.join(ticketsDir, `${slug}-ticket.md`)
  let i = 2
  while (fs.existsSync(out)) {
    out = path.join(ticketsDir, `${slug}-${i}-ticket.md`)
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
      : path.join(repoRoot, 'specs', args.scope, 'MAP.md')
    const relLink = toPosix(path.relative(path.dirname(indexFile), out))
    indexChanged = updateIndex(indexFile, {
      relLink,
      title: String(args.title).trim(),
      scope: String(args.scope).trim(),
    })
    ensureScopeScripts(indexFile)
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        repoRoot,
        scope: args.scope,
        ticketsDir,
        createdTicketPath: out,
        createdTicketRelPath: toPosix(path.relative(repoRoot, out)),
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
