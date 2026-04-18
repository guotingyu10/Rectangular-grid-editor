import { BrowserWindow, app } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
//#region electron/main.ts
process.env.VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
var __dirname = dirname(fileURLToPath(import.meta.url));
var mainWindow = null;
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			nodeIntegration: false,
			contextIsolation: true
		}
	});
	if (process.env.VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
		mainWindow.webContents.openDevTools();
	} else mainWindow.loadFile(join(__dirname, "../dist/index.html"));
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
//#endregion
