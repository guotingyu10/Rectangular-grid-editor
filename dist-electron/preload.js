import { contextBridge } from "electron";
//#region electron/preload.ts
contextBridge.exposeInMainWorld("electron", { platform: process.platform });
//#endregion
