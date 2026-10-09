/**
 * Shared loader status contract for both game runtimes.
 *
 * Both games drive the same overlay (#spinner bar, #status line, #loader-subtext
 * hint). Previously each loader wrote to a different subset of those elements,
 * so Vice City filled the native <progress> while GTA III filled the styled bar,
 * and each clobbered the hint line with its own text. This module is the single
 * implementation both use.
 *
 * Exposed as window.GTALoaderUI.
 */
(function () {
  'use strict';

  const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

  function statusEl() {
    return document.getElementById('status');
  }

  function spinnerEl() {
    return document.getElementById('spinner');
  }

  /**
   * Update the status line and optionally the progress bar.
   * @param {string} text
   * @param {number} [pct] 0-100
   */
  function setStatus(text, pct) {
    const el = statusEl();
    if (el) {
      el.textContent = text || '';
      el.removeAttribute('data-state');
    }
    if (typeof pct === 'number') setProgress(pct);
    console.log('[loader]', text || '', typeof pct === 'number' ? pct + '%' : '');
  }

  /** @param {number} pct 0-100 */
  function setProgress(pct) {
    const value = clampPct(pct);
    const spinner = spinnerEl();
    if (spinner) {
      spinner.hidden = false;
      spinner.setAttribute('role', 'progressbar');
      spinner.setAttribute('aria-valuemin', '0');
      spinner.setAttribute('aria-valuemax', '100');
      spinner.setAttribute('aria-valuenow', String(Math.round(value)));
      const fill = spinner.querySelector('.progress-bar-fill');
      if (fill) fill.style.width = value.toFixed(1) + '%';
    }
  }

  /** Persistent hint line under the status (does not change during loading). */
  function setDetail(text) {
    const el = document.getElementById('loader-subtext');
    if (el) el.textContent = text;
  }

  /** Report a terminal failure in the same place and style for both games. */
  function fail(text) {
    const el = statusEl();
    if (el) {
      el.textContent = text || 'Failed to start.';
      el.setAttribute('data-state', 'error');
    }
    setProgress(0);
    console.error('[loader]', text);
  }

  /** Hide the progress bar once the engine is running. */
  function done() {
    const spinner = spinnerEl();
    if (spinner) spinner.hidden = true;
  }

  window.GTALoaderUI = { setStatus, setProgress, setDetail, fail, done };
})();
