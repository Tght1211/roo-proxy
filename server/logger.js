const fs = require('fs/promises');
const path = require('path');

const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toLogLevelValue(level) {
  const mapping = { debug: 10, info: 20, error: 30 };
  return mapping[level] || mapping.info;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function cleanupOldLogs(logsDir, retainDays) {
  await ensureDir(logsDir);
  const files = await fs.readdir(logsDir).catch(() => []);
  const now = Date.now();
  const maxAge = Math.max(retainDays, 1) * 24 * 60 * 60 * 1000;

  await Promise.all(
    files
      .filter((file) => /^access-\d{4}-\d{2}-\d{2}\.log$/.test(file))
      .map(async (file) => {
        const filePath = path.join(logsDir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) {
          return;
        }

        if (now - stat.mtimeMs > maxAge) {
          await fs.unlink(filePath).catch(() => {});
        }
      }),
  );
}

class Logger {
  constructor(options = {}) {
    this.logsDir = options.logsDir;
    this.level = options.level || 'info';
    this.retainDays = options.retainDays || 7;
    this.lastCleanupAt = 0;
  }

  shouldLog(level) {
    return toLogLevelValue(level) >= toLogLevelValue(this.level);
  }

  async maybeCleanupOldLogs() {
    const now = Date.now();
    if (now - this.lastCleanupAt < LOG_CLEANUP_INTERVAL_MS) {
      return;
    }

    this.lastCleanupAt = now;
    await cleanupOldLogs(this.logsDir, this.retainDays).catch(() => {});
  }

  async writeLine(line) {
    await ensureDir(this.logsDir);
    const filePath = path.join(this.logsDir, `access-${formatDate()}.log`);
    await fs.appendFile(filePath, `${line}\n`, 'utf8');
    await this.maybeCleanupOldLogs();
  }

  async log(level, message, extra = {}) {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      time: new Date().toISOString(),
      level,
      message,
      ...extra,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
    await this.writeLine(line);
  }

  debug(message, extra) {
    return this.log('debug', message, extra);
  }

  info(message, extra) {
    return this.log('info', message, extra);
  }

  error(message, extra) {
    return this.log('error', message, extra);
  }

  async access(entry) {
    const payload = {
      time: new Date().toISOString(),
      type: 'access',
      hostname: entry.hostname || '',
      rule: entry.rule || null,
      upstream: entry.upstream || null,
      durationMs: entry.durationMs ?? null,
      status: entry.status || 'unknown',
      isDirect: Boolean(entry.isDirect),
      error: entry.error || null,
    };
    const line = JSON.stringify(payload);
    console.log(line);
    await this.writeLine(line);
  }
}

async function readRecentLogs(logsDir, limit = 50) {
  await ensureDir(logsDir);
  const files = (await fs.readdir(logsDir).catch(() => []))
    .filter((file) => /^access-\d{4}-\d{2}-\d{2}\.log$/.test(file))
    .sort()
    .reverse();

  const lines = [];
  for (const file of files) {
    if (lines.length >= limit) {
      break;
    }

    const content = await fs.readFile(path.join(logsDir, file), 'utf8').catch(() => '');
    const fileLines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();

    for (const line of fileLines) {
      try {
        lines.push(JSON.parse(line));
      } catch (error) {
        lines.push({ raw: line, parseError: true });
      }

      if (lines.length >= limit) {
        break;
      }
    }
  }

  return lines;
}

module.exports = {
  Logger,
  readRecentLogs,
};

