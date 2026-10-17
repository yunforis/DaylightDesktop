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

/** Storage wrappers preserve authentication context when invoked by HTTP or jobs. */
export function getRequestContext() {
  return storage.getStore() || {};
}
