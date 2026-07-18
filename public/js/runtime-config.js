(function initializeAirDowsRuntime(global) {
  const storageKey = 'airdows-signaling-url';
  const isNative = Boolean(global.Capacitor?.isNativePlatform?.());
  let signalingUrl = '';

  function normalizeUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    try {
      const url = new URL(trimmed);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
    } catch (error) {
      return '';
    }
  }

  async function readNativeConfig() {
    const plugin = global.Capacitor?.Plugins?.AirDowsRuntime;
    if (!isNative || !plugin?.getConfig) return '';

    try {
      const config = await plugin.getConfig();
      return normalizeUrl(config?.signalingUrl);
    } catch (error) {
      console.info('Native runtime config unavailable:', error.message);
      return '';
    }
  }

  const ready = (async () => {
    const nativeUrl = await readNativeConfig();
    const savedUrl = normalizeUrl(global.localStorage?.getItem(storageKey));
    signalingUrl = nativeUrl || savedUrl;
    global.dispatchEvent(new CustomEvent('airdows-runtime-ready'));
  })();

  global.AirDowsRuntime = {
    isNative,
    ready,
    getSignalingUrl: () => signalingUrl,
    setSignalingUrl: (value) => {
      const normalized = normalizeUrl(value);
      if (!normalized) return false;
      signalingUrl = normalized;
      global.localStorage?.setItem(storageKey, normalized);
      return true;
    }
  };
})(window);
