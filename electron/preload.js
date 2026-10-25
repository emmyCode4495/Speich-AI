const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speich", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  getApiBase: () => ipcRenderer.invoke("get-api-base")
});
