// Кольцевой буфер логов + перехват console.*.
// Нужен, чтобы веб-морда могла показывать логи сервера живьём (через WS)
// и по запросу (REST /api/logs), не читая docker logs.
import { EventEmitter } from 'node:events';

const MAX_LINES = 500; // держим в памяти последние строк — хватит для морды

export const logBus = new EventEmitter();

const lines = [];

function push(text) {
  const line = String(text);
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  logBus.emit('line', line);
}

// Перехватываем console.* ВСЕХ модулей (discovery, registry, relay, server),
// чтобы ничего не упустить. Оригинальные методы оставляем для вывода в stdout.
function wrapConsole(level) {
  const orig = console[level];
  console[level] = (...args) => {
    const text = args.map(fmt).join(' ');
    push(`[${level}] ${text}`);
    orig(...args);
  };
}

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function initLogBuffer() {
  // порядок важен: каждый раз возвращаем новую строку, не делясь объектом
  wrapConsole('log');
  wrapConsole('info');
  wrapConsole('warn');
  wrapConsole('error');
  wrapConsole('debug');
  return {
    lines: () => lines.slice(),
    on: (cb) => { logBus.on('line', cb); return () => logBus.off('line', cb); },
  };
}
