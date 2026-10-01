#!/usr/bin/env bash
# Frontier = tickets takeable now: status ready, or blocked with every listed blocker done.
# A prose (human) prerequisite blocks until the author removes it.
# Output is unordered; MAP.md's "Next up:" cursor decides what's next.
cd "$(dirname "$0")/tickets" || exit 1

# print the frontmatter status, stripped of inline comments
get_status() {
  awk '/^---$/{n++; next} n>=2{exit} n==1 && /^status:/ {
    sub(/^status:[[:space:]]*/, ""); sub(/[[:space:]]*#.*/, ""); print; exit }' "$1" 2>/dev/null
}

# print blockedBy entries from the frontmatter, one per line. Accepts a block list
# (`- a-ticket.md`), a flow list (`[a-ticket.md, b-ticket.md]`) or a single scalar.
get_blockers() {
  awk '/^---$/{n++; next} n>=2{exit}
    n==1 && /^blockedBy:/ {
      v=$0; sub(/^blockedBy:[[:space:]]*/, "", v); sub(/[[:space:]]+#.*/, "", v)
      if (v ~ /^\[/) { gsub(/^\[|\][[:space:]]*$/, "", v); k=split(v, a, ","); for (i=1;i<=k;i++) print a[i]; next }
      if (v != "") { print v; next }
      f=1; next }
    f && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]*/, ""); print; next }
    f && !/^[[:space:]]/ { f=0 }' "$1" 2>/dev/null
}

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

for f in *-ticket.md; do
  [ -e "$f" ] || continue
  status=$(get_status "$f")
  case "$status" in ready | blocked) ;; *) continue ;; esac
  unblocked=1
  count=0
  while IFS= read -r blocker; do
    b=$(trim "$blocker")
    [ -n "$b" ] || continue
    count=$((count + 1))
    b="${b%\"}" b="${b#\"}" b="${b%\'}" b="${b#\'}"
    case "$b" in
      *-ticket.md) b="${b##*/}" # sibling: accept a bare filename or any path to it
        [ "$(get_status "$b")" = done ] || unblocked=0 ;;
      *) unblocked=0 ;; # human prerequisite
    esac
  done < <(get_blockers "$f")
  if [ "$status" = blocked ] && [ "$count" = 0 ]; then
    echo "warning: ${f} is blocked with no blockedBy; add the blocker or set it ready" >&2
    continue
  fi
  [ "$unblocked" = 1 ] && printf '%-50s %s\n' "${f%.md}" "$status"
done
exit 0
