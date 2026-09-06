import WebSocket from 'ws';
import { config } from './config.js';

/**
 * Исходящее соединение из дома в облачный релей.
 * Инициатива всегда изнутри дома — не нужно пробрасывать порты наружу
 * или бороться с CGNAT/динамическим IP.
 * Если RELAY_URL не задан — модуль просто ничего не делает (только локальная сеть).
 */
export function connectRelay(hub) {
  if (!config.relayUrl) {
    console.log('[relay] RELAY_URL не задан — облачный релей отключен, работаем только локально.');
    return;
  }

  let ws = null;
  let reconnectDelay = 1000;

  function sendState() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', devices: hub.listDevices() }));
    }
  }

  function connect() {
    const url = `${config.relayUrl.replace(/\/$/, '')}/home?token=${encodeURIComponent(config.relayToken)}`;
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('[relay] соединение с облаком установлено');
      reconnectDelay = 1000;
      sendState();
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'command') {
        try {
          hub.setPower(msg.deviceId, msg.action);
        } catch (err) {
          console.error('[relay] ошибка команды', err.message);
        }
      }
    });

    ws.on('close', scheduleReconnect);
    ws.on('error', (err) => console.error('[relay] ошибка соединения', err.message));
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  hub.on('change', sendState);
  connect();
}
