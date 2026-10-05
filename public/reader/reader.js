// Pagination and taps, inside the book's document because only it knows the laid-out text.
// The client calls `window.Reader` and hears back through `window.SonorusReader`, added by
// the Android app or by public/js/reading.js; without it the callbacks are skipped.

(function () {
  'use strict';

  var body = document.body;
  var page = 0;
  var pages = 1;

  // Until the first layout `pages` is 1, so turning a share into a page has to wait.
  var measured = false;

  // A share still to be landed on. It outlives relayouts because the client asks for the
  // stored place while the text is one column wide, which would always give page 0.
  var pending = null;

  // A page count against the fallback font is wrong: Ubuntu arrives after the text does.
  var fontsReady = false;
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      fontsReady = true;
    });
  } else {
    fontsReady = true;
  }

  function step() {
    // One page is the viewport, gap included - what the column rule in reader.css adds up to.
    return window.innerWidth;
  }

  function measure() {
    var width = body.scrollWidth;
    pages = Math.max(1, Math.round(width / step()));
    measured = true;
    if (page > pages - 1) page = pages - 1;
  }

  function pageOf(share) {
    return Math.max(0, Math.min(pages - 1, Math.round(share * (pages - 1))));
  }

  function draw(animated) {
    body.classList.toggle('sonorus-turning', !!animated);
    body.style.transform = 'translateX(' + -page * step() + 'px)';
  }

  function ratio() {
    return pages > 1 ? page / (pages - 1) : 0;
  }

  function report(reason) {
    if (!window.SonorusReader || !window.SonorusReader.onState) return;
    window.SonorusReader.onState(
      JSON.stringify({ page: page, pages: pages, ratio: ratio(), reason: reason || '' })
    );
  }

  // A relayout has to be measured after the engine has done it, and one frame
  // is not always enough on a font that has just arrived.
  function relayout(then) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        measure();
        if (then) then();
      });
    });
  }

  /**
   * A pending share wins over the place on screen: the client asked for it, while the
   * place on screen is only where the previous layout left things.
   */
  function settle(reason) {
    var was = ratio();
    relayout(function () {
      page = pageOf(pending !== null ? pending : was);
      pending = null;
      draw(false);
      report(reason);
    });
  }

  var Reader = {
    /** One page on. Answers false at the end, where the next chapter begins. */
    next: function () {
      if (page >= pages - 1) return false;
      pending = null;
      page += 1;
      draw(true);
      report('turn');
      return true;
    },

    previous: function () {
      if (page <= 0) return false;
      pending = null;
      page -= 1;
      draw(true);
      report('turn');
      return true;
    },

    /** Before the first layout this is only remembered; the last share wins. */
    goToRatio: function (value) {
      var at = Math.max(0, Math.min(1, Number(value) || 0));
      // Remembered even when granted at once: the client sets place and font together, and
      // a relayout already on its way would otherwise put the old page back.
      pending = at;
      if (!measured) return;
      page = pageOf(at);
      draw(false);
      report('seek');
    },

    /** The last page, which is where a chapter entered backwards begins. */
    goToEnd: function () {
      pending = 1;
      if (!measured) return;
      page = pages - 1;
      draw(false);
      report('seek');
    },

    style: function (values) {
      var root = document.documentElement;
      var names = {
        ink: '--reader-ink',
        bg: '--reader-bg',
        dim: '--reader-dim',
        accent: '--reader-accent',
        font: '--reader-font',
        size: '--reader-size',
        leading: '--reader-leading',
        padV: '--reader-pad-v',
        padH: '--reader-pad-h',
      };
      Object.keys(values || {}).forEach(function (key) {
        if (names[key]) root.style.setProperty(names[key], values[key]);
      });
      // The text is re-broken, so the place is kept as a share, not a page number.
      settle('style');
    },

    /** The page of the whole book, which only the client can count: this is one chapter. */
    footer: function (text) {
      var el = document.getElementById('sonorus-foot');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sonorus-foot';
        // Not in <body>: a fixed child of the transformed body would slide with the pages.
        document.documentElement.appendChild(el);
      }
      el.textContent = text == null ? '' : String(text);
    },

    state: function () {
      return JSON.stringify({ page: page, pages: pages, ratio: ratio() });
    },

    /**
     * Synchronous, because a view that is not drawn gets no animation frames. `fonts` false
     * means the count used the fallback typeface and is not worth keeping.
     */
    measureNow: function () {
      measure();
      return JSON.stringify({
        page: page,
        pages: pages,
        ratio: ratio(),
        fonts: fontsReady,
      });
    },

    /** How much text this chapter holds, for the estimate of a page number. */
    characters: function () {
      return (body.innerText || body.textContent || '').length;
    },
  };

  // Left third back, right third on, the middle for the controls.
  document.addEventListener(
    'click',
    function (event) {
      var link = event.target.closest && event.target.closest('a[href]');
      if (link) {
        event.preventDefault();
        if (window.SonorusReader && window.SonorusReader.onLink) {
          window.SonorusReader.onLink(link.getAttribute('href'));
        }
        return;
      }
      var third = window.innerWidth / 3;
      if (event.clientX < third) {
        if (!Reader.previous() && window.SonorusReader && window.SonorusReader.onEdge) {
          window.SonorusReader.onEdge('start');
        }
      } else if (event.clientX > window.innerWidth - third) {
        if (!Reader.next() && window.SonorusReader && window.SonorusReader.onEdge) {
          window.SonorusReader.onEdge('end');
        }
      } else if (window.SonorusReader && window.SonorusReader.onTap) {
        window.SonorusReader.onTap();
      }
    },
    true
  );

  // A vertical drag is ignored: nothing here scrolls. The host must not claim horizontal
  // drags while a book is open, or they open its navigation drawer instead.
  var startX = 0;
  var startY = 0;
  document.addEventListener('touchstart', function (e) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var touch = e.changedTouches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) {
      if (!Reader.next() && window.SonorusReader && window.SonorusReader.onEdge) {
        window.SonorusReader.onEdge('end');
      }
    } else if (!Reader.previous() && window.SonorusReader && window.SonorusReader.onEdge) {
      window.SonorusReader.onEdge('start');
    }
  }, { passive: true });

  window.addEventListener('resize', function () {
    settle('resize');
  });

  window.Reader = Reader;

  // Ready is reported once the text has been broken, not once the DOM is
  // parsed: a client that asked for the page count in between would get 1.
  function ready() {
    relayout(function () {
      page = pageOf(pending !== null ? pending : 0);
      pending = null;
      draw(false);
      report('ready');
    });
  }

  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready);
})();
