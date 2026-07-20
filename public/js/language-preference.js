(function () {
  const STORAGE_KEY = 'airdows-language-v1';
  const supportedLanguages = new Set(['en', 'es']);

  function normalizeLanguage(value) {
    const language = String(value || '').toLowerCase().split('-')[0];
    return supportedLanguages.has(language) ? language : null;
  }

  function getStoredLanguage() {
    try {
      return normalizeLanguage(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function getLanguage() {
    const queryLanguage = normalizeLanguage(new URLSearchParams(window.location.search).get('lang'));
    if (queryLanguage) return queryLanguage;

    const fixedSpanishRoutes = new Set([
      '/como-funciona',
      '/privacidad',
      '/seguridad',
      '/pasar-archivos-iphone-a-pc',
      '/pasar-archivos-android-a-pc',
      '/enviar-videos-sin-perder-calidad'
    ]);
    if (window.location.pathname.startsWith('/en/')) return 'en';
    if (fixedSpanishRoutes.has(window.location.pathname)) return 'es';

    return getStoredLanguage() || normalizeLanguage(navigator.language) || 'en';
  }

  function setLanguage(language) {
    const normalized = normalizeLanguage(language);
    if (!normalized) return;
    try {
      localStorage.setItem(STORAGE_KEY, normalized);
    } catch (_) {}
  }

  function syncLanguageControls(language) {
    document.querySelectorAll('[data-language]').forEach((button) => {
      const active = button.dataset.language === language;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function initializeControls() {
    const language = getLanguage();
    if (normalizeLanguage(new URLSearchParams(window.location.search).get('lang'))) {
      setLanguage(language);
    }
    document.documentElement.lang = language;
    syncLanguageControls(language);

    document.querySelectorAll('[data-language]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextLanguage = normalizeLanguage(button.dataset.language);
        if (!nextLanguage || nextLanguage === getLanguage()) return;
        setLanguage(nextLanguage);
        document.documentElement.lang = nextLanguage;
        syncLanguageControls(nextLanguage);
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('lang', nextLanguage);
        history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
        window.dispatchEvent(
          new CustomEvent('airdows:language-change', {
            detail: nextLanguage
          })
        );
      });
    });
  }

  window.airDowsLanguage = {
    get: getLanguage,
    set: setLanguage,
    syncControls: syncLanguageControls
  };

  document.addEventListener('DOMContentLoaded', initializeControls);
})();
