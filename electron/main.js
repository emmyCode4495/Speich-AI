const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const Store = require("electron-store");

const store = new Store({
  defaults: {
    apiBaseUrl: process.env.SPEICH_API_URL || "http://localhost:3850"
  }
});

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: "#0b0f14",
    title: "Speich AI",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("mailto:")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("get-settings", () => store.store);
ipcMain.handle("set-setting", (_e, key, value) => {
  store.set(key, value);
  return true;
});
ipcMain.handle("get-api-base", () => store.get("apiBaseUrl"));
