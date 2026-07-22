// Sandboxed Electron preload scripts run as plain JavaScript even with a .mjs
// suffix. Electron provides this restricted require for renderer-safe modules.
const { contextBridge, ipcRenderer } = require("electron");

const agentChannels = Object.freeze({
  list: "tsugite:agents:list",
  start: "tsugite:agents:start",
  write: "tsugite:agents:write",
  resize: "tsugite:agents:resize",
  stop: "tsugite:agents:stop",
  data: "tsugite:agents:data",
  exit: "tsugite:agents:exit"
});

const workspaceChannels = Object.freeze({
  current: "tsugite:workspace:current",
  select: "tsugite:workspace:select"
});

function subscribe(channel, listener) {
  if (typeof listener !== "function") throw new TypeError("Agent terminal listener must be a function");
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const agents = Object.freeze({
  list: () => ipcRenderer.invoke(agentChannels.list),
  start: (input) => ipcRenderer.invoke(agentChannels.start, input),
  write: (input) => ipcRenderer.invoke(agentChannels.write, input),
  resize: (input) => ipcRenderer.invoke(agentChannels.resize, input),
  stop: (input) => ipcRenderer.invoke(agentChannels.stop, input),
  onData: (listener) => subscribe(agentChannels.data, listener),
  onExit: (listener) => subscribe(agentChannels.exit, listener)
});

const workspace = Object.freeze({
  current: () => ipcRenderer.invoke(workspaceChannels.current),
  select: () => ipcRenderer.invoke(workspaceChannels.select)
});

contextBridge.exposeInMainWorld("tsugiteDesktop", Object.freeze({ agents, workspace }));
