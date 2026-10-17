import { withStorageSnapshot, commitStorage, discardStorage } from './storage/index.js';

// SSE is deliberately buffered too: no progress/done event or success header may
// escape before commit. This wrapper is for finite responses, not live feeds.
// At most 16,384 nonempty chunks, even when producers write one byte at a time.
// Write callbacks acknowledge bounded staging, not delivery to the socket.
export function storageHttpMiddleware({ pool, maxBufferBytes = 8 * 1024 * 1024, maxDurationMs = 120_000 } = {}) {
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0
    || !Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) throw new TypeError('Invalid HTTP storage buffer limits');
  return (req, res, next) => {
    const sendFailure = error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.statusCode = error?.status === 409 ? 409 : 503;
      res.statusMessage = undefined;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: res.statusCode === 409 ? '数据已更新，请刷新后重试。' : '数据未能提交，请稍后重试。' }));
    };
    return withStorageSnapshot({ pool, userId: req.user?.id || null, user: req.user, system: !req.user }, () => new Promise(resolve => {
      const original = { write: res.write, end: res.end, flushHeaders: res.flushHeaders, writeHead: res.writeHead };
      let chunks = [], bytes = 0, ending = false, settled = false, committing = false, disconnected = false, abandoned = false;
      const acknowledge = (callback, error) => { if (typeof callback === 'function') queueMicrotask(() => callback(error)); };
      const restore = () => Object.assign(res, original);
      const cleanup = () => {
        clearTimeout(timer);
        res.off('close', onClose);
        res.off('error', onClose);
        req.off('aborted', onClose);
        chunks = [];
        bytes = 0;
      };
      const abandon = error => {
        if (settled) return;
        abandoned = true;
        ending = true;
        disconnected ||= res.destroyed;
        // A database commit already in flight must settle before discard/close.
        if (committing) return;
        settled = true;
        discardStorage();
        cleanup();
        // Keep the guards installed while failed route continuations unwind.
        // Sending the error uses originals so late writes cannot append to it.
        if (!disconnected) {
          restore();
          sendFailure(error);
          res.write = guardedWrite;
          res.end = guardedEnd;
          res.flushHeaders = () => {};
          res.writeHead = guardedHead;
        }
        resolve();
      };
      const onClose = () => { disconnected = true; abandon(); };
      const timer = setTimeout(() => abandon(), maxDurationMs);
      timer.unref();
      res.once('close', onClose);
      res.once('error', onClose);
      req.once('aborted', onClose);
      const append = (chunk, encoding) => {
        if (chunk == null) return true;
        const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.byteLength;
        if (!Number.isSafeInteger(length) || bytes + length > maxBufferBytes
          || (length > 0 && chunks.length >= 16_384)) { abandon(); return false; }
        // Copy views: producers may reuse buffers before the delayed response.
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : Buffer.from(chunk);
        if (buffer.length) chunks.push(buffer);
        bytes += buffer.length;
        return true;
      };
      const guardedHead = (status, message, headers) => {
        if (ending) return res;
        res.statusCode = status;
        if (typeof message === 'string') res.statusMessage = message;
        else headers = message;
        if (Array.isArray(headers)) {
          for (let index = 0; index < headers.length; index += 2) res.appendHeader(headers[index], headers[index + 1]);
        } else if (headers) for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        return res;
      };
      const guardedWrite = (chunk, encoding, callback) => {
        const cb = typeof encoding === 'function' ? encoding : callback;
        const accepted = !ending && append(chunk, encoding);
        acknowledge(cb, accepted ? undefined : new Error('HTTP storage response is closed'));
        // Failed/closed responses do not emit drain; returning true lets stream
        // producers finish instead of waiting forever after the buffer is gone.
        return true;
      };
      const guardedEnd = (chunk, encoding, callback) => {
        const cb = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
        if (ending) { acknowledge(cb, new Error('HTTP storage response is closed')); return res; }
        if (typeof chunk !== 'function' && !append(chunk, encoding)) { acknowledge(cb, new Error('HTTP storage response is closed')); return res; }
        ending = true;
        (async () => {
          try {
            if (res.statusCode < 400) {
              committing = true;
              await commitStorage();
              committing = false;
            }
            discardStorage();
            if (disconnected) { acknowledge(cb, new Error('HTTP client disconnected')); return; }
            if (abandoned) {
              restore();
              sendFailure();
              acknowledge(cb, new Error('HTTP storage response expired'));
              return;
            }
            // One bounded payload avoids an unbounded queue of socket callbacks.
            const body = Buffer.concat(chunks, bytes);
            restore();
            original.end.call(res, body, cb);
          } catch (error) {
            committing = false;
            discardStorage();
            restore();
            sendFailure(error);
            acknowledge(cb, new Error('HTTP storage commit failed'));
          } finally {
            settled = true;
            cleanup();
            resolve();
          }
        })();
        return res;
      };
      res.flushHeaders = () => {};
      res.writeHead = guardedHead;
      res.write = guardedWrite;
      res.end = guardedEnd;
      if (req.aborted || res.destroyed) { onClose(); return; }
      try { next(); } catch { abandon(); }
    })).catch(sendFailure);
  };
}
