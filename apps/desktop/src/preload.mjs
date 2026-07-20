// Sandboxed Electron preload scripts run as plain JavaScript even with a .mjs
// suffix. Electron provides this restricted require for renderer-safe modules.
const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  list: "tsugite:agents:list",
  start: "tsugite:agents:start",
  write: "tsugite:agents:write",
  resize: "tsugite:agents:resize",
  stop: "tsugite:agents:stop",
  data: "tsugite:agents:data",
  exit: "tsugite:agents:exit"
});

function subscribe(channel, listener) {
  if (typeof listener !== "function") throw new TypeError("Agent terminal listener must be a function");
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const agents = Object.freeze({
  list: () => ipcRenderer.invoke(channels.list),
  start: (input) => ipcRenderer.invoke(channels.start, input),
  write: (input) => ipcRenderer.invoke(channels.write, input),
  resize: (input) => ipcRenderer.invoke(channels.resize, input),
  stop: (input) => ipcRenderer.invoke(channels.stop, input),
  onData: (listener) => subscribe(channels.data, listener),
  onExit: (listener) => subscribe(channels.exit, listener)
});

contextBridge.exposeInMainWorld("tsugiteDesktop", Object.freeze({ agents }));
