import net from 'node:net';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { counter, timer } from './metrics.js';

const LOCAL_PROXY_PORTS = [7897, 7890, 1087, 10809, 6152];

let cached = { proxyUrl: null, agent: null, probed: false };

function envProxyUrl() {
  return (
    process.env.DAYLIGHT_HTTPS_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || ''
  ).trim();
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function detectLocalProxy() {
  for (const port of LOCAL_PROXY_PORTS) {
    if (await canConnect(port)) return `http://127.0.0.1:${port}`;
  }
  return '';
}

async function resolveProxy() {
  const fromEnv = envProxyUrl();
  if (fromEnv) return fromEnv;
  // node:test 会 mock global fetch；自动走 undici+Clash 会绕过 mock 导致「fetch failed」
  if (process.env.DAYLIGHT_AUTO_PROXY === '0' || process.env.NODE_TEST_CONTEXT) return '';
  return detectLocalProxy();
}

async function getDispatcher() {
  if (!cached.probed) {
    cached.probed = true;
    cached.proxyUrl = await resolveProxy();
    if (cached.proxyUrl) {
      cached.agent = new ProxyAgent(cached.proxyUrl);
      console.log(`Daylight: 模型请求经代理 ${cached.proxyUrl}`);
    }
  }
  return cached.agent || undefined;
}

/** 供测试重置自动探测结果。 */
export function resetModelFetchProxyCache() {
  cached = { proxyUrl: null, agent: null, probed: false };
}

export function getModelFetchProxyUrl() {
  return cached.proxyUrl || envProxyUrl() || '';
}

/**
 * 模型相关 HTTPS 请求：优先走 HTTPS_PROXY / 本机 Clash 常见端口，
 * 解决直连中转站被重置、而 curl -x 127.0.0.1:7897 却可用的情况。
 */
export async function modelFetch(url, options = {}) {
  // Only the host identifies the provider; the path (which may carry a key) never enters a label.
  let provider = 'invalid';
  try { provider = new URL(url).hostname; } catch { /* keep the placeholder */ }
  const stop = timer('model.request.ms', { provider });
  try {
    const dispatcher = await getDispatcher();
    const response = dispatcher ? await undiciFetch(url, { ...options, dispatcher }) : await fetch(url, options);
    const outcome = response.ok ? 'ok' : 'error';
    stop({ status: response.status, outcome });
    counter('model.requests_total', { provider, outcome });
    return response;
  } catch (error) {
    stop({ outcome: 'exception' });
    counter('model.requests_total', { provider, outcome: 'exception' });
    throw error;
  }
}
