/**
 * In-page ghost cursor overlay.
 *
 * This is the whole trick: Pi drives a real headed browser, and we draw an
 * animated pointer *inside the page* so a human watching the window can see
 * where attention is going before anything happens. The real click still comes
 * from `page.mouse`, so events stay `isTrusted: true` and behave exactly like a
 * human's — we are annotating, never substituting.
 *
 * Injected via `page.addInitScript`, so it survives navigations. Built as a raw
 * string because it must run in the page realm, not ours: no template literals
 * or import syntax may leak in here.
 */

export const OVERLAY_SOURCE = String.raw`
(function () {
  if (window.__piCursor) return;

  var ID = '__pi_cursor__';
  var root = null, cursor = null, label = null, booted = false;
  var queue = [];
  var hideLabelTimer = null;

  var css = [
    '#' + ID + '{position:fixed;inset:0;pointer-events:none;z-index:2147483647}',
    '#' + ID + ' .cur{position:absolute;left:0;top:0;width:26px;height:26px;',
    'transform:translate3d(-100px,-100px,0);opacity:0;will-change:transform;',
    'transition:transform var(--cur-dur,340ms) cubic-bezier(.22,.61,.36,1),opacity 160ms ease;',
    'filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}',
    '#' + ID + ' .cur.on{opacity:1}',
    '#' + ID + ' .cur svg{display:block;overflow:visible}',
    '#' + ID + ' .lbl{position:absolute;left:0;top:0;transform:translate3d(-100px,-100px,0);',
    'max-width:340px;font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'letter-spacing:.01em;color:#eff6ff;background:#1d4ed8;padding:4px 8px;border-radius:6px;',
    'box-shadow:0 4px 14px rgba(2,6,23,.35),inset 0 0 0 1px rgba(255,255,255,.14);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;',
    'transition:opacity 160ms ease,transform 240ms cubic-bezier(.22,.61,.36,1)}',
    '#' + ID + ' .lbl.on{opacity:1}',
    '#' + ID + ' .rip{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;',
    'border:2.5px solid rgba(96,165,250,.95);box-shadow:0 0 0 1px rgba(255,255,255,.55),0 0 16px rgba(59,130,246,.75);',
    'animation:pi_rip 620ms cubic-bezier(.2,.7,.3,1) forwards}',
    '#' + ID + ' .rip.dbl{animation-duration:760ms;border-color:rgba(251,146,60,.95);',
    'box-shadow:0 0 0 1px rgba(255,255,255,.55),0 0 16px rgba(249,115,22,.75)}',
    '#' + ID + ' .box{position:absolute;border:2px solid rgba(59,130,246,.95);border-radius:5px;',
    'background:rgba(59,130,246,.10);box-shadow:0 0 0 1px rgba(255,255,255,.35),0 0 22px rgba(59,130,246,.35);',
    'animation:pi_box 220ms ease-out}',
    '#' + ID + ' .typ{position:absolute;height:2px;border-radius:2px;',
    'background:linear-gradient(90deg,rgba(96,165,250,0),rgba(96,165,250,.95),rgba(96,165,250,0));',
    'animation:pi_typ 900ms ease-in-out infinite}',
    '@keyframes pi_rip{from{transform:scale(.35);opacity:1}to{transform:scale(4.4);opacity:0}}',
    '@keyframes pi_box{from{transform:scale(1.06);opacity:0}to{transform:scale(1);opacity:1}}',
    '@keyframes pi_typ{0%,100%{opacity:.25}50%{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){',
    '#' + ID + ' .cur{transition-duration:1ms!important}',
    '#' + ID + ' .rip,#' + ID + ' .typ{animation:none}}'
  ].join('');

  function build() {
    if (booted || !document.documentElement) return;
    booted = true;

    var styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.documentElement.appendChild(styleEl);

    root = document.createElement('div');
    root.id = ID;

    cursor = document.createElement('div');
    cursor.className = 'cur';
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">' +
      '<path d="M5.5 2.5 L5.5 20.5 L10 16.2 L13.3 23 L16.6 21.4 L13.4 14.9 L19.6 14.6 Z" ' +
      'fill="#ffffff" stroke="#0b1220" stroke-width="1.7" stroke-linejoin="round"/></svg>';

    label = document.createElement('div');
    label.className = 'lbl';

    root.appendChild(cursor);
    root.appendChild(label);
    document.documentElement.appendChild(root);

    while (queue.length) {
      try { queue.shift()(); } catch (e) { /* never break the host page */ }
    }
  }

  function onBoot(fn) {
    if (booted) { try { fn(); } catch (e) {} }
    else queue.push(fn);
  }

  window.__piCursor = {
    ready: false,
    show: function () { return this; },
    hide: function () { return this; },
    setSpeed: function (ms) {
      onBoot(function () { root.style.setProperty('--cur-dur', ms + 'ms'); });
      return this;
    },
    move: function (x, y, opts) {
      var o = opts || {};
      onBoot(function () {
        if (o.duration != null) root.style.setProperty('--cur-dur', o.duration + 'ms');
        cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        cursor.classList.add('on');
      });
      if (o.label) this.label(o.label, x, y);
      return this;
    },
    label: function (t, x, y) {
      onBoot(function () {
        var vw = window.innerWidth || 1280;
        var vh = window.innerHeight || 720;
        label.textContent = t;
        var lx = Math.min(x + 16, vw - 210);
        var ly = y + 20 > vh - 34 ? y - 34 : y + 20;
        label.style.transform = 'translate3d(' + lx + 'px,' + ly + 'px,0)';
        label.classList.add('on');
        clearTimeout(hideLabelTimer);
        hideLabelTimer = setTimeout(function () { label.classList.remove('on'); }, 2200);
      });
      return this;
    },
    ripple: function (x, y, opts) {
      var o = opts || {};
      onBoot(function () {
        var r = document.createElement('div');
        r.className = 'rip' + (o.double ? ' dbl' : '');
        r.style.left = x + 'px';
        r.style.top = y + 'px';
        root.appendChild(r);
        setTimeout(function () { r.remove(); }, o.double ? 820 : 700);
      });
      return this;
    },
    highlight: function (x, y, w, h, opts) {
      var o = opts || {};
      onBoot(function () {
        var b = document.createElement('div');
        b.className = 'box';
        b.style.left = (x - 3) + 'px';
        b.style.top = (y - 3) + 'px';
        b.style.width = (w + 6) + 'px';
        b.style.height = (h + 6) + 'px';
        root.appendChild(b);
        setTimeout(function () { b.remove(); }, o.ttl || 1800);
      });
      return this;
    },
    typing: function (x, y, w) {
      onBoot(function () {
        var t = document.createElement('div');
        t.className = 'typ';
        t.style.left = x + 'px';
        t.style.top = y + 'px';
        t.style.width = Math.max(24, w) + 'px';
        root.appendChild(t);
        setTimeout(function () { t.remove(); }, 4000);
      });
      return this;
    },
    clear: function () {
      onBoot(function () {
        root.querySelectorAll('.rip,.box,.typ').forEach(function (n) { n.remove(); });
        label.classList.remove('on');
      });
      return this;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build, { once: true });
  } else {
    build();
  }
  build();
})();
`;

/**
 * Scroll/resize proof: absolute offsets inside a scrolling page are relative to
 * the document, but our overlay is `position: fixed`. Convert page coords to
 * viewport coords so the pointer lands where the human eye expects it.
 */
export function toViewport(pageX, pageY, scrollX, scrollY) {
  return { x: Math.round(pageX - scrollX), y: Math.round(pageY - scrollY) };
}
