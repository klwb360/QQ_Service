'use strict';

// A sandboxed renderer gets fixed native-window and export operations. It never
// receives filesystem, process, general IPC, account tokens, or commands.
const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find(value => value.startsWith('--qqbridge-version='));
const version = argument?.slice('--qqbridge-version='.length) || '';

contextBridge.exposeInMainWorld('qqBridgeDesktop', Object.freeze({
  isDesktop: true,
  version,
  exportConfig: accountId => ipcRenderer.invoke('qqbridge:export-config', accountId),
  minimize: () => ipcRenderer.invoke('qqbridge:window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('qqbridge:window-toggle-maximize'),
  close: () => ipcRenderer.invoke('qqbridge:window-close'),
  quit: () => ipcRenderer.invoke('qqbridge:window-quit'),
  getSettings: () => ipcRenderer.invoke('qqbridge:desktop-settings-get'),
  updateSettings: settings => ipcRenderer.invoke('qqbridge:desktop-settings-update', settings),
  chooseNapcatExecutable: () => ipcRenderer.invoke('qqbridge:napcat-choose-executable'),
  choosePluginDirectory: () => ipcRenderer.invoke('qqbridge:plugin-choose-directory'),
  getWindowState: () => ipcRenderer.invoke('qqbridge:window-state'),
  onWindowState: callback => {
    if (typeof callback !== 'function') throw new TypeError('窗口状态回调必须是函数。');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('qqbridge:window-state-changed', listener);
    return () => ipcRenderer.removeListener('qqbridge:window-state-changed', listener);
  },
}));
