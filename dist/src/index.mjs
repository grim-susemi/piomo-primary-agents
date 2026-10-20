import { createOrchestrator } from './core/orchestration.mjs';

// Every handler is registered here, at factory time. Handlers stay inert until
// the interactive TUI main session starts (`session_start` -> isPrimaryMain).
export default function primaryAgentsExtension(pi) {
  createOrchestrator(pi);
}
