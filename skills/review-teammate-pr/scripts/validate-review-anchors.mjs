#!/usr/bin/env node
// Validates a pull request review payload before it is posted. GitHub rejects the whole review
// with a 422 when a single comment anchors outside the diff, so every anchor is checked here.
//
// Usage: node validate-review-anchors.mjs <payload.json> --pr <number> --diff-file <path>
//        [--repo owner/name]
//
// --diff-file must be the diff the review was written against (the one saved at setup), so line
// numbers are checked against the reviewed commit even if the author pushed in the meantime.

import { readFileSync } from 'node:fs'
import { parseArguments, parseDiff, runGh } from './diff.mjs'

const COMMENT_PREFIX =
  /^🤖 Agent: \*\*Code review (Code correctness|Code quality|Semantic Intent|Code complexity)\*\*:\n/

function sideKey(side) {
  return side === 'LEFT' ? 'left' : 'right'
}

function validateComment(comment, files) {
  const problems = []
  if (!COMMENT_PREFIX.test(comment.body ?? '')) {
    problems.push(
      'body must start with "🤖 Agent: **Code review <label>**:" and a newline, label one of Code correctness | Code quality | Semantic Intent | Code complexity',
    )
  }
  if (comment.body?.includes('\\n')) {
    problems.push('body contains a literal "\\n" - use a real newline')
  }
  const file = files.get(comment.path)
  if (!file) {
    problems.push(`path "${comment.path}" is not in the PR diff`)
    return { problems, anchoredLine: null }
  }
  const side = sideKey(comment.side ?? 'RIGHT')
  const hunk = file.hunks.find(candidate => candidate[side].has(comment.line))
  if (!hunk) {
    problems.push(`line ${comment.line} (${comment.side ?? 'RIGHT'}) is outside every diff hunk`)
    return { problems, anchoredLine: null }
  }
  if (comment.start_line !== undefined) {
    const startSide = sideKey(comment.start_side ?? comment.side ?? 'RIGHT')
    if (!hunk[startSide].has(comment.start_line)) {
      problems.push(`start_line ${comment.start_line} is not in the same hunk as line ${comment.line}`)
    }
    if (startSide === side && comment.start_line >= comment.line) {
      problems.push('start_line must be lower than line')
    }
  }
  return { problems, anchoredLine: hunk[side].get(comment.line) }
}

function main() {
  const { positional, parsed } = parseArguments(process.argv.slice(2), {
    options: ['pr', 'repo', 'diff-file'],
  })
  const [payloadPath] = positional
  if (!payloadPath || !parsed.pr || !parsed['diff-file']) {
    console.error(
      'Usage: validate-review-anchors.mjs <payload.json> --pr <number> --diff-file <path> [--repo owner/name]',
    )
    process.exit(2)
  }
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
  const pullRequest = JSON.parse(runGh(['pr', 'view', parsed.pr, '--json', 'headRefOid,url'], parsed.repo))
  const files = parseDiff(readFileSync(parsed['diff-file'], 'utf8'))

  const payloadProblems = []
  if (payload.event !== 'COMMENT') {
    payloadProblems.push(
      'event must be "COMMENT" - never APPROVE or REQUEST_CHANGES on the user\'s behalf, and without an event the review stays pending and invisible',
    )
  }
  if (!payload.body?.trim()) {
    payloadProblems.push('body is empty - the reviews API requires a body for a COMMENT review')
  }
  if (!Array.isArray(payload.comments) || payload.comments.length === 0) {
    console.log('NOTHING TO POST - no inline comments. Skip the review and post only the summary comment.')
    process.exit(0)
  }

  let failed = payloadProblems.length > 0
  for (const problem of payloadProblems) {
    console.log(`PAYLOAD: ${problem}`)
  }
  if (payload.commit_id !== pullRequest.headRefOid) {
    console.log(
      `WARNING: commit_id ${payload.commit_id} is not the current PR head ${pullRequest.headRefOid}. The author pushed during the review; comments anchor to the reviewed commit and may show as outdated. Mention it in the summary.`,
    )
  }

  const seenAnchors = new Set()
  console.log(`\nPreview for ${pullRequest.url}\n`)
  for (const [index, comment] of payload.comments.entries()) {
    const { problems, anchoredLine } = validateComment(comment, files)
    const anchorKey = `${comment.path}:${comment.side ?? 'RIGHT'}:${comment.line}`
    if (seenAnchors.has(anchorKey)) {
      problems.push('another comment anchors on the same line - merge them')
    }
    seenAnchors.add(anchorKey)
    const range = comment.start_line !== undefined ? `${comment.start_line}-${comment.line}` : `${comment.line}`
    console.log(`#${index + 1} ${comment.path}:${range} (${comment.side ?? 'RIGHT'})`)
    if (anchoredLine !== null && anchoredLine !== undefined) {
      console.log(`   anchored on: ${anchoredLine.slice(0, 120)}`)
    }
    for (const bodyLine of (comment.body ?? '').split('\n')) {
      console.log(`   | ${bodyLine}`)
    }
    for (const problem of problems) {
      console.log(`   PROBLEM: ${problem}`)
    }
    failed ||= problems.length > 0
    console.log('')
  }

  console.log(failed ? 'INVALID - fix the problems above before posting.' : 'VALID - ready to post.')
  process.exit(failed ? 1 : 0)
}

main()
