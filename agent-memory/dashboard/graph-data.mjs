export const sources = {
  opencode: { label: 'OpenCode', color: '#72e9cb' },
  dsh: { label: 'DSH', color: '#a68bff' },
  workbuddy: { label: 'WorkBuddy', color: '#ffb574', angle: -.33 },
  zcode: { label: 'ZCode', color: '#f484bf' },
  codex: { label: 'Codex', color: '#83baff', angle: .63 },
}

export function randomFrom(text) {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619)
  return () => {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0
    return hash / 4294967296
  }
}

export const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export function starEmphasis(ref, position, { selected, center, ranks, neighbors }) {
  if (ref === selected) return 2.4
  const rank = ranks.get(ref)
  if (rank !== undefined) {
    const proximity = center ? Math.exp(-pointDistance(position, center) / 95) : 1
    return (0.36 + 0.94 * proximity) * (0.62 + 0.38 / (1 + rank / 5))
  }
  if (neighbors.has(ref)) return .74
  return center || ranks.size ? .14 : 1
}

export function canAutoRotate({ enabled, hasRecords, selected, hovered, busy, hidden }) {
  return enabled && hasRecords && !selected && !hovered && !busy && !hidden
}
