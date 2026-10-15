'use strict';

// A sandboxed renderer gets one fixed operation. It never receives filesystem,
// process, general IPC, account tokens, or a user-supplied command capability.
const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find(value => value.startsWith('--qqbridge-version='));
const version = argument?.slice('--qqbridge-version='.length) || '';

contextBridge.exposeInMainWorld('qqBridgeDesktop', Object.freeze({
  isDesktop: true,
  version,
  exportConfig: accountId => ipcRenderer.invoke('qqbridge:export-config', accountId),
}));
