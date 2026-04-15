// ---------------------------------------------------------------------------
// sweetzai.com landing script
//
// Responsibilities:
//   1. ONE coinflip per page load — picks missionary OR blowjob GLOBALLY,
//      then both cards (Realistic + Anime) show that same pose variation.
//      Never mixed (looks incoherent). If a variation's media is missing
//      (e.g. blowjob clips not generated yet) we fall back to missionary.
//   2. Preserve all UTM / click-id params across the domain hop to sweetz.ai
//      — plus the FirstPromoter cookie → forwarded as ?fpr= so sweetz.ai's
//      middleware picks up the affiliate credit after the redirect.
//   3. Rewrite card + login hrefs with the full param set BEFORE any click,
//      so even middle-click / copy-link / right-click → open preserves
//      attribution (not just the JS-intercepted left click).
//   4. Fire fire-and-forget "landing_view" + "style_click" beacons to
//      https://sweetz.ai/api/landing-event — uses sendBeacon with a
//      text/plain Blob to avoid CORS preflight (the server parses JSON
//      manually). Silent-fail so a broken endpoint never breaks the flow.
//   5. Persist first-touch attribution in localStorage + first-party cookies
//      so returning visitors still get credited to the original source.
//
// Zero dependencies. Ships to Vercel as static files.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────────
  // Where the media lives. Animated WebP files served by Vercel from
  // marketing-assets/landing-site/public/media/.
  const MEDIA_BASE = "/media";
  const MEDIA_EXT = "webp";

  // Which variations currently have media on disk. When blowjob clips are
  // generated later, flip MEDIA_AVAILABLE.blowjob = true and drop the files
  // into public/media/ — no other code change needed.
  const MEDIA_AVAILABLE = {
    missionary: true,
    blowjob: false,
  };

  // Where the main app wizard lives. ?style= is read by src/app/(main)/create/page.tsx
  const APP_CREATE_URL = "https://sweetz.ai/create";
  const APP_LOGIN_URL = "https://sweetz.ai/login";

  // Attribution params we always forward across the domain hop
  const FORWARD_PARAMS = [
    "via",
    "ref",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fpr",
    "fbclid",
    "twclid",
    "gclid",
    "rdt_cid",
    "ttclid",
    "msclkid",
  ];

  // ── Helpers ────────────────────────────────────────────────────────────
  function pickVariation() {
    const available = Object.keys(MEDIA_AVAILABLE).filter(function (v) {
      return MEDIA_AVAILABLE[v];
    });
    if (available.length === 0) return "missionary";
    return available[Math.floor(Math.random() * available.length)];
  }

  function buildMediaSrc(style, variation) {
    return MEDIA_BASE + "/" + style + "_" + variation + "." + MEDIA_EXT;
  }

  function setCookie(name, value, days) {
    try {
      const d = new Date();
      d.setTime(d.getTime() + days * 864e5);
      document.cookie =
        name +
        "=" +
        encodeURIComponent(value) +
        "; expires=" +
        d.toUTCString() +
        "; path=/; SameSite=Lax" +
        (location.protocol === "https:" ? "; Secure" : "");
    } catch (e) {
      /* cookies blocked */
    }
  }

  function getCookie(name) {
    try {
      const m = document.cookie.match(
        new RegExp("(?:^|; )" + name + "=([^;]*)")
      );
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  // Path-based short link support. sweetzai.com/<slug> is rewritten by
  // vercel.json to /index.html (browser URL stays /<slug>), and we read
  // the slug off the pathname here so it flows through the same
  // attribution pipeline as ?via=<slug>. An explicit ?via= in the query
  // string always wins over the path slug.
  function getPathSlug() {
    try {
      const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
      if (!path) return null;
      if (/^[a-zA-Z0-9_-]{1,40}$/.test(path)) return path;
      return null;
    } catch (e) {
      return null;
    }
  }

  function getIncomingParams() {
    const q = new URLSearchParams(window.location.search);
    const o = {};
    FORWARD_PARAMS.forEach(function (k) {
      const v = q.get(k);
      if (v) o[k] = v;
    });
    if (!o.via) {
      const slug = getPathSlug();
      if (slug) o.via = slug;
    }
    return o;
  }

  // ── First-touch attribution capture ────────────────────────────────────
  const incoming = getIncomingParams();
  let stored = null;
  try {
    const raw = localStorage.getItem("sweetz_acquisition");
    if (raw) stored = JSON.parse(raw);
  } catch (e) {}

  const acquisition = stored || {
    referrer: document.referrer || null,
    landing: "sweetzai.com",
    ts: Date.now(),
  };
  // Fill gaps from current query (first-touch wins for existing keys)
  Object.keys(incoming).forEach(function (k) {
    if (!acquisition[k]) acquisition[k] = incoming[k];
  });

  const hasSignal =
    Object.keys(incoming).length > 0 || !!document.referrer;
  if (hasSignal) {
    try {
      localStorage.setItem(
        "sweetz_acquisition",
        JSON.stringify(acquisition)
      );
    } catch (e) {}
    const src =
      incoming.via ||
      incoming.ref ||
      incoming.utm_source ||
      "sweetzai";
    setCookie("sweetz_src", src, 30);
    setCookie("sweetz_attr", JSON.stringify(acquisition), 30);
  } else {
    setCookie("sweetz_src", "sweetzai", 30);
  }

  // ── Build forward URL for all sweetz.ai links ─────────────────────────
  function buildForwardUrl(baseUrl, extra) {
    const u = new URL(baseUrl);
    const merged = {};

    // 1. Stored first-touch attribution
    if (stored) {
      FORWARD_PARAMS.forEach(function (k) {
        if (stored[k]) merged[k] = stored[k];
      });
    }
    // 2. Current URL params (higher priority than stored)
    Object.keys(incoming).forEach(function (k) {
      merged[k] = incoming[k];
    });
    // 3. Auto-tag source/medium if nothing set yet
    if (!merged.utm_source) merged.utm_source = "sweetzai";
    if (!merged.utm_medium) merged.utm_medium = "landing";
    // 4. FirstPromoter cookie → forward as ?fpr= so sweetz.ai middleware
    //    can pick up the affiliate credit
    const fpTid = getCookie("_fprom_tid");
    if (fpTid && !merged.fpr) merged.fpr = fpTid;
    // 5. Caller-specific extras (e.g. style=realistic, variation=missionary)
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        merged[k] = extra[k];
      });
    }

    Object.keys(merged).forEach(function (k) {
      if (merged[k] != null && merged[k] !== "") {
        u.searchParams.set(k, merged[k]);
      }
    });
    return u.toString();
  }

  // ── Analytics beacon ───────────────────────────────────────────────────
  function fireEvent(name, payload) {
    try {
      const body = JSON.stringify(
        Object.assign({ event: name, ts: Date.now() }, payload)
      );
      if (navigator.sendBeacon) {
        // text/plain Blob avoids CORS preflight (sendBeacon can't handle
        // preflight, and application/json would force one). Server parses
        // the body as JSON manually.
        navigator.sendBeacon(
          "https://sweetz.ai/api/landing-event",
          new Blob([body], { type: "text/plain" })
        );
      } else {
        // Legacy fallback — keepalive fetch survives page unload
        fetch("https://sweetz.ai/api/landing-event", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: body,
          keepalive: true,
          mode: "no-cors",
        }).catch(function () {});
      }
    } catch (e) {
      // Silent — analytics should never break the flow
    }
  }

  // ── Initialize cards ───────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    // Single coinflip for the entire page — both cards show the same pose.
    const variation = pickVariation(); // "missionary" | "blowjob"

    // Rewrite the login link with full attribution forwarding
    const loginEl = document.getElementById("login-link");
    if (loginEl) {
      loginEl.setAttribute("href", buildForwardUrl(APP_LOGIN_URL, null));
      loginEl.addEventListener("click", function () {
        fireEvent("style_click", {
          style: "login",
          variation: variation,
        });
      });
    }

    const cards = document.querySelectorAll(".card");
    cards.forEach(function (card) {
      const style = card.dataset.style; // "realistic" | "anime"

      // Swap media src to the picked variation (only if different from
      // the default missionary that's already inlined in the HTML —
      // this avoids a second network request for the default case)
      const img = card.querySelector(".card-img");
      if (img) {
        const targetSrc = buildMediaSrc(style, variation);
        if (img.getAttribute("src") !== targetSrc) {
          img.setAttribute("src", targetSrc);
        }
      }

      // Rewrite the href so middle-click / right-click / copy-link
      // all preserve attribution, not just the left-click handler.
      const forwardUrl = buildForwardUrl(APP_CREATE_URL, {
        style: style,
        variation: variation,
      });
      card.setAttribute("href", forwardUrl);

      // Intercept left-click to fire beacon THEN navigate — sendBeacon
      // survives the navigation so the event gets recorded.
      card.addEventListener("click", function (e) {
        // Only intercept plain left-click; let middle/cmd-click open in
        // new tab naturally (href is already rewritten above)
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) {
          fireEvent("style_click", {
            style: style,
            variation: variation,
          });
          return;
        }
        e.preventDefault();
        fireEvent("style_click", {
          style: style,
          variation: variation,
        });
        window.location.href = forwardUrl;
      });
    });

    // Single view event for attribution baseline
    fireEvent("landing_view", {
      variation: variation,
      referrer: document.referrer || null,
      path: window.location.pathname || "/",
      utm_source: acquisition.utm_source || null,
      utm_medium: acquisition.utm_medium || null,
      utm_campaign: acquisition.utm_campaign || null,
      fbclid: acquisition.fbclid || null,
      gclid: acquisition.gclid || null,
      via: acquisition.via || null,
    });
  });
})();
