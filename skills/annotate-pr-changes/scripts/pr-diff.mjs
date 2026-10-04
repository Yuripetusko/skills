// Shared helpers for the annotate-pr-changes scripts: load a PR's unified diff and parse it into
// files and hunks with the line numbers GitHub review comments anchor to.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function startFile(files, oldPath, newPath) {
  const file = {
    path: newPath,
    oldPath,
    status: oldPath === newPath ? 'modified' : 'renamed',
    additions: 0,
    deletions: 0,
    hunks: [],
    lines: [],
  }
  files.set(newPath, file)
  return file
}

export function runGh(args, repo) {
  const repoArgs = repo ? ['--repo', repo] : []
  return execFileSync('gh', [...args, ...repoArgs], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
}

export function loadPullRequestDiff({ pullRequestNumber, repo, diffFile }) {
  if (diffFile) {
    return readFileSync(diffFile, 'utf8')
  }
  return runGh(['pr', 'diff', pullRequestNumber], repo)
}

// Returns a Map of path -> file. Each hunk keeps, per side, the line numbers a review comment can
// anchor to (`left` for old-file lines, `right` for new-file lines) mapped to the diff line.
export function parsePullRequestDiff(diffText) {
  const files = new Map()
  let currentFile = null
  let currentHunk = null
  let oldLine = 0
  let newLine = 0

  for (const line of diffText.split('\n')) {
    const fileHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (fileHeader) {
      currentFile = startFile(files, fileHeader[1], fileHeader[2])
      currentFile.lines.push(line)
      currentHunk = null
      continue
    }
    if (!currentFile) {
      continue
    }
    currentFile.lines.push(line)
    if (!currentHunk && line === '--- /dev/null') {
      currentFile.status = 'added'
      continue
    }
    if (!currentHunk && line === '+++ /dev/null') {
      currentFile.status = 'deleted'
      continue
    }
    if (!currentHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      continue
    }
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1])
      newLine = Number(hunkHeader[3])
      currentHunk = {
        newStart: newLine,
        newCount: Number(hunkHeader[4] ?? 1),
        oldStart: oldLine,
        left: new Map(),
        right: new Map(),
      }
      currentFile.hunks.push(currentHunk)
      continue
    }
    if (!currentHunk) {
      continue
    }
    if (line.startsWith('+')) {
      currentHunk.right.set(newLine++, line)
      currentFile.additions++
    } else if (line.startsWith('-')) {
      currentHunk.left.set(oldLine++, line)
      currentFile.deletions++
    } else if (line.startsWith(' ')) {
      currentHunk.left.set(oldLine++, line)
      currentHunk.right.set(newLine++, line)
    }
  }
  return files
}
