import { parentPort, workerData } from 'node:worker_threads';

// This worker isolates crashes and gives the host a cancellable execution unit.
// Imported plugins are trusted local Node.js code, not sandboxed web scripts.
// For callTool the host already checked the declared name and input schema;
// Plugins receive name/arguments, their own settings/declared secrets and host
// context. Application/other-plugin credentials are never added by this worker.
try {
  const module = await import(workerData.entry);
  const handler = module[workerData.handler];
  if (typeof handler !== 'function') throw new Error(`入口未导出 ${workerData.handler} 函数。`);
  const result = await handler(workerData.payload);
  parentPort.postMessage({ type: 'result', value: result ?? null });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: String(error?.message || error).slice(0, 1000) });
}
