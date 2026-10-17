import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithRequestContext(context, fn) {
  return storage.run(context || {}, fn);
}

export function getRequestUserId() {
  return storage.getStore()?.userId || null;
}

export function getRequestUser() {
  return storage.getStore()?.user || null;
}
