'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');

function extractSource(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  assert.notEqual(start, -1, `Missing ${label} start anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `Missing ${label} end anchor: ${endAnchor}`);
  assert.ok(start < end, `${label} anchors are reordered`);
  return source.slice(start, end);
}

function createElement() {
  const attributes = new Map();
  return {
    textContent: '',
    dataset: {},
    classList: { toggle() {} },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) || null;
    }
  };
}

function loadOnboardingHarness() {
  const i18nSource = extractSource(
    htmlSource,
    'const i18n =',
    'let currentLang =',
    'app.html i18n'
  );
  const translationsContext = {};
  vm.runInNewContext(
    `${i18nSource}\n;globalThis.translations = i18n;`,
    translationsContext
  );

  const onboardingSource = extractSource(
    appSource,
    'const onboardingCopy =',
    'function setOnboardingCompact',
    'app.js onboarding'
  );
  const title = createElement();
  const hint = createElement();
  const progress = createElement();
  const stepElements = [1, 2, 3, 4].map((step) => ({
    dataset: { onboardingStep: String(step) },
    classList: { toggle() {} }
  }));
  let language = 'es';
  const context = {
    onboardingGuide: {},
    onboardingStep: 1,
    onboardingComplete: false,
    onboardingProgress: progress,
    onboardingCurrentTitle: title,
    onboardingHint: hint,
    onboardingStepElements: stepElements,
    translate(key) {
      return translationsContext.translations[language][key];
    }
  };

  vm.runInNewContext(
    `${onboardingSource}\n;globalThis.renderOnboarding = updateOnboarding;`,
    context
  );

  return {
    render: context.renderOnboarding,
    title,
    progress,
    setLanguage(nextLanguage) {
      language = nextLanguage;
      for (const element of [title, progress]) {
        const key = element.getAttribute('data-i18n');
        const step = element.getAttribute('data-i18n-step');
        const translated = translationsContext.translations[language][key];
        element.textContent = step
          ? translated.replace('{step}', step)
          : translated;
      }
    }
  };
}

test('active onboarding titles and progress change language without reloading', () => {
  const harness = loadOnboardingHarness();
  const expected = {
    1: ['Crea una conexión o usa un código', 'Create a connection or use a code'],
    2: ['Esperando al otro dispositivo', 'Waiting for the other device'],
    3: ['Conectado', 'Connected'],
    4: ['Enviando tus archivos', 'Sending your files']
  };

  for (const step of [1, 2, 3, 4]) {
    harness.setLanguage('es');
    harness.render(step);
    assert.equal(harness.title.textContent, expected[step][0]);
    assert.equal(
      harness.title.getAttribute('data-i18n'),
      `onboarding_step_${step}_title`
    );

    harness.setLanguage('en');
    assert.equal(harness.title.textContent, expected[step][1]);
    assert.equal(harness.progress.textContent, `Step ${step} of 4`);
    assert.equal(harness.progress.getAttribute('data-i18n-step'), String(step));

    harness.setLanguage('es');
    assert.equal(harness.title.textContent, expected[step][0]);
    assert.equal(harness.progress.textContent, `Paso ${step} de 4`);
  }
});
