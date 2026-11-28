import fs from 'node:fs'
import { codexRoot } from '../agent-memory/repo.mjs'
import { openJournal, sha256 } from '../tools/mem-journal-write.mjs'
import { startCaseSync } from '../dsh-memory/lib/memory-case-index.mjs'

function capture() {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'))
  const { hook_event_name: hook, session_id: sid, turn_id: turnID, cwd: ws } = event
  const who = hook === 'UserPromptSubmit' ? 'user' : hook === 'Stop' ? 'assistant' : null
  const text = who === 'user' ? event.prompt : event.last_assistant_message
  if (who && typeof sid === 'string' && sid && typeof turnID === 'string' && turnID
      && typeof text === 'string' && text.trim()) {
    const eventKey = sha256(JSON.stringify([hook, sid, turnID, text]))
    const root = codexRoot()
    openJournal(root).append('stream.jsonl', {
      who, type: `${who}/message`, sid, turnID, ws, text,
      source: { type: 'codex.hook', hook },
    }, { dedupeKey: eventKey })
    if (hook === 'Stop') startCaseSync('codex', root)
  }
  return {}
}

let output
try {
  output = capture()
} catch (error) {
  console.error(`codex-memory: ${error.message}`)
  output = { systemMessage: 'Codex memory could not save this event. See the hook error.' }
}
process.stdout.write(JSON.stringify(output))
