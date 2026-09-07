// The reading view's own half: pagination, taps, and what it reports back.
//
// It lives inside the book's document rather than in the client around it,
// because everything it does needs the laid-out text: how many pages this
// chapter is at this font size is a question only the engine that broke it into
// columns can answer.
//
// The client talks to it through `window.Reader` and hears back through
// `window.SonorusReader`, an interface the Android app adds. Without that
// object the calls are simply skipped, so the same file works in a browser.

(function () {
  'use strict';

  var body = document.body;
  var page = 0;
  var pages = 1;

  function step() {
    // One page is the viewport, gap included - which is what the column rule
    // above adds up to.
    return window.innerWidth;
  }

  function measure() {
    var width = body.scrollWidth;
    pages = Math.max(1, Math.round(width / step()));
    if (page > pages - 1) page = pages - 1;
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

  var Reader = {
    /** One page on. Answers false at the end, where the next chapter begins. */
    next: function () {
      if (page >= pages - 1) return false;
      page += 1;
      draw(true);
      report('turn');
      return true;
    },

    previous: function () {
      if (page <= 0) return false;
      page -= 1;
      draw(true);
      report('turn');
      return true;
    },

    /** Where the reader was, as a share of the chapter. */
    goToRatio: function (value) {
      var at = Math.max(0, Math.min(1, Number(value) || 0));
      page = Math.round(at * (pages - 1));
      draw(false);
      report('seek');
    },

    /** The last page, which is where a chapter entered backwards begins. */
    goToEnd: function () {
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
      // The text is re-broken, so where the reader was has to be kept as a
      // share and put back afterwards rather than as a page number.
      var was = ratio();
      relayout(function () {
        page = Math.round(was * (pages - 1));
        draw(false);
        report('style');
      });
    },

    state: function () {
      return JSON.stringify({ page: page, pages: pages, ratio: ratio() });
    },

    /** How much text this chapter holds, for the estimate of a page number. */
    characters: function () {
      return (body.innerText || body.textContent || '').length;
    },
  };

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

  // Left third back, right third on, the middle for the controls. The same
  // division every reader uses, and the only one that needs no explaining.
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

  // A swipe does the same as a tap on the side. Vertical movement is left
  // alone: there is nothing to scroll, so it can only be a scroll that was
  // meant for something else.
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
    var was = ratio();
    relayout(function () {
      page = Math.round(was * (pages - 1));
      draw(false);
      report('resize');
    });
  });

  window.Reader = Reader;

  // Ready is reported once the text has been broken, not once the DOM is
  // parsed: a client that asked for the page count in between would get 1.
  function ready() {
    relayout(function () {
      draw(false);
      report('ready');
    });
  }

  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready);
})();
