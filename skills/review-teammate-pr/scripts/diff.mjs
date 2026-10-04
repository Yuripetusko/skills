// Shared unified-diff parsing for the review scripts. A review comment can anchor only to a line
// inside a diff hunk, so every script works from the same per-hunk line maps.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const GENERATED_PATTERNS = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.lock$/,
  /(^|\/)meta\/(_journal|\d+_snapshot)\.json$/,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.generated\./,
  /(^|\/)(__fixtures__|fixtures|__snapshots__)\//,
  /(^|\/)dist\//,
]

export function isGeneratedPath(path) {
  return GENERATED_PATTERNS.some(pattern => pattern.test(path))
}

export function runGh(args, repo) {
  const repoArgs = repo ? ['--repo', repo] : []
  return execFileSync('gh', [...args, ...repoArgs], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
}

export function loadDiffText({ diffFile, pullRequestNumber, repo }) {
  if (diffFile) {
    return readFileSync(diffFile, 'utf8')
  }
  return runGh(['pr', 'diff', String(pullRequestNumber)], repo)
}

function stripDiffPathPrefix(path) {
  if (path === '/dev/null') {
    return null
  }
  return path.replace(/^[ab]\//, '')
}

// Returns Map<path, { additions, deletions, hunks: [{ header, lines, left, right }] }>.
// `lines` keeps display order; `left`/`right` map base/head line numbers to the raw diff line.
export function parseDiff(diffText) {
  const files = new Map()
  let oldPath = null
  let currentFile = null
  let currentHunk = null
  let oldLine = 0
  let newLine = 0

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = null
      currentHunk = null
      oldPath = null
      continue
    }
    if (line.startsWith('--- ') && !currentHunk) {
      oldPath = stripDiffPathPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ') && !currentHunk) {
      const path = stripDiffPathPrefix(line.slice(4)) ?? oldPath
      currentFile = { additions: 0, deletions: 0, hunks: [] }
      files.set(path, currentFile)
      continue
    }
    const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkHeader && currentFile) {
      oldLine = Number(hunkHeader[1])
      newLine = Number(hunkHeader[2])
      currentHunk = { header: line, lines: [], left: new Map(), right: new Map() }
      currentFile.hunks.push(currentHunk)
      continue
    }
    if (!currentHunk) {
      continue
    }
    if (line.startsWith('+')) {
      currentHunk.lines.push({ left: null, right: newLine, text: line })
      currentHunk.right.set(newLine++, line)
      currentFile.additions++
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ left: oldLine, right: null, text: line })
      currentHunk.left.set(oldLine++, line)
      currentFile.deletions++
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ left: oldLine, right: newLine, text: line })
      currentHunk.left.set(oldLine++, line)
      currentHunk.right.set(newLine++, line)
    }
  }
  return files
}

export function parseArguments(argv, { flags = [], options = [] }) {
  const positional = []
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const name = argument.replace(/^--/, '')
    if (argument.startsWith('--') && options.includes(name)) {
      parsed[name] = argv[++index]
    } else if (argument.startsWith('--') && flags.includes(name)) {
      parsed[name] = true
    } else {
      positional.push(argument)
    }
  }
  return { positional, parsed }
}
