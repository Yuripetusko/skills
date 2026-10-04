#!/usr/bin/env node
// Prints a PR diff with base (L) and head (R) line numbers on every line, so reviewers cite
// anchors GitHub accepts instead of counting hunk offsets by hand.
//
// Usage: node numbered-diff.mjs (--diff-file <path> | --pr <number> [--repo owner/name])
//        [--files-only | --hunks] [path-prefix ...]
//
// --files-only lists changed files with +/- counts and a [generated] mark, no hunks.
// --hunks lists each file's hunks as head (R) and base (L) line ranges, no code.
// Path prefixes limit the output to matching files.

import { isGeneratedPath, loadDiffText, parseArguments, parseDiff } from './diff.mjs'

function formatRange(prefix, lineMap) {
  const lineNumbers = [...lineMap.keys()]
  if (lineNumbers.length === 0) {
    return `${prefix}-`.padEnd(13)
  }
  return `${prefix}${Math.min(...lineNumbers)}-${Math.max(...lineNumbers)}`.padEnd(13)
}

// The text after the closing @@ is git's guess at the enclosing function or section.
function hunkContext(header) {
  const context = header.replace(/^@@[^@]*@@\s?/, '').trim()
  return context ? ` ${context}` : ''
}

function main() {
  const { positional: pathPrefixes, parsed } = parseArguments(process.argv.slice(2), {
    flags: ['files-only', 'hunks'],
    options: ['diff-file', 'pr', 'repo'],
  })
  if (!parsed['diff-file'] && !parsed.pr) {
    console.error(
      'Usage: numbered-diff.mjs (--diff-file <path> | --pr <number> [--repo owner/name]) [--files-only | --hunks] [path-prefix ...]',
    )
    process.exit(2)
  }
  const files = parseDiff(
    loadDiffText({ diffFile: parsed['diff-file'], pullRequestNumber: parsed.pr, repo: parsed.repo }),
  )
  const selectedFiles = [...files].filter(
    ([path]) => pathPrefixes.length === 0 || pathPrefixes.some(prefix => path.startsWith(prefix)),
  )

  if (parsed['files-only']) {
    let reviewableChangedLines = 0
    for (const [path, file] of selectedFiles) {
      const generated = isGeneratedPath(path)
      if (!generated) {
        reviewableChangedLines += file.additions + file.deletions
      }
      console.log(`+${file.additions} -${file.deletions}\t${path}${generated ? '\t[generated]' : ''}`)
    }
    console.log(
      `\n${selectedFiles.length} files, ${reviewableChangedLines} changed lines outside generated files`,
    )
    return
  }

  if (parsed.hunks) {
    for (const [path, file] of selectedFiles) {
      const generatedMark = isGeneratedPath(path) ? ' [generated]' : ''
      console.log(`${path} (+${file.additions} -${file.deletions})${generatedMark}`)
      for (const hunk of file.hunks) {
        console.log(`  ${formatRange('R', hunk.right)} ${formatRange('L', hunk.left)}${hunkContext(hunk.header)}`)
      }
    }
    return
  }

  for (const [path, file] of selectedFiles) {
    const generatedMark = isGeneratedPath(path) ? ' [generated]' : ''
    console.log(`\n### ${path} (+${file.additions} -${file.deletions})${generatedMark}`)
    for (const hunk of file.hunks) {
      console.log(hunk.header)
      for (const line of hunk.lines) {
        const left = line.left === null ? '' : `L${line.left}`
        const right = line.right === null ? '' : `R${line.right}`
        console.log(`${left.padStart(6)} ${right.padStart(6)} |${line.text}`)
      }
    }
  }
}

main()
