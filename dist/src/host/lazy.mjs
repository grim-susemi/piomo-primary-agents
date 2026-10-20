// Lazy host loader. This module itself imports no SDK (unit tests import the
// orchestration module); only `loadEditorHost()` pulls the one SDK import in
// the package, and only when a TUI main session installs the editor.
export function loadEditorHost() {
  return import('./editor-host.mjs');
}
