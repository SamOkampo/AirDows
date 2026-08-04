(function initializePairingLinkPrivacy(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.PairingLinkPrivacy = api;
  if (root.document && root.history && root.location) {
    api.initializeBrowser(root);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPairingLinkPrivacy() {
  'use strict';

  const PAIRING_CODE_PATTERN = /^\d{4}$/;
  const ANALYTICS_PROPERTIES = Object.freeze({
    app_open: ['entry'],
    onboarding_dismissed: ['step'],
    onboarding_help_clicked: ['step'],
    onboarding_shown: ['mode'],
    pwa_prompt_shown: [],
    pwa_installed: [],
    file_queued: ['file_count', 'size_bucket'],
    room_created: [],
    transfer_role_selected: ['role', 'flow_version'],
    pairing_code_generated: ['role', 'flow_version'],
    pairing_code_submitted: ['entry', 'flow_version'],
    room_joined: ['role', 'transfer_role', 'flow_version'],
    connection_established: ['transfer_role', 'flow_version'],
    files_selected: ['file_count', 'size_bucket', 'flow_version'],
    send_confirmed: ['file_count', 'size_bucket', 'flow_version'],
    transfer_started: ['direction', 'size_bucket', 'mode', 'flow_version'],
    transfer_completed: ['direction', 'route', 'size_bucket', 'flow_version'],
    transfer_failed: ['direction', 'route', 'failure_type', 'flow_version'],
    transfer_cancelled: ['direction', 'initiated_by', 'flow_version'],
    receiver_download_clicked: ['flow_version', 'file_count_bucket'],
    route_selected: ['route']
  });

  let pendingBootstrap = null;

  function decodeParameter(value) {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch (error) {
      return String(value);
    }
  }

  function stripFragmentCodes(rawFragment) {
    if (!rawFragment) return { codeValues: [], fragment: '' };

    const codeValues = [];
    const safeParts = [];
    for (const part of rawFragment.split('&')) {
      const separator = part.indexOf('=');
      const rawKey = separator >= 0 ? part.slice(0, separator) : part;
      const rawValue = separator >= 0 ? part.slice(separator + 1) : '';

      if (decodeParameter(rawKey) === 'code') {
        codeValues.push(decodeParameter(rawValue));
      } else if (part) {
        safeParts.push(part);
      }
    }

    return { codeValues, fragment: safeParts.join('&') };
  }

  function sanitizePairingUrl(inputUrl, baseUrl = 'https://airdows.invalid') {
    const url = new URL(inputUrl, baseUrl);
    const queryCodeValues = url.searchParams.getAll('code');
    url.searchParams.delete('code');

    const fragmentResult = stripFragmentCodes(url.hash.slice(1));
    url.hash = fragmentResult.fragment ? `#${fragmentResult.fragment}` : '';

    const codeValues = [...queryCodeValues, ...fragmentResult.codeValues];
    const code = codeValues.length === 1 && PAIRING_CODE_PATTERN.test(codeValues[0])
      ? codeValues[0]
      : null;

    return {
      code,
      entry: code ? 'pairing_link' : 'direct',
      hadCodeParameter: codeValues.length > 0,
      sanitizedUrl: url.href,
      sanitizedPath: `${url.pathname}${url.search}${url.hash}`
    };
  }

  function bootstrapBrowser(browserWindow) {
    const result = sanitizePairingUrl(browserWindow.location.href);
    if (result.hadCodeParameter) {
      browserWindow.history.replaceState(
        browserWindow.history.state,
        browserWindow.document?.title || '',
        result.sanitizedPath
      );
    }

    return { code: result.code, entry: result.entry };
  }

  function initializeBrowser(browserWindow) {
    pendingBootstrap = bootstrapBrowser(browserWindow);
  }

  function consumeBootstrap() {
    const result = pendingBootstrap || { code: null, entry: 'direct' };
    pendingBootstrap = null;
    return result;
  }

  function buildPairingLink(origin, code) {
    const normalizedCode = String(code || '').trim();
    if (!PAIRING_CODE_PATTERN.test(normalizedCode)) {
      throw new Error('Pairing code must be exactly four digits');
    }

    const url = new URL('/app', origin);
    url.hash = `code=${normalizedCode}`;
    return url.href;
  }

  function sanitizeAnalyticsProperties(eventName, properties = {}) {
    const allowedProperties = ANALYTICS_PROPERTIES[eventName] || [];
    const sanitized = {};
    for (const property of allowedProperties) {
      if (Object.prototype.hasOwnProperty.call(properties, property)
          && !/\d{4}/.test(String(properties[property]))) {
        sanitized[property] = properties[property];
      }
    }
    return sanitized;
  }

  function isAllowedAnalyticsEvent(eventName) {
    return Object.prototype.hasOwnProperty.call(ANALYTICS_PROPERTIES, eventName);
  }

  function getSafeCacheRequestUrl(inputUrl, origin) {
    const result = sanitizePairingUrl(inputUrl, origin);
    return {
      sensitive: result.hadCodeParameter,
      url: result.sanitizedUrl
    };
  }

  function getLegacyAppRedirect(inputUrl, baseUrl = 'https://airdows.invalid') {
    const result = sanitizePairingUrl(inputUrl, baseUrl);
    const redirectUrl = new URL(result.sanitizedUrl);
    redirectUrl.pathname = '/app';

    if (result.code) {
      const fragment = redirectUrl.hash.slice(1);
      redirectUrl.hash = fragment ? `${fragment}&code=${result.code}` : `code=${result.code}`;
    }

    return {
      sensitive: result.hadCodeParameter,
      location: `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
    };
  }

  function getAppPrivacyHeaders(sensitive) {
    const headers = { 'Referrer-Policy': 'no-referrer' };
    if (sensitive) {
      headers['Cache-Control'] = 'no-store';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }
    return headers;
  }

  return Object.freeze({
    bootstrapBrowser,
    buildPairingLink,
    consumeBootstrap,
    getAppPrivacyHeaders,
    getLegacyAppRedirect,
    getSafeCacheRequestUrl,
    initializeBrowser,
    isAllowedAnalyticsEvent,
    sanitizeAnalyticsProperties,
    sanitizePairingUrl
  });
}));
