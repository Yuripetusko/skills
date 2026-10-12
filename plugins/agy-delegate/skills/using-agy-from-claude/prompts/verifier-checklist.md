# Verifier checklist

Check the change against each item. Report a problem only on a line the change added or removed,
plus the old code a removal or rename left behind. Lint and type-check already ran on this change
and passed, so skip anything they report. A fix you propose must keep what the code does at
runtime (item 3).

1. **`SAFETY:` comments are true.** Every added or edited `SAFETY:` comment must name what proves
   the cast below it: a check that runs before the cast, or a property that the function producing
   the value guarantees ("`normalize` only rewrites strings, so the input's shape stays"). Follow the
   value back and verify what the comment names. For a property, read that function's every path.
   It is a finding when the check runs after the cast or proves something else, when a path breaks
   the property, or when the comment names neither ("always a string here").
2. **No stale `SAFETY:` comments.** A `SAFETY:` comment needs a cast (`as X` or a non-null `!`)
   within the next 3 lines. One left behind after its cast went away is a finding.
3. **No behaviour change to satisfy a type.** A change made for a type or lint rule must keep what
   the code does at runtime. Look for:
   - `String()`, `Number()`, `Boolean()`, template literals, `?? ''`, `|| 0` or `!!` added on a value
     that flows on, which turns `null`, `undefined` or an object into a different value
   - `Reflect.get(target, prop, receiver)` rewritten as `target[prop]`, which drops the receiver
   - one type guard swapped for a different one, or a guard with a weaker check
   - a throw, guard or early return added so a value fits a type, even for a case "that can't happen"
   - changed defaults, removed `await`, or a changed condition
4. **No cast laundering or suppressions.** `as unknown as X` rewritten as `Partial<X>`,
   `Record<string, unknown>` or an intermediate variable followed by one `as X` is still an unchecked
   cast. So is a new `as X` on a value typed `unknown` or `any` with no check before it and no true
   `SAFETY:` comment (item 1). An added `@ts-expect-error`, `@ts-ignore` or lint disable comment
   counts like an unchecked cast.
5. **No copied helpers.** The same function added to two or more files is a finding. So is a new
   helper when the repo already has one that does the same job: search for its name and for similar
   names. The fix is to extract it once or import the existing one.
6. **Explicit `unknown` return types stay.** A removed `: unknown` or `: Promise<unknown>` return
   annotation lets `any` reach the callers. Look for removed lines such as `-): unknown {`.
7. **Tests are not weakened.** Look for skipped tests (`.skip`, `xit`, `xdescribe`), deleted or
   emptied tests, removed or looser assertions (for example `toEqual` turned into `toBeDefined`),
   removed `expect` calls, changed fixtures that make an assertion pass trivially, and dropped
   initializers that change what a test checks.
8. **No count or status claims in docs.** Added text in docs, comments or changelogs that states
   counts or results ("56 of 56 fixed", "zero behaviour changes", "lint passes") is a finding unless
   the diff itself shows it. Any edit to a ticket file, `MAP.md` or `SPEC.md` is a finding.
9. **Repo conventions.** Read every `AGENTS.md` that `rules.json` lists. A changed line that breaks a
   rule written there is a finding. Quote the rule in `why`.

Not part of this check: naming, design, missing features, performance, and style that no listed
`AGENTS.md` asks for. The calling agent reviews those.
