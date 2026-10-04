#!/usr/bin/env node
// Validates a pull request review payload before it is posted. GitHub rejects the whole review
// with a 422 when a single comment anchors outside the diff, so every anchor is checked here.
//
// Usage: node validate-review-anchors.mjs <pr-number> <payload.json> [--repo owner/name]
//        [--diff-file path]   (a saved unified diff, for PRs too large for `gh pr diff`)
//        [--allow-body]       (only after GitHub rejected a review without a body)

import { readFileSync } from 'node:fs'

import { loadPullRequestDiff, parsePullRequestDiff, runGh } from './pr-diff.mjs'

const ANNOTATION_PREFIX = '🤖 Agent: **Change annotation for the reviewer**\n'

function parseArguments(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--repo' || argument === '--diff-file') {
      options[argument.slice(2)] = argv[++index]
    } else if (argument === '--allow-body') {
      options.allowBody = true
    } else {
      positional.push(argument)
    }
  }
  const [rawPullRequestNumber, payloadPath] = positional
  const pullRequestNumber = rawPullRequestNumber?.replace(/^#/, '')
  if (!pullRequestNumber || !payloadPath) {
    console.error(
      'Usage: validate-review-anchors.mjs <pr-number> <payload.json> [--repo owner/name] [--diff-file path] [--allow-body]',
    )
    process.exit(2)
  }
  return {
    pullRequestNumber,
    payloadPath,
    repo: options.repo,
    diffFile: options['diff-file'],
    allowBody: options.allowBody === true,
  }
}

function sideKey(side) {
  return side === 'LEFT' ? 'left' : 'right'
}

function validateComment(comment, files) {
  const problems = []
  if (!comment.body?.startsWith(ANNOTATION_PREFIX)) {
    problems.push('body must start with the annotation prefix line followed by a newline')
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
    if (startSide !== side) {
      problems.push('start_side must match side - keep a multi-line range on one side of the diff')
    } else if (comment.start_line >= comment.line) {
      problems.push('start_line must be lower than line')
    }
  }
  return { problems, anchoredLine: hunk[side].get(comment.line) }
}

function main() {
  const { pullRequestNumber, payloadPath, repo, diffFile, allowBody } = parseArguments(process.argv.slice(2))
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
  const pullRequest = JSON.parse(
    runGh(['pr', 'view', pullRequestNumber, '--json', 'headRefOid,url'], repo),
  )
  const files = parsePullRequestDiff(loadPullRequestDiff({ pullRequestNumber, repo, diffFile }))

  const payloadProblems = []
  if (payload.body && !allowBody) {
    payloadProblems.push(
      'drop the review body - only the line annotations are posted (--allow-body only after GitHub asked for one)',
    )
  }
  if (payload.event !== 'COMMENT') {
    payloadProblems.push('event must be "COMMENT" - without it the review stays pending and invisible')
  }
  if (payload.commit_id !== pullRequest.headRefOid) {
    payloadProblems.push(
      `commit_id ${payload.commit_id} is not the PR head ${pullRequest.headRefOid} - push first or refresh line numbers`,
    )
  }
  if (!Array.isArray(payload.comments) || payload.comments.length === 0) {
    payloadProblems.push('comments is empty - with nothing to annotate, post nothing')
  }

  let failed = payloadProblems.length > 0
  for (const problem of payloadProblems) {
    console.log(`PAYLOAD: ${problem}`)
  }

  console.log(`\nPreview for ${pullRequest.url}\n`)
  for (const [index, comment] of (payload.comments ?? []).entries()) {
    const { problems, anchoredLine } = validateComment(comment, files)
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
