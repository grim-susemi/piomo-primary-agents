// The package's only SDK import. The extension loader aliases
// @earendil-works/pi-coding-agent (SENPI/dist/core/extensions/loader.js:71,129;
// export at SENPI/dist/index.js:55). Unit-tested modules never import this file.
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { createPrimaryAgentEditor } from '../ui/editor.mjs';

export const EditorBase = CustomEditor;
export const PrimaryAgentEditor = createPrimaryAgentEditor(CustomEditor);
