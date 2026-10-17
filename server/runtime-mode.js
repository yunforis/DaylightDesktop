/** Runtime policy is explicit; NODE_ENV only controls framework optimizations. */
export function runtimeMode(env = process.env) {
  const mode = env.DAYLIGHT_RUNTIME || 'local';
  if (!['local', 'production'].includes(mode)) throw new Error('DAYLIGHT_RUNTIME must be local or production');
  return mode;
}

export function isProductionRuntime() {
  return runtimeMode() === 'production';
}

export function requireLocalRuntime(operation) {
  if (isProductionRuntime()) {
    throw Object.assign(new Error(`${operation} is unavailable in production; deployment configuration is managed by environment variables`), {
      code: 'PRODUCTION_LOCAL_DISABLED', status: 503,
    });
  }
}
