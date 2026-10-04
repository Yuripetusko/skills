#!/usr/bin/env node
// Saves a PR's diff once, split per file, and prints a one-line-per-file map (size, status,
// new-side hunk ranges, generated files, lines that came from another PR) so subagents can each
// read only their slice instead of the full diff.
//
// Usage: node split-pr-diff.mjs <pr-number> <out-dir> [--repo owner/name] [--diff-file path]
//        [--reviewed-in <other-pr-number>]...

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadPullRequestDiff, parsePullRequestDiff } from './pr-diff.mjs'

const GENERATED_PATH = /(drizzle\/meta\/|pnpm-lock\.yaml$|package-lock\.json$|__snapshots__\/|\.snap$|\.generated\.)/

function parseArguments(argv) {
  const positional = []
  const options = { reviewedIn: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--repo') {
      options.repo = argv[++index]
    } else if (argument === '--diff-file') {
      options.diffFile = argv[++index]
    } else if (argument === '--reviewed-in') {
      options.reviewedIn.push(argv[++index])
    } else {
      positional.push(argument)
    }
  }
  const [pullRequestNumber, outDir] = positional
  if (!pullRequestNumber || !outDir) {
    console.error(
      'Usage: split-pr-diff.mjs <pr-number> <out-dir> [--repo owner/name] [--diff-file path] [--reviewed-in <pr>]...',
    )
    process.exit(2)
  }
  return { pullRequestNumber: pullRequestNumber.replace(/^#/, ''), outDir, ...options }
}

function addedContentByPath(files) {
  const result = new Map()
  for (const file of files.values()) {
    const contents = new Set()
    for (const hunk of file.hunks) {
      for (const line of hunk.right.values()) {
        if (line.startsWith('+')) {
          contents.add(line.slice(1).trim())
        }
      }
    }
    result.set(file.path, contents)
  }
  return result
}

function isMeaningfulLine(content) {
  return content.length > 8
}

function describeHunks(file) {
  return file.hunks
    .map(hunk => {
      if (hunk.newCount === 0) {
        return `deleted@L${hunk.oldStart}`
      }
      return `${hunk.newStart}-${hunk.newStart + hunk.newCount - 1}`
    })
    .join(', ')
}

function describeReviewedIn(file, reviewedInContents) {
  const notes = []
  const ownAdded = [...file.hunks.flatMap(hunk => [...hunk.right.values()])]
    .filter(line => line.startsWith('+'))
    .map(line => line.slice(1).trim())
    .filter(isMeaningfulLine)
  if (ownAdded.length === 0) {
    return notes
  }
  for (const [otherPullRequestNumber, contentsByPath] of reviewedInContents) {
    const otherContents = contentsByPath.get(file.path)
    if (!otherContents) {
      continue
    }
    const shared = ownAdded.filter(content => otherContents.has(content)).length
    // A few shared lines are usually coincidence (imports, common calls), not inherited code.
    if (shared >= Math.max(3, ownAdded.length * 0.2)) {
      notes.push(`from #${otherPullRequestNumber}: ${shared}/${ownAdded.length} added lines`)
    }
  }
  return notes
}

function main() {
  const { pullRequestNumber, outDir, repo, diffFile, reviewedIn } = parseArguments(
    process.argv.slice(2),
  )
  const diffText = loadPullRequestDiff({ pullRequestNumber, repo, diffFile })
  const files = parsePullRequestDiff(diffText)

  const reviewedInContents = new Map(
    reviewedIn.map(otherPullRequestNumber => [
      otherPullRequestNumber.replace(/^#/, ''),
      addedContentByPath(
        parsePullRequestDiff(
          loadPullRequestDiff({ pullRequestNumber: otherPullRequestNumber, repo }),
        ),
      ),
    ]),
  )

  mkdirSync(join(outDir, 'files'), { recursive: true })
  writeFileSync(join(outDir, 'pr.diff'), diffText)

  const rows = []
  let index = 0
  for (const file of files.values()) {
    index++
    const fileDiffPath = join(outDir, 'files', `${String(index).padStart(3, '0')}.diff`)
    writeFileSync(fileDiffPath, `${file.lines.join('\n')}\n`)
    const notes = [
      ...(GENERATED_PATH.test(file.path) ? ['generated'] : []),
      ...(file.status === 'renamed' ? [`renamed from ${file.oldPath}`] : []),
      ...describeReviewedIn(file, reviewedInContents),
    ]
    rows.push({
      index,
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      hunks: describeHunks(file),
      notes,
      diffPath: fileDiffPath,
    })
  }
  writeFileSync(join(outDir, 'map.json'), `${JSON.stringify(rows, null, 2)}\n`)

  const totalAdditions = rows.reduce((sum, row) => sum + row.additions, 0)
  const totalDeletions = rows.reduce((sum, row) => sum + row.deletions, 0)
  console.log(
    `PR #${pullRequestNumber}: ${rows.length} files, +${totalAdditions}/-${totalDeletions}. Full diff: ${join(outDir, 'pr.diff')}`,
  )
  console.log(`Per-file diffs: ${join(outDir, 'files', '<#>.diff')} (map.json has the same table)\n`)
  for (const row of rows) {
    const notes = row.notes.length > 0 ? ` | ${row.notes.join('; ')}` : ''
    console.log(
      `${String(row.index).padStart(3, '0')} +${row.additions}/-${row.deletions} ${row.status} ${row.path} | hunks ${row.hunks}${notes}`,
    )
  }
}

main()
