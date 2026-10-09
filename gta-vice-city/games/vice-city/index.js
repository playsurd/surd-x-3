/**
 * Module bootstrap — loads the reVC Emscripten runtime modules in the exact
 * order the engine build expects.
 */
(function () {
  'use strict';
  var version = window.__gameAssetVersion;
  var vq = function (url) {
    return version ? url + '?v=' + version : url;
  };
  var modules = [
    'games/vice-city/modules/runtime.js',
    'games/vice-city/modules/packages.js',
    'games/vice-city/modules/loader.js',
    'games/vice-city/modules/fs.js',
    'games/vice-city/modules/audio.js',
    'games/vice-city/modules/graphics.js',
    'games/vice-city/modules/events.js',
    'games/vice-city/modules/fetch.js',
    'games/vice-city/modules/asm_consts.js',
    'games/vice-city/modules/main.js',
  ].map(vq);
  var loadNext = function (i) {
    if (i >= modules.length) return;
    var s = document.createElement('script');
    s.src = modules[i];
    s.async = false;
    s.onload = function () { loadNext(i + 1); };
    s.onerror = function () { console.error('[reVC] failed to load module: ' + modules[i]); };
    document.body.appendChild(s);
  };
  loadNext(0);
})();
