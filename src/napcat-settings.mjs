import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateNativeExecutablePath } from './napcat-native.mjs';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Installation preferences belong to the application. QQ identity, endpoints,
// credentials and message permissions continue to belong to each account.
export function createNapcatSettings({ dataDir, accountDirectories = [] }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'napcat-settings.json');
  const validate = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['native', 'docker'].includes(value.mode)
      || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('NapCat 接入设置格式无效，请刷新后重试。');
    return { mode: value.mode, executablePath: validateNativeExecutablePath(value.executablePath), revision: value.revision };
  };
  const write = value => {
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  let current;
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored.schemaVersion !== 1) throw fail('NapCat 接入设置版本不受支持，请保留资料后检查。');
    current = validate(stored);
  } else {
    const directories = [...new Set([dataDir, ...accountDirectories])];
    const installedDocker = directories.some(directory => {
      const record = path.join(directory, 'module-state.json');
      if (!fs.existsSync(record)) return false;
      const module = JSON.parse(fs.readFileSync(record, 'utf8')).modules?.napcat;
      return Boolean(module?.installed || module?.imageDigest);
    });
    current = { mode: installedDocker ? 'docker' : 'native', executablePath: '', revision: 0 };
    write(current);
  }
  return {
    get: () => structuredClone(current),
    update(value) {
      const next = validate(value);
      if (Object.keys(value).some(key => !['mode', 'executablePath', 'revision'].includes(key))) throw fail('NapCat 接入设置包含未知字段。');
      if (next.revision !== current.revision) throw fail('NapCat 全局设置已变化，请刷新后重试。', 409);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw fail('NapCat 设置版本超出范围，请保留资料后检查。', 409);
      next.revision += 1;
      write(next);
      current = next;
      return structuredClone(current);
    },
  };
}
