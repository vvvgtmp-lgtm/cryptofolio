interface RuntimeConfig {
  apiBaseUrl: string;
  appEnv: string;
}

declare global {
  interface Window {
    __CONFIG__?: Partial<RuntimeConfig>;
  }
}

/** Filled by /config.js, which the container generates from env vars at start-up. */
export const config: RuntimeConfig = {
  apiBaseUrl: window.__CONFIG__?.apiBaseUrl ?? '/api',
  appEnv: window.__CONFIG__?.appEnv ?? 'unknown',
};
