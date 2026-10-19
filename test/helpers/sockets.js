import { io as connectClient } from 'socket.io-client';

export const P = (col, row) => ({ col, row });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));

/** Kết nối Socket.IO; ghi lại mọi sự kiện để test không bị lỡ sự kiện đến sớm. */
export function connectWith(url, auth, clients = []) {
  return new Promise((resolve, reject) => {
    const s = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    s.log = [];
    s.waiters = [];
    s.onAny((ev, ...args) => {
      const i = s.waiters.findIndex((w) => w.ev === ev);
      if (i >= 0) {
        const [w] = s.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(args[0]);
      } else {
        s.log.push({ ev, args });
      }
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    clients.push(s);
  });
}

export function waitFor(s, ev, ms = 3000) {
  const i = s.log.findIndex((e) => e.ev === ev);
  if (i >= 0) return Promise.resolve(s.log.splice(i, 1)[0].args[0]);
  return new Promise((resolve, reject) => {
    const w = { ev, resolve };
    w.timer = setTimeout(() => {
      s.waiters = s.waiters.filter((x) => x !== w);
      reject(new Error(`timeout chờ sự kiện ${ev}`));
    }, ms);
    s.waiters.push(w);
  });
}
