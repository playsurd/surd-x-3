/**
 * GTA: Vice City (reVC) WebAssembly loader.
 *
 * The whole game ships as a chunked Emscripten data package. The chunks are
 * downloaded in parallel (cached in CacheStorage), concatenated, and handed to
 * the runtime through Module.getPreloadedPackage — loader.js then materialises
 * every entry into MEMFS. The engine itself is the vendored reVC build
 * (vc-sky-en-v6.wasm + modules/).
 */
(function () {
  'use strict';

  /**
   * Stamp a loader URL with the page's build version.
   *
   * The files under /games/ were once served `immutable`, and a browser holding
   * such an entry will not revalidate it no matter what the server now says.
   * A versioned URL is what lets a corrected loader reach those caches.
   */
  const vq = (url) => {
    const v = window.__gameAssetVersion;
    if (!v) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + v;
  };

  const BASE_PATH = '/vcsky/';
  const DATA_CHUNKS = [
    'vc-sky-en-v6.data.00', 'vc-sky-en-v6.data.01', 'vc-sky-en-v6.data.02',
    'vc-sky-en-v6.data.03', 'vc-sky-en-v6.data.04', 'vc-sky-en-v6.data.05',
    'vc-sky-en-v6.data.06',
  ];
  const DATA_SIZE = 135355111;
  const WASM_URL = BASE_PATH + 'vc-sky-en-v6.wasm';

  let dataBuffer = null;
  let isLaunching = false;
  let Module = null;

  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isTouch = isMobile && window.matchMedia('(pointer: coarse)').matches;

  const revc_iniDefault = `[VideoMode]
Width=1280
Height=720
Depth=32
Subsystem=0
Windowed=0
[Controller]
HeadBob1stPerson=0
HorizantalMouseSens=0.002500
InvertMouseVertically=1
DisableMouseSteering=1
Vibration=0
Method=${isTouch ? '1' : '0'}
InvertPad=0
JoystickName=
PadButtonsInited=0
[Audio]
SfxVolume=45
MusicVolume=45
MP3BoostVolume=0
Radio=1
SpeakerType=0
Provider=0
DynamicAcoustics=1
[Display]
Brightness=256
DrawDistance=1.800000
Subtitles=1
ShowHud=1
RadarMode=0
ShowLegends=0
PedDensity=1.200000
CarDensity=1.200000
CutsceneBorders=1
FreeCam=0
[Graphics]
AspectRatio=0
VSync=1
Trails=0
FrameLimiter=0
MultiSampling=0
IslandLoading=0
PS2AlphaTest=1
ColourFilter=2
MotionBlur=0
VehiclePipeline=0
NeoRimLight=0
NeoLightMaps=0
NeoRoadGloss=0
[General]
SkinFile=$""
Language=0
DrawVersionText=0
NoMovies=1
[Rendering]
BackfaceCulling=1
NewRenderer=1
[Draw]
ProperScaling=1
FixRadar=1
FixSprites=1
[Bindings]
PED_FIREWEAPON=mouse:LEFT,2ndKbd:PAD5
PED_CYCLE_WEAPON_RIGHT=2ndKbd:PADENTER,mouse:WHLDOWN,kbd:E
PED_CYCLE_WEAPON_LEFT=kbd:PADDEL,mouse:WHLUP,2ndKbd:Q
GO_FORWARD=kbd:UP,2ndKbd:W
GO_BACK=kbd:DOWN,2ndKbd:S
GO_LEFT=2ndKbd:A,kbd:LEFT
GO_RIGHT=kbd:RIGHT,2ndKbd:D
PED_SNIPER_ZOOM_IN=kbd:PGUP,2ndKbd:Z,mouse:WHLUP
PED_SNIPER_ZOOM_OUT=kbd:PGDN,2ndKbd:X,mouse:WHLDOWN
VEHICLE_ENTER_EXIT=kbd:ENTER,2ndKbd:F
CAMERA_CHANGE_VIEW_ALL_SITUATIONS=kbd:HOME,2ndKbd:V
PED_JUMPING=kbd:RCTRL,2ndKbd:SPC
PED_SPRINT=2ndKbd:LSHIFT,kbd:RSHIFT
PED_LOOKBEHIND=2ndKbd:CAPSLK,mouse:MIDDLE,kbd:PADINS
PED_DUCK=kbd:C
PED_ANSWER_PHONE=kbd:TAB
VEHICLE_FIREWEAPON=kbd:PADINS,2ndKbd:LCTRL,mouse:LEFT
VEHICLE_ACCELERATE=2ndKbd:W
VEHICLE_BRAKE=2ndKbd:S
VEHICLE_CHANGE_RADIO_STATION=kbd:INS,2ndKbd:R
VEHICLE_HORN=kbd:H
TOGGLE_SUBMISSIONS=kbd:PLUS,2ndKbd:CAPSLK
VEHICLE_HANDBRAKE=kbd:RCTRL,2ndKbd:SPC,mouse:RIGHT
PED_1RST_PERSON_LOOK_LEFT=kbd:PADLEFT
PED_1RST_PERSON_LOOK_RIGHT=kbd:PADHOME
VEHICLE_LOOKLEFT=kbd:PADEND,2ndKbd:Q
VEHICLE_LOOKRIGHT=kbd:PADDOWN,2ndKbd:E
VEHICLE_LOOKBEHIND=mouse:MIDDLE
VEHICLE_TURRETLEFT=kbd:PADLEFT
VEHICLE_TURRETRIGHT=kbd:PAD5
VEHICLE_TURRETUP=kbd:PADPGUP,2ndKbd:UP
VEHICLE_TURRETDOWN=kbd:PADRIGHT,2ndKbd:DOWN
PED_CYCLE_TARGET_LEFT=kbd:[,2ndKbd:PADEND
PED_CYCLE_TARGET_RIGHT=2ndKbd:],kbd:PADDOWN
PED_CENTER_CAMERA_BEHIND_PLAYER=kbd:#
PED_LOCK_TARGET=kbd:DEL,mouse:RIGHT,2ndKbd:PADRIGHT
`;

  // WebGL high-performance & safe fallback context patch
  (function installWebGLPerformancePatch() {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    if (!origGetContext || origGetContext.__revcPatched) return;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (typeof type === 'string' && (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl')) {
        const safeAttrs = Object.assign({
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false,
        }, attrs || {});
        // Do NOT force desynchronized on mobile: Qualcomm Adreno / Mali EGL drivers fail or lose context
        if (isMobile || isTouch) {
          delete safeAttrs.desynchronized;
        }
        let ctx = null;
        try {
          ctx = origGetContext.call(this, type, safeAttrs);
        } catch (_) {}
        if (ctx) return ctx;
        return origGetContext.call(this, type, attrs);
      }
      return origGetContext.call(this, type, attrs);
    };
    HTMLCanvasElement.prototype.getContext.__revcPatched = true;
  })();

  // AudioContext unlocker & low-latency optimization
  const audioContexts = [];
  const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
  let prewarmedAudioCtx = null;

  function warmUpAudio() {
    try {
      if (!prewarmedAudioCtx && OriginalAudioContext) {
        prewarmedAudioCtx = new OriginalAudioContext({ latencyHint: 'interactive' });
        audioContexts.push(prewarmedAudioCtx);
      }
      if (prewarmedAudioCtx) {
        if (prewarmedAudioCtx.state === 'suspended') {
          prewarmedAudioCtx.resume().catch(() => {});
        }
        // Prime audio output pipeline with 1 silent sample
        const buf = prewarmedAudioCtx.createBuffer(1, 1, prewarmedAudioCtx.sampleRate || 44100);
        const src = prewarmedAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(prewarmedAudioCtx.destination);
        src.start(0);
      }
      for (const ctx of audioContexts) {
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
    } catch (_) {}
  }

  if (OriginalAudioContext && !OriginalAudioContext.__revcPatched) {
    class MonitoredAudioContext extends OriginalAudioContext {
      constructor(...args) {
        let opts = args[0];
        if (opts === undefined || (opts && typeof opts === 'object')) {
          opts = Object.assign({ latencyHint: 'interactive' }, opts || {});
          args[0] = opts;
        }
        super(...args);
        audioContexts.push(this);
        if (this.state === 'suspended') {
          this.resume().catch(() => {});
        }
      }
    }
    MonitoredAudioContext.__revcPatched = true;
    window.AudioContext = MonitoredAudioContext;
    window.webkitAudioContext = MonitoredAudioContext;
  }

  function unlockAudio() {
    warmUpAudio();
    for (const ctx of audioContexts) {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  }

  ['click', 'keydown', 'pointerdown', 'mousedown', 'touchstart', 'touchend'].forEach((ev) => {
    window.addEventListener(ev, unlockAudio, { passive: true, capture: true });
  });

  window.__revcUnlockAudio = unlockAudio;

  /** Fetch a large static binary through CacheStorage. */
  async function fetchCached(url) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      try { await cache.put(url, new Response(buf.slice(0))); } catch (_) {}
      return buf;
    } catch (err) {
      console.warn('[reVC] cached fetch failed, falling back:', err);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.arrayBuffer();
    }
  }

  /* The port's stock binding put the horn on Shift, which collides with sprint
   * and leaves the horn blaring in a car. Migrate any stored ini. */
  function sanitizeIni(ini) {
    if (/^VEHICLE_HORN=.*$/im.test(ini)) {
      return ini.replace(/^VEHICLE_HORN=.*$/im, 'VEHICLE_HORN=kbd:H');
    }
    return ini + '\n[Bindings]\nVEHICLE_HORN=kbd:H\n';
  }

  function updateStatus(text, pct) {
    window.GTALoaderUI.setStatus(text, pct);
  }

  /** Download the package chunks (parallel, CacheStorage-backed). */
  const CHUNK_MB = 20;
  const CACHE_NAME = `vc-chunks-${DATA_SIZE}`;

  async function loadData() {
    if (dataBuffer) return dataBuffer;

    let cache = null;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (err) {
      console.warn('[reVC] CacheStorage unavailable:', err);
    }

    const full = new Uint8Array(DATA_SIZE);
    let downloaded = 0;
    const report = () => {
      const pct = Math.min(100, Math.floor((downloaded / DATA_SIZE) * 100));
      updateStatus(`Downloading game data… ${pct}%`, pct);
    };

    const processChunk = async (name, i) => {
      const path = BASE_PATH + name;
      const offset = i * CHUNK_MB * 1048576;
      const expected = Math.min(CHUNK_MB * 1048576, DATA_SIZE - offset);
      let bytes = null;

      if (cache) {
        const hit = await cache.match(path);
        if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
      }
      if (!bytes) {
        const res = await fetch(path);
        if (!res.ok || !res.body) throw new Error(`chunk ${name}: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const parts = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          received += value.length;
          downloaded += value.length;
          report();
        }
        bytes = new Uint8Array(received);
        let off = 0;
        for (const part of parts) {
          bytes.set(part, off);
          off += part.length;
        }
        if (cache) {
          try { await cache.put(path, new Response(bytes)); } catch (_) {}
        }
      } else {
        downloaded += bytes.byteLength;
        report();
      }

      if (bytes.byteLength !== expected) {
        throw new Error(`chunk ${name}: expected ${expected} bytes, got ${bytes.byteLength} (stale cache?)`);
      }
      full.set(bytes, offset);
    };

    const t0 = performance.now();
    await Promise.all(DATA_CHUNKS.map(processChunk));
    dataBuffer = full;
    console.log(`[reVC] game data ready in ${((performance.now() - t0) / 1000).toFixed(1)}s (${(DATA_SIZE / 1048576).toFixed(0)} MB)`);
    return dataBuffer;
  }

  /* ── Player skins ──────────────────────────────────────────────────────
   * tools/build-vc-skins.py writes 45056-byte clones of the stock
   * models/gta3.img/player.txd, one per Bangla mod skin. The chosen skin is
   * spliced into the package buffer before loader.js slices it into MEMFS,
   * so the engine never sees the stock texture. */
  const SKIN_KEY = 'vcsky.skin';

  async function loadSelectedSkin() {
    let id = null;
    try { id = localStorage.getItem(SKIN_KEY); } catch (e) {}
    if (!id) return null;
    try {
      const res = await fetch(`/vc-assets/local/skins/${id}.txd`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== 45056) throw new Error(`${bytes.byteLength} bytes`);
      return bytes;
    } catch (err) {
      console.warn('[reVC] skin "' + id + '" unavailable, using stock:', err.message);
      return null;
    }
  }

  function applySkin(buffer, skin) {
    let pkg = null;
    try { pkg = window.DATA_PACKAGE || (typeof DATA_PACKAGE !== 'undefined' ? DATA_PACKAGE : null); } catch (e) { pkg = window.DATA_PACKAGE; }
    let patched = 0;
    if (pkg && pkg.files) {
      for (const file of pkg.files) {
        // Only the gameplay player slot: the skin TXDs carry the "player"
        // dictionary name, and csplay.txd / any future variant would differ.
        if (!/\/player\.txd$/.test(file.filename)) continue;
        if (file.end - file.start !== skin.byteLength) continue;
        buffer.set(skin, file.start);
        patched++;
      }
    }
    if (!patched && skin.byteLength === 45056 && buffer.byteLength >= 103636494) {
      buffer.set(skin, 103591438);
      patched++;
    }
    if (patched) console.log(`[reVC] player skin applied to ${patched} slot(s)`);
    else console.warn('[reVC] no matching player slot; using stock texture');
  }

  async function preloadBmpSkins() {
    try {
      const res = await fetch('/vc-assets/local/skins/skins.json');
      if (!res.ok) return [];
      const data = await res.json();
      const skins = data.skins || [];
      const loaded = [];
      await Promise.allSettled(skins.map(async (item) => {
        try {
          const bmpRes = await fetch(`/vc-assets/local/skins/${item.bmp || (item.id + '.bmp')}`);
          if (!bmpRes.ok) return;
          const buf = new Uint8Array(await bmpRes.arrayBuffer());
          loaded.push({ id: item.id, name: item.name, bytes: buf });
        } catch (_) {}
      }));
      return loaded;
    } catch (err) {
      console.warn('[reVC] Preload BMP skins error:', err);
      return [];
    }
  }

  function stageBmpSkins(FS, bmpSkins, activeSkinId) {
    try {
      try { FS.mkdirTree('/skins'); } catch (_) {}
      try { FS.mkdirTree('/vc-assets/local/skins'); } catch (_) {}
      try { FS.mkdirTree('/models/generic'); } catch (_) {}
      try { FS.mkdirTree('/vc-assets/local/models/generic'); } catch (_) {}

      let activeBmp = null;
      for (const item of bmpSkins) {
        try { FS.writeFile(`/skins/${item.name}.bmp`, item.bytes); } catch (_) {}
        try { FS.writeFile(`/skins/${item.id}.bmp`, item.bytes); } catch (_) {}
        try { FS.writeFile(`/vc-assets/local/skins/${item.name}.bmp`, item.bytes); } catch (_) {}
        try { FS.writeFile(`/vc-assets/local/skins/${item.id}.bmp`, item.bytes); } catch (_) {}
        if (activeSkinId && (item.id === activeSkinId || item.name === activeSkinId)) {
          activeBmp = item.bytes;
        }
      }

      if (activeBmp) {
        try { FS.writeFile('/vc-assets/local/models/generic/player.bmp', activeBmp); } catch (_) {}
        try { FS.writeFile('/models/generic/player.bmp', activeBmp); } catch (_) {}
        console.log('[reVC] active player skin BMP set as generic/player.bmp');
      }

      console.log(`[reVC] ${bmpSkins.length} BMP skins staged synchronously to /skins/`);
    } catch (err) {
      console.warn('[reVC] Error staging BMP skins:', err);
    }
  }

  function setupGameHUD(canvas) {
    const hud = document.getElementById('game-hud-bar');
    if (hud) hud.hidden = false;
    const fsBtn = document.getElementById('hud-fullscreen-btn');
    if (fsBtn) {
      fsBtn.onclick = () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
          if (navigator.keyboard && navigator.keyboard.lock) {
            navigator.keyboard.lock(['Escape']).catch(() => {});
          }
        } else {
          if (navigator.keyboard && navigator.keyboard.unlock) {
            navigator.keyboard.unlock();
          }
          document.exitFullscreen().catch(() => {});
        }
        setTimeout(() => canvas.focus({ preventScroll: true }), 150);
      };
    }
    const exitBtn = document.getElementById('hud-exit-btn');
    if (exitBtn) {
      exitBtn.onclick = () => {
        if (confirm('Exit GTA Vice City and return to launcher?')) location.reload();
      };
    }

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        if (navigator.keyboard && navigator.keyboard.unlock) {
          navigator.keyboard.unlock();
        }
      }
      setTimeout(() => canvas.focus({ preventScroll: true }), 150);
    });
  }

  /* Fade the launcher out in place. It is a fixed overlay above the
   * already-mounted canvas, so this never collapses the page the way the
   * previous display:none did. */
  function dismissLauncher() {
    const launcher = document.querySelector('.start-container');
    if (!launcher || launcher.classList.contains('is-gone')) return;
    launcher.classList.add('is-leaving');
    const finish = () => launcher.classList.add('is-gone');
    launcher.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 400);
  }

  async function startViceCity(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (isLaunching) return;
    isLaunching = true;
    unlockAudio();

    document.body.classList.add('gameIsStarted');
    installTouchControls();

    const intro = document.querySelector('.intro-container');
    if (intro) intro.removeAttribute('hidden');
    dismissLauncher();

    const canvas = document.getElementById('canvas');
    if (!canvas) {
      alert('Canvas element not found!');
      return;
    }

    /**
     * Swallow pointer-lock rejections on the prototype, not at one call site.
     *
     * requestPointerLock returns a promise in current browsers and rejects in
     * ordinary situations — most commonly `SecurityError: Pointer lock cannot
     * be acquired immediately after the user has exited the lock`, which
     * happens whenever the player presses Esc or Alt and then clicks again.
     * The runtime calls it from several places (this file and the vendored
     * Emscripten events module), and any rejection nobody handles surfaces as
     * an uncaught promise error — which the diagnostics banner would then
     * report as "the game stopped" while it is playing perfectly well.
     *
     * Patching the prototype covers every caller at once, and mirrors what the
     * GTA III loader already does.
     */
    (function installPointerLockErrorSwallow() {
      const patch = (proto) => {
        if (!proto || proto.__revcLockSwallow) return;
        proto.__revcLockSwallow = true;
        const orig = proto.requestPointerLock;
        if (typeof orig !== 'function') return;
        proto.requestPointerLock = function (options, ...args) {
          try {
            const opts = (options && typeof options === 'object')
              ? Object.assign({ unadjustedMovement: true }, options)
              : { unadjustedMovement: true };
            const ret = orig.call(this, opts, ...args);
            if (ret && typeof ret.catch === 'function') {
              return ret
                .catch(() => orig.call(this, ...args))
                .catch(() => {});
            }
            return ret;
          } catch (_) {
            try { return orig.call(this, ...args); } catch (e) { /* ignore */ }
            return undefined;
          }
        };
      };
      patch(Element.prototype);
      patch(Object.getPrototypeOf(canvas));
    })();

    if (!isTouch) {
      /**
       * Page chrome the pointer must not be stolen from. The navbar carries
       * fullscreen/exit while playing, and locking the pointer on *any*
       * mousedown (a document-level capture listener sees every one) retargets
       * the rest of that click to the canvas, so those controls never fire.
       */
      const isChrome = (target) => {
        if (!target || typeof target.closest !== 'function') return false;
        return !!target.closest('header, .start-container, .start-overlay, .modal, dialog, button, a, input, select, label');
      };

      function lockMouseIfNeeded(event) {
        if (event && isChrome(event.target)) return;
        if (!document.pointerLockElement && Module && Module.canvas) {
          try {
            const p = Module.canvas.requestPointerLock?.({ unadjustedMovement: true });
            if (p && p.catch) p.catch(() => {
              try { Module.canvas.requestPointerLock?.(); } catch (e) {}
            });
          } catch (e) {}
        }
      }
      document.addEventListener('mousedown', lockMouseIfNeeded, { capture: true });
      if (navigator.keyboard && navigator.keyboard.lock) {
        navigator.keyboard.lock(['Escape', 'KeyW']).catch(() => {});
      }
      let skipRogueDeltas = 0;
      document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement) skipRogueDeltas = 2;
      });
      window.addEventListener('mousemove', (e) => {
        if (skipRogueDeltas > 0) {
          skipRogueDeltas--;
          e.stopImmediatePropagation();
        }
      }, { capture: true });
    }

    const INTRO_AUDIO_URLS = [
      '/vc-assets/local/audio/intro1.wav',
      '/vc-assets/local/audio/intro2.wav',
      '/vc-assets/local/audio/intro3.wav',
      '/vc-assets/local/audio/intro4.wav',
    ];
    let prefetchedIntroAudio = [];
    async function prefetchIntroAudio() {
      try {
        const entries = await Promise.all(
          INTRO_AUDIO_URLS.map(async (url) => {
            try {
              const res = await fetch(url);
              if (!res.ok) return null;
              const buf = await res.arrayBuffer();
              const name = url.split('/').pop();
              return { name, data: new Uint8Array(buf) };
            } catch (_) {
              return null;
            }
          })
        );
        prefetchedIntroAudio = entries.filter(Boolean);
        console.log(`[reVC] Prefetched ${prefetchedIntroAudio.length} intro cutscene audio tracks`);
      } catch (e) {
        console.warn('[reVC] intro audio prefetch error:', e);
      }
    }

    try {
      updateStatus('Downloading game data…', 5);
      const [buffer] = await Promise.all([
        loadData(),
        prefetchIntroAudio(),
      ]);
      const skin = await loadSelectedSkin();
      if (skin) updateStatus('Applying player skin…', 75);

      updateStatus('Staging custom character skins…', 78);
      const bmpSkins = await preloadBmpSkins();

      updateStatus('Compiling WebAssembly engine…', 80);
      let revc_ini = sanitizeIni(localStorage.getItem('vcsky.revc.ini') || revc_iniDefault);
      const selectedSkinId = localStorage.getItem(SKIN_KEY);
      const selectedSkinName = localStorage.getItem('vcsky.skin_name');
      if (selectedSkinId) {
        const skinNameVal = selectedSkinName || selectedSkinId;
        const reSkin = /^SkinFile=.*$/im;
        if (reSkin.test(revc_ini)) {
          revc_ini = revc_ini.replace(reSkin, `SkinFile=$"${skinNameVal}"`);
        } else {
          revc_ini += `\n[General]\nSkinFile=$"${skinNameVal}"\n`;
        }
      }

      Module = {
        canvas: canvas,
        arguments: window.location.search.slice(1).split('&').filter(Boolean).map(decodeURIComponent),
        // Keep engine diagnostics; drop the noisy decoder chatter only.
        print: (...args) => {
          const line = args.join(' ');
          console.log('[reVC]', ...args);
          if (line.includes('OpenAL') || line.includes('Cutscene') || line.includes('START_CUTSCENE') || line.includes('audio')) {
            unlockAudio();
          }
        },
        printErr: (msg) => {
          if (typeof msg === 'string' && (msg.indexOf('mpg123') !== -1 || msg.indexOf('layer3.c') !== -1)) return;
          console.warn('[reVC]', msg);
        },
        setStatus: (text) => updateStatus(text),
        hotelMission: () => console.log('[reVC] Hotel mission (full version active)'),
        preRun: [
          () => {
            if (window.Module && window.Module._setFPSLimit) {
              window.Module._setFPSLimit(0);
            }
          },
        ],
        postRun: [
          () => {
            if (window.Module && window.Module._setFPSLimit) {
              window.Module._setFPSLimit(0);
            }
          },
        ],
        totalDependencies: 0,
        monitorRunDependencies: (num) => {
          Module.totalDependencies = Math.max(Module.totalDependencies, num);
          Module.setStatus(`Preparing… (${Module.totalDependencies - num}/${Module.totalDependencies})`);
        },

        instantiateWasm: async (info, receiveInstance) => {
          unlockAudio();
          const wasm = await fetchCached(WASM_URL);
          const module = await WebAssembly.instantiate(wasm, info);
          window.__wasmMemory = module.instance.exports.memory;
          return receiveInstance(module.instance, module);
        },

        // The runtime hands the package straight to loader.js, which slices it
        // into MEMFS using DATA_PACKAGE.
        getPreloadedPackage: () => {
          if (skin) applySkin(buffer, skin);
          return buffer.buffer;
        },

        mainCalled: () => {
          unlockAudio();
          // Do NOT pre-create /vc-assets/local/userfiles: the engine's IDBFS
          // mount hook does FS.mkdir(dir) itself and would throw EEXIST.
          try {
            const FS = Module.FS;
            if (prefetchedIntroAudio && prefetchedIntroAudio.length > 0) {
              try { FS.mkdirTree('/vc-assets/local/audio'); } catch (_) {}
              for (const entry of prefetchedIntroAudio) {
                try {
                  FS.writeFile(`/vc-assets/local/audio/${entry.name}`, entry.data);
                  console.log(`[reVC] Staged ${entry.name} into MEMFS for instant cutscene playback`);
                } catch (writeErr) {
                  console.warn(`[reVC] Failed to stage ${entry.name}:`, writeErr);
                }
              }
            }
            try {
              try { FS.unlink('/vc-assets/local/revc.ini'); } catch (e) {}
              FS.writeFile('/vc-assets/local/revc.ini', revc_ini);
            } catch (e) {}
            if (skin) {
              try {
                FS.writeFile('/vc-assets/local/models/gta3.img/player.txd', skin);
                // Patch gta3.dir sector count so engine allocates sufficient buffer
                try {
                  const dirPath = '/vc-assets/local/models/gta3.dir';
                  if (FS.analyzePath(dirPath).exists) {
                    const dirData = FS.readFile(dirPath);
                    const dataView = new DataView(dirData.buffer, dirData.byteOffset, dirData.byteLength);
                    const sectorSize = Math.ceil(skin.byteLength / 2048);
                    for (let i = 0; i < dirData.length; i += 32) {
                      let entryName = '';
                      for (let j = 0; j < 24; j++) {
                        const code = dirData[i + 8 + j];
                        if (code === 0) break;
                        entryName += String.fromCharCode(code);
                      }
                      if (entryName.toLowerCase() === 'player.txd') {
                        dataView.setUint32(i + 4, sectorSize, true);
                        FS.writeFile(dirPath, dirData);
                        console.log(`[reVC] Patched gta3.dir player.txd -> ${sectorSize} sectors`);
                        break;
                      }
                    }
                  }
                } catch (dirErr) {
                  console.warn('[reVC] gta3.dir patch error:', dirErr);
                }
                console.log('[reVC] custom skin written directly to MEMFS player.txd');
              } catch (e) {
                console.warn('[reVC] player.txd write failed:', e);
              }
            }
            stageBmpSkins(FS, bmpSkins, selectedSkinId);
          } catch (e) {
            console.warn('[reVC] pre-run setup:', e);
          }
          setTimeout(() => {
            // Cross-fade the loading overlay out rather than popping it.
            if (intro) {
              intro.style.transition = 'opacity 0.35s ease';
              intro.style.opacity = '0';
              setTimeout(() => intro.setAttribute('hidden', ''), 350);
            }
            setupGameHUD(canvas);
            if (window.Module && window.Module._setFPSLimit) {
              window.Module._setFPSLimit(0);
            }
            canvas.setAttribute('tabindex', '-1');
            canvas.focus({ preventScroll: true });
          }, 1200);
        },

        syncRevcIni: () => {
          try {
            const node = Module.FS.lookupPath('/vc-assets/local/revc.ini')?.node;
            if (node && node.contents) {
              localStorage.setItem('vcsky.revc.ini', new TextDecoder().decode(node.contents));
            }
          } catch (e) {}
        },
      };

      Module.log = Module.print;
      window.Module = Module;
        // The runtime has absolute upstream URLs baked into its build: its own
        // asset base, and one icon it fetches from a code host. Everything it
        // asks for outside the startup package (sound bank, radio, those files)
        // we already hold, so rewrite by path layout instead of matching those
        // hosts by name — and never let a request leave this origin, since the
        // page's CSP only permits same-origin connections anyway.
        let fetchLogs = 0;
        // Radio stations: the engine streams `audio/<station>.adf` on demand,
        // but the asset build (tools/build-vc-web-assets.py) publishes them as
        // `.mp3` -- the same bytes, since this runtime reads .adf as plain MP3
        // (the packaged flash.adf starts with an ID3 tag). Without this, every
        // station but Flash FM was silent and the engine retried the 404 in a
        // loop: ~13,000 requests per player session in the access log.
        const adfToMp3 = (u) =>
          u.replace(
            /(\/vc-assets\/local\/audio\/)([^/?#]+)\.adf(?=[?#]|$)/i,
            (_, dir, name) => `${dir}${name.toLowerCase()}.mp3`,
          );
        window.replaceFetch = (str) => adfToMp3(rewriteFetch(str));
        const rewriteFetch = (str) => {
          if (fetchLogs < 3) {
            console.log('[reVC] asset URL:', str);
            fetchLogs++;
          }
          if (!/^https?:\/\//i.test(str)) return str;
          let url;
          try {
            url = new URL(str);
          } catch (e) {
            return str;
          }
          if (url.origin === location.origin) return str;

          const p = url.pathname;
          const marker = '/fetched/';
          const fetched = p.indexOf(marker);
          if (fetched !== -1) {
            return '/vc-assets/local/' + p.slice(fetched + marker.length) + url.search;
          }
          if (p.endsWith('/ico.png')) {
            return '/vc-assets/local/icons/idle-phone.png';
          }
          // Unknown foreign path: keep the path, drop the origin. Serving it
          // from our own root either resolves it or 404s locally — either way
          // no request reaches a third party.
          return p + url.search;
        };


      updateStatus('Loading runtime environment…', 90);
      /**
       * Inject the module chain at most once per document.
       *
       * These modules are an Emscripten runtime: evaluating them twice re-runs
       * their module-level init (`expectedDataFileDownloads++`, the FS setup,
       * the package materialisation) and leaves the engine half-initialised,
       * which surfaces as a throw from native code — a bare pointer, not an
       * Error. Reaching this twice is easy: `isLaunching` is cleared when a
       * launch fails, so a player who taps Play again after a failure would
       * inject a second chain into the same document.
       *
       * The check is on the DOM rather than a local flag, so it also holds if
       * this loader is ever itself evaluated twice. The GTA III loader has had
       * this guard from the start; Vice City did not.
       */
      if (!document.querySelector('script[src^="games/vice-city/index.js"]')) {
        const script = document.createElement('script');
        script.async = true;
        script.src = vq('games/vice-city/index.js');
        document.body.appendChild(script);
      } else {
        console.warn('[reVC] module chain already injected; not loading it twice');
      }
    } catch (err) {
      console.error('[reVC] Fatal launch error:', err);
      window.GTALoaderUI.fail('Could not start Vice City: ' + err.message);
      isLaunching = false;
    }
  }


  /* ── Touch controls ────────────────────────────────────────────────────
   * Same scheme as the GTA III loader: an emulated gamepad is merged into
   * navigator.getGamepads, the left/right screen halves act as analog sticks
   * and the .touch-control buttons map to pad buttons. */
  const TOUCH_BTN = {
    A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
    BACK: 8, START: 9, L3: 10, R3: 11,
  };
  const TOUCH_BUTTONS = [
    ['.touch-control.run', TOUCH_BTN.A],        // sprint / accelerate
    ['.touch-control.fist', TOUCH_BTN.B],       // fire
    ['.touch-control.jump', TOUCH_BTN.X],       // jump / brake
    ['.touch-control.getIn', TOUCH_BTN.Y],      // enter-exit vehicle
    ['.touch-control.radio', TOUCH_BTN.LB],     // radio station
    ['.touch-control.drift', TOUCH_BTN.RB],     // handbrake / target
    ['.touch-control.weapon', TOUCH_BTN.RT],    // next weapon
    ['.touch-control.camera', TOUCH_BTN.BACK],  // camera view
    ['.touch-control.menu', TOUCH_BTN.START],   // pause
    ['.touch-control.horn', TOUCH_BTN.L3],      // horn / siren
    ['.touch-control.job', TOUCH_BTN.R3],       // submisssions
    ['.touch-control.fireLeft', [TOUCH_BTN.B, TOUCH_BTN.LT]],
    ['.touch-control.fireRight', [TOUCH_BTN.B, TOUCH_BTN.RT]],
  ];

  let touchEmulator = null;

  function installTouchControls() {
    document.body.dataset.isTouch = isTouch ? '1' : '0';
    if (!isTouch) return;
    if (typeof GamepadEmulator !== 'function') {
      console.warn('[reVC] GamepadEmulator not loaded — touch controls disabled');
      return;
    }
    if (touchEmulator) return;
    try {
      touchEmulator = new GamepadEmulator();
    } catch (err) {
      console.warn('[reVC] GamepadEmulator:', err && err.message ? err.message : err);
      return;
    }
    const pad = touchEmulator.AddEmulatedGamepad(null, true);
    if (!pad) {
      console.warn('[reVC] could not create the emulated pad');
      return;
    }
    const index = pad.index;

    for (const [id, xAxisIndex, yAxisIndex] of [['move', 0, 1], ['look', 2, 3]]) {
      const tapTarget = document.getElementById(id);
      if (!tapTarget) continue;
      touchEmulator.AddDisplayJoystickEventListeners(index, [{
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget,
        lockTargetWhilePressed: true,
        xAxisIndex,
        yAxisIndex,
      }]);
    }

    const configs = [];
    for (const [selector, buttonIndexes] of TOUCH_BUTTONS) {
      const tapTarget = document.querySelector(selector);
      if (!tapTarget) continue;
      const indexes = Array.isArray(buttonIndexes) ? buttonIndexes : [buttonIndexes];
      configs.push({
        buttonIndexes: indexes,
        type: 'onOff',
        lockTargetWhilePressed: false,
        tapTarget,
      });
    }
    touchEmulator.AddDisplayButtonEventListeners(index, configs);
    console.log('[reVC] touch controls enabled (emulated pad #' + index + ')');
  }

  window.__startViceCity = startViceCity;
  window.addEventListener('DOMContentLoaded', () => {
    // The launcher page owns #hero-launch-btn; only the in-canvas prompt is ours.
    document.getElementById('click-to-play-button')?.addEventListener('click', startViceCity);
  });
})();
