export type Finding = { severity: 'high' | 'medium' | 'low'; file: string; line: number; title: string; explanation: string; reproduction: string }
export type CollaborationRecord = {
  id: string; source_session_id: string; source_agent: string; project_path: string; working_directory: string
  title: string; created_at: number; snapshot_id: string; head: string; scope: string; files: string[]; omitted: string[]
  diff: string; packet: string; status: 'draft' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'handoff'
  target_agent: string | null; destination_session_id: string | null; result: { summary: string; findings: Finding[] } | null
  error: string | null; criteria: string; model: string
}
export type HandoffLaunch = { id: string; agent: string; project_path: string; prompt: string }

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
export function findingsPacket(record: CollaborationRecord, selected: number[]): string {
  return `## Independent review findings\nSource review: ${record.id}\nReviewed snapshot: ${record.snapshot_id}\nThese are review suggestions, not verified test results. Reproduce each issue before changing code.\n\n` +
    selected.map((i) => record.result?.findings[i]).filter((f): f is Finding => !!f).map((f) =>
      `### ${f.severity.toUpperCase()}: ${f.title}\n${f.file}:${f.line}\n${f.explanation}\nReproduction / suggested test: ${f.reproduction || 'Not supplied'}\n`,
    ).join('\n')
}
