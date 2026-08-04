'use strict';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function getEffectivePort(url) {
  if (url.port) return Number.parseInt(url.port, 10);
  if (url.protocol === 'http:' || url.protocol === 'ws:') return 80;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 443;
  return null;
}

function isAllowedE2EUrl(candidate, configuredBaseUrl) {
  try {
    const requestedUrl = new URL(candidate);
    const baseUrl = new URL(configuredBaseUrl);
    if (!ALLOWED_PROTOCOLS.has(requestedUrl.protocol)) return false;
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') return false;
    return requestedUrl.hostname === baseUrl.hostname &&
      getEffectivePort(requestedUrl) === getEffectivePort(baseUrl);
  } catch (err) {
    return false;
  }
}

module.exports = {
  getEffectivePort,
  isAllowedE2EUrl
};
