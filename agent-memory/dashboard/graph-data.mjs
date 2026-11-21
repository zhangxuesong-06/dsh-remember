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

export function buildGraph(records, relations) {
  const nodes = records.map(record => {
    const [x,y,z] = record.position
    return { id: record.ref, record, x, y, z, fx:x, fy:y, fz:z }
  })
  const positions = new Map(records.map(record => [record.ref, record.position]))
  const links = relations.filter(edge => edge.evidence).map(edge => ({
    ...edge, start: positions.get(edge.source), end: positions.get(edge.target),
  }))
  return { nodes, links }
}
