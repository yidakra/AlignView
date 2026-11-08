/* Guided onboarding tour (coach marks) for first-time participants.
 *
 * Two phases, because most of the interface only exists after a first answer:
 *   1. "start"  — on an empty thread: welcome, the top-bar labels, the question
 *                 box and Send.
 *   2. "answer" — once the first answer has rendered (watched with a
 *                 MutationObserver): answer, support label, citation chip,
 *                 evidence moments, cameras, match scores, review buttons and
 *                 the refine box. Steps whose target is missing are skipped.
 *
 * Each step dims the page, cuts a spotlight around the target and shows a
 * dialog with Back / Next / Skip tour. Esc skips, Tab stays inside the dialog,
 * focus returns to where it was afterwards. A finished or skipped phase is
 * remembered in localStorage and never re-runs on its own; the top-bar
 * #tour-button restarts the phase that fits the screen. Pure vanilla JS,
 * auto-loaded by Dash from the assets/ folder.
 */
(function () {
  "use strict";

  var KEY_PREFIX = "alignview.tour.v1.";
  var MOBILE_MAX = 600; // px — at or below this the dialog is a bottom sheet
  var GAP = 12; // px — space between the spotlight and the dialog
  var EDGE = 12; // px — minimum distance from the viewport edge
  var PAD = 6; // px — spotlight padding around the target

  // ---- steps -------------------------------------------------------------

  function lastCard() {
    var cards = document.querySelectorAll(".group-card");
    return cards.length ? cards[cards.length - 1] : null;
  }

  function inLastCard(sel) {
    var c = lastCard();
    return c ? c.querySelector(sel) : null;
  }

  function byId(id) {
    return function () {
      return document.getElementById(id);
    };
  }

  function modeIsOffline() {
    var b = document.getElementById("mode-badge");
    return !!b && /offline/i.test(b.textContent || "");
  }

  var PHASES = {
    start: [
      {
        title: "Welcome",
        body:
          "You’ll ask questions about the CASTLE 2024 recordings and check " +
          "each answer against the video. This short tour shows you where " +
          "things are.",
      },
      {
        // The day / cameras / mode badges (not the buttons beside them).
        target: function () {
          var b = document.getElementById("mode-badge");
          if (!b || !b.parentElement) return null;
          return Array.prototype.filter.call(
            b.parentElement.children,
            function (c) {
              return c.classList.contains("mantine-Badge-root");
            }
          );
        },
        title: "What you’re searching",
        body: function () {
          return (
            "These labels show the recording day and how many cameras are " +
            "searched. " +
            (modeIsOffline()
              ? "“Offline” means the answers are sample data, not real results."
              : "“Live” means answers come from the real recordings.")
          );
        },
      },
      {
        target: byId("new-question-input"),
        title: "Ask a question",
        body:
          "Type a question about what happened in the recordings, for " +
          "example who did something or when it happened.",
      },
      {
        target: byId("ask-new-button"),
        title: "Send it",
        body:
          "Once you’ve typed a question, select Send or press Enter. When " +
          "the answer appears, the tour continues and shows you how to " +
          "check it.",
        focusOnDone: "new-question-input",
      },
    ],
    answer: [
      {
        target: function () {
          return inLastCard(".answer-text");
        },
        title: "Read the answer",
        body:
          "This is the answer to your question, written from what was found " +
          "in the recordings. Your job is to check it against the video.",
      },
      {
        target: function () {
          return inLastCard(".support-badge");
        },
        title: "How well it’s supported",
        body:
          "This label shows how strongly the evidence backs the answer: " +
          "well supported, partial support or low confidence.",
      },
      {
        target: function () {
          return inLastCard(".cite-chip");
        },
        title: "Jump to a moment",
        body:
          "Each chip names a person and a time in the recording. Select one " +
          "to open that moment in the viewer.",
      },
      {
        target: function () {
          return inLastCard(".moment-list");
        },
        title: "Evidence moments",
        body:
          "These are the moments that best match your question, best first. " +
          "Select one to watch it.",
      },
      {
        target: byId("camera-grid"),
        title: "One moment, several cameras",
        body:
          "Each video shows the same moment from a different camera, playing " +
          "in sync. Compare what each one saw.",
      },
      {
        target: function () {
          return document.querySelector(".evidence-figure-wrap");
        },
        title: "Match scores",
        body:
          "The bars show how closely each camera matches your question. The " +
          "grid below shows how much the cameras agree with each other.",
      },
      {
        target: byId("review-row"),
        title: "Judge each camera",
        body:
          "Mark a camera Confirm if it shows what the answer says, Refine if " +
          "it’s close but not quite, or Ignore if it isn’t relevant. Once " +
          "every camera is marked, submit to get a suggested follow-up question.",
      },
      {
        target: byId("compose-wrap"),
        title: "Refine your question",
        body:
          "This is a suggested follow-up question based on your reviews. " +
          "Edit it if you like, then run the refined search.",
      },
    ],
  };

  // ---- storage (every access guarded: the page must work without it) ------

  // Also kept in memory so a blocked storage can't make a phase re-run on
  // every DOM change within the same page load.
  var finished = {};

  function isDone(phase) {
    if (finished[phase]) return true;
    try {
      return window.localStorage.getItem(KEY_PREFIX + phase) === "done";
    } catch (e) {
      return false;
    }
  }

  function markDone(phase) {
    finished[phase] = true;
    try {
      window.localStorage.setItem(KEY_PREFIX + phase, "done");
    } catch (e) {
      /* storage unavailable: the tour simply may show again */
    }
  }

  // ---- helpers -------------------------------------------------------------

  function reducedMotion() {
    return (
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function isMobile() {
    return window.innerWidth <= MOBILE_MAX;
  }

  // A target is one element or a list of them (highlighted as one box).
  function list(t) {
    if (!t) return [];
    return t.length === undefined || t.nodeType ? [t] : t;
  }

  function visible(t) {
    var items = list(t);
    if (!items.length) return false;
    return items.every(function (el) {
      if (!el || !el.isConnected || el.closest("[hidden]")) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function rectOf(t) {
    var box = null;
    list(t).forEach(function (el) {
      var r = el.getBoundingClientRect();
      box = box
        ? {
            top: Math.min(box.top, r.top),
            left: Math.min(box.left, r.left),
            bottom: Math.max(box.bottom, r.bottom),
            right: Math.max(box.right, r.right),
          }
        : { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    });
    return box;
  }

  function resolve(v) {
    return typeof v === "function" ? v() : v;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // ---- tour state ----------------------------------------------------------

  var state = null; // {phase, steps, index, seen, returnFocus, nodes}
  var rafPending = false;

  function buildNodes() {
    var root = el("div", "tour-root");
    var backdrop = el("div", "tour-backdrop");
    var spot = el("div", "tour-spotlight");
    spot.setAttribute("aria-hidden", "true");
    backdrop.setAttribute("aria-hidden", "true");

    var dialog = el("div", "tour-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "tour-title");
    dialog.setAttribute("aria-describedby", "tour-body");
    dialog.tabIndex = -1;

    var count = el("p", "tour-count");
    count.id = "tour-count";
    var title = el("h2", "tour-title");
    title.id = "tour-title";
    var body = el("p", "tour-body");
    body.id = "tour-body";

    var actions = el("div", "tour-actions");
    var skip = el("button", "tour-btn tour-btn-skip", "Skip tour");
    skip.type = "button";
    var nav = el("div", "tour-nav");
    var back = el("button", "tour-btn tour-btn-back", "Back");
    back.type = "button";
    var next = el("button", "tour-btn tour-btn-next", "Next");
    next.type = "button";
    nav.appendChild(back);
    nav.appendChild(next);
    actions.appendChild(skip);
    actions.appendChild(nav);

    dialog.appendChild(count);
    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(actions);

    // Announces each step to screen readers; focus stays on the Next button.
    // Inside the dialog, since aria-modal hides everything outside it.
    var live = el("div", "tour-sr-only");
    live.setAttribute("aria-live", "polite");
    dialog.appendChild(live);

    root.appendChild(backdrop);
    root.appendChild(spot);
    root.appendChild(dialog);

    skip.addEventListener("click", function () {
      finish(false);
    });
    back.addEventListener("click", function () {
      go(-1);
    });
    next.addEventListener("click", function () {
      go(1);
    });
    // Clicks on the dimmed page do nothing (no accidental dismissal).
    backdrop.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    return {
      root: root,
      spot: spot,
      dialog: dialog,
      count: count,
      title: title,
      body: body,
      back: back,
      next: next,
      skip: skip,
      live: live,
    };
  }

  function start(phase) {
    if (state) return;
    // Steps are checked for a target as the tour reaches them, so parts Dash
    // renders a moment later are not dropped up front.
    var steps = PHASES[phase];
    var first = nextAvailable(steps, -1, 1);
    if (first < 0) return;

    var nodes = buildNodes();
    if (reducedMotion()) nodes.root.classList.add("tour-reduced");
    document.body.appendChild(nodes.root);
    state = {
      phase: phase,
      steps: steps,
      index: 0,
      seen: {},
      returnFocus: document.activeElement,
      nodes: nodes,
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    // Next frame so the enter transition runs from the initial state.
    requestAnimationFrame(function () {
      if (state) nodes.root.classList.add("tour-open");
    });
    show(first);
  }

  function available(step) {
    return !step.target || visible(resolve(step.target));
  }

  // Index of the next step from `from` in direction `dir` whose target is on
  // screen, or -1 when there is none.
  function nextAvailable(steps, from, dir) {
    for (var j = from + dir; j >= 0 && j < steps.length; j += dir) {
      if (available(steps[j])) return j;
    }
    return -1;
  }

  function finish(completed) {
    if (!state) return;
    var s = state;
    var last = s.steps[s.index];
    state = null;
    markDone(s.phase);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    s.nodes.root.remove();

    var focusId = completed && last && last.focusOnDone;
    var preferred = focusId ? document.getElementById(focusId) : null;
    [preferred, s.returnFocus].some(function (t) {
      if (!t || !t.isConnected || t === document.body) return false;
      try {
        t.focus({ preventScroll: true });
      } catch (e) {
        return false; /* element no longer focusable */
      }
      return document.activeElement === t;
    });
    if (bothDone()) stopWatching();
  }

  function go(delta) {
    if (!state) return;
    var i = nextAvailable(state.steps, state.index, delta);
    if (i < 0) {
      if (delta > 0) finish(true);
      return;
    }
    show(i);
  }

  function show(i) {
    var n = state.nodes;
    var steps = state.steps;
    var step = steps[i];
    state.index = i;
    var isLast = nextAvailable(steps, i, 1) < 0;
    // Count every step that has had a target at some point this run, so the
    // total only grows (a late-rendered target) and never flickers when one
    // re-renders; on the last step it shrinks to what was actually shown.
    steps.forEach(function (s, j) {
      if (j === i || available(s)) state.seen[j] = true;
    });
    var counted = steps.filter(function (s, j) {
      return state.seen[j] && (!isLast || j <= i);
    });
    var pos = counted.indexOf(step);

    n.count.textContent = "Step " + (pos + 1) + " of " + counted.length;
    n.title.textContent = resolve(step.title);
    n.body.textContent = resolve(step.body);
    n.back.hidden = nextAvailable(steps, i, -1) < 0;
    n.next.textContent = isLast ? "Done" : "Next";
    n.live.textContent = n.count.textContent + ": " + n.title.textContent;

    var target = step.target ? resolve(step.target) : null;
    state.target = visible(target) ? target : null;

    if (state.target) scrollToTarget(list(state.target)[0]);
    // Restart the dialog's enter transition for each step.
    n.dialog.classList.remove("tour-in");
    void n.dialog.offsetWidth;
    n.dialog.classList.add("tour-in");

    position();
    n.next.focus({ preventScroll: true });
  }

  // Vertical-only scrollIntoView: scrollIntoView() would also scroll any
  // horizontally overflowing ancestor and leave the page shifted sideways.
  function scrollToTarget(target) {
    var behavior = reducedMotion() ? "auto" : "smooth";
    var start = isMobile();
    var shift = 0; // how far earlier scrolls moved the target up
    var node = target.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      var oy = getComputedStyle(node).overflowY;
      var room = node.scrollHeight - node.clientHeight;
      if ((oy === "auto" || oy === "scroll") && room > 1) {
        var nr = node.getBoundingClientRect();
        shift += scrollBox(nr.top, nr.height, node.scrollTop, room, function (d) {
          node.scrollBy({ top: d, behavior: behavior });
        });
      }
      node = node.parentElement;
    }
    var page = document.scrollingElement || document.documentElement;
    var pageRoom = page.scrollHeight - window.innerHeight;
    if (pageRoom > 1) {
      scrollBox(0, window.innerHeight, window.scrollY, pageRoom, function (d) {
        window.scrollBy({ top: d, behavior: behavior });
      });
    }

    // Scroll one box so the target is centred in it (or near its top on
    // phones, and for targets too tall to centre); returns the distance.
    function scrollBox(boxTop, boxHeight, scrolled, room, apply) {
      var r = target.getBoundingClientRect();
      var top = r.top - shift;
      var d =
        start || r.height > boxHeight * 0.8
          ? top - boxTop - 16
          : top + r.height / 2 - (boxTop + boxHeight / 2);
      d = Math.max(-scrolled, Math.min(d, room - scrolled));
      if (Math.abs(d) >= 1) apply(d);
      return d;
    }
  }

  function schedule() {
    if (rafPending || !state) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      position();
    });
  }

  // ---- geometry ------------------------------------------------------------

  function position() {
    if (!state) return;
    var n = state.nodes;
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var mobile = isMobile();
    n.root.classList.toggle("tour-sheet", mobile);

    var target = state.target;
    if (target && !visible(target)) {
      // Dash may have re-rendered the target; look it up again.
      var step = state.steps[state.index];
      var fresh = resolve(step.target);
      target = state.target = visible(fresh) ? fresh : null;
    }

    var spot = null;
    if (target) {
      var r = rectOf(target);
      var top = Math.max(r.top - PAD, 4);
      var left = Math.max(r.left - PAD, 4);
      var bottom = Math.min(r.bottom + PAD, vh - 4);
      var right = Math.min(r.right + PAD, vw - 4);
      if (bottom > top && right > left) {
        spot = { top: top, left: left, width: right - left, height: bottom - top };
      }
    }
    n.root.classList.toggle("tour-centered", !spot);
    if (spot) {
      n.spot.hidden = false;
      n.spot.style.top = spot.top + "px";
      n.spot.style.left = spot.left + "px";
      n.spot.style.width = spot.width + "px";
      n.spot.style.height = spot.height + "px";
      // Small targets (a citation chip) get a tighter corner.
      n.spot.style.borderRadius = Math.min(14, spot.height / 2) + "px";
    } else {
      n.spot.hidden = true;
    }

    var d = n.dialog;
    d.style.top = d.style.left = d.style.bottom = "";
    if (mobile) {
      // Bottom sheet; flips to the top when it would cover the target.
      var sh = d.offsetHeight;
      var covers = spot && spot.top + spot.height > vh - sh - GAP;
      var fitsAbove = spot && spot.top > sh + GAP;
      d.classList.toggle("tour-sheet-top", !!(covers && fitsAbove));
      return;
    }
    if (!spot) return; // centered by CSS

    var pw = d.offsetWidth;
    var ph = d.offsetHeight;
    var cx = spot.left + spot.width / 2 - pw / 2;
    var cy = spot.top + spot.height / 2 - ph / 2;
    var candidates = [
      { top: spot.top + spot.height + GAP, left: cx }, // below
      { top: spot.top - GAP - ph, left: cx }, // above
      { top: cy, left: spot.left + spot.width + GAP }, // right
      { top: cy, left: spot.left - GAP - pw }, // left
    ];
    var pick = null;
    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      var vertical = k < 2;
      var fits = vertical
        ? c.top >= EDGE && c.top + ph <= vh - EDGE
        : c.left >= EDGE && c.left + pw <= vw - EDGE;
      if (fits) {
        pick = c;
        break;
      }
    }
    // Nothing fits beside a large target: overlay its lower edge instead.
    if (!pick) pick = { top: vh - ph - EDGE * 2, left: cx };
    var clampedLeft = Math.min(Math.max(pick.left, EDGE), vw - pw - EDGE);
    var clampedTop = Math.min(Math.max(pick.top, EDGE), vh - ph - EDGE);
    d.style.left = Math.round(clampedLeft) + "px";
    d.style.top = Math.round(clampedTop) + "px";
  }

  // ---- keyboard ------------------------------------------------------------

  function onKey(e) {
    if (!state) return;
    var n = state.nodes;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if (e.key === "Tab") {
      // Keep focus inside the dialog.
      var items = [n.skip, n.back, n.next].filter(function (b) {
        return !b.hidden;
      });
      var first = items[0];
      var last = items[items.length - 1];
      var active = document.activeElement;
      if (!n.dialog.contains(active)) {
        e.preventDefault();
        n.next.focus();
      } else if (e.shiftKey && (active === first || active === n.dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(e.key === "ArrowRight" ? 1 : -1);
    }
  }

  // ---- triggers ------------------------------------------------------------

  function answerOnScreen() {
    return !!document.querySelector(".group-card .answer-text");
  }

  // Wait until the DOM has been quiet for a moment (Dash renders the thread,
  // then the camera grid and chart in follow-up callbacks) before starting.
  var settleTimer = null;
  var settleSince = 0;
  var SETTLE_MS = 700;
  var SETTLE_MAX_MS = 4000;

  function check() {
    if (state) return;
    var phase = null;
    if (answerOnScreen()) {
      if (!isDone("answer")) phase = "answer";
    } else if (document.getElementById("new-question-input")) {
      if (!isDone("start")) phase = "start";
    }
    if (!phase) {
      clearTimeout(settleTimer);
      settleTimer = null;
      return;
    }
    var now = Date.now();
    if (!settleTimer) settleSince = now;
    clearTimeout(settleTimer);
    var wait = Math.max(0, Math.min(SETTLE_MS, settleSince + SETTLE_MAX_MS - now));
    settleTimer = setTimeout(function () {
      settleTimer = null;
      if (state) return;
      // Re-evaluate: the screen may have changed while we waited.
      if (phase === "answer" && answerOnScreen() && !isDone("answer")) {
        start("answer");
      } else if (phase === "start" && !answerOnScreen() && !isDone("start")) {
        start("start");
      }
    }, wait);
  }

  var observer = null;

  function bothDone() {
    return isDone("start") && isDone("answer");
  }

  // Nothing left to start automatically: stop watching the DOM. The Tour
  // button keeps working without it.
  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function init() {
    // Our own overlay changes the DOM too; ignore mutations while it is open.
    if (!bothDone()) {
      observer = new MutationObserver(function () {
        if (!state) check();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      check();
    }

    document.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("#tour-button") : null;
      if (!b || state) return;
      clearTimeout(settleTimer);
      settleTimer = null;
      start(answerOnScreen() ? "answer" : "start");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
