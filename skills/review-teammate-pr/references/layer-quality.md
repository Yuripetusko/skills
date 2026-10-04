# Layer: Code quality

Comment label: `Code quality`.

The question: does the code follow this repo's documented conventions, and does it introduce
structural problems a reviewer should push back on?

## The rules come from the repo

Read every convention file the brief lists (root and nested `AGENTS.md`/`CLAUDE.md`, plus the
topic docs it names) in full: they are the standard you review against. Each finding cites its
rule: file plus a short quote ("AGENTS.md: 'Prefer function declaration over arrow functions at
top level'"). A documented rule that breaks is a hard finding.

Skip anything the repo's tooling already enforces (linter, formatter, type-checker, a custom lint
rule): CI catches those, and a human comment on them is noise. When unsure whether a rule is
enforced, check the lint config.

## Structural checks

These hold even where the repo documents nothing:

- **Reuse.** A new helper, type or component that duplicates an existing one. Find the existing
  one with `git grep` and name it.
- **Placement.** Feature-specific logic added to a shared or general-purpose module; logic in the
  wrong layer (UI deciding business rules, a storage function formatting for display).
- **Dead code.** Unused exports, parameters or branches the change introduces or leaves behind;
  leftover debug output; commented-out code; backwards-compat shims for callers that no longer
  exist.
- **Bolted-on conditionals.** A new `if` threaded through an unrelated flow, or the same switch on
  the same type repeated in several places: propose the helper, map or type that removes them.
- **File growth.** A change that pushes a file well past ~1000 lines without splitting.

## Smell baseline

Fowler's code smells, as labelled judgement calls: write "possible Feature Envy", never a hard
violation. A documented repo rule overrides the baseline: where the repo endorses something a smell
would flag, don't flag it.

- **Duplicated Code:** the same logic shape in more than one hunk or file. Extract it.
- **Feature Envy:** a function that works on another module's data more than its own. Move it.
- **Data Clumps:** the same few fields or parameters travelling together. Give them one type.
- **Primitive Obsession:** a string or number standing in for a domain concept. Give it a type
  (an enum, a branded type).
- **Shotgun Surgery:** one logical change forces scattered edits across many files. Gather what
  changes together.
- **Speculative Generality:** parameters, options or abstractions for needs nobody has yet. Inline
  them.
- **Middle Man:** a function or class that only delegates onward. Call the target directly.
- **Message Chains:** long `a.b().c().d()` walks the caller shouldn't depend on. Hide the walk
  behind one call.

## Leave to other layers

Bugs (correctness), ticket fit (intent), whether names and structure are understandable or a
"why" comment is missing (complexity). A naming rule the repo documents is yours; a name that's
merely unclear belongs to complexity.
