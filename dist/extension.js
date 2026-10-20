import { EditorBase } from "./src/host/editor-host.mjs";
import { createPrimaryAgentsExtension } from "./src/index.mjs";

export default createPrimaryAgentsExtension({ EditorBase });
