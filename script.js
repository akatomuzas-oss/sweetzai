// ---------------------------------------------------------------------------
// sweetzai.com — redirect shell
//
// 2026-05-11: the landing page (hero + 2 style cards) was retired in favor
// of a direct redirect to sweetz.ai. This script keeps the attribution
// surface intact so affiliate / UTM / FirstPromoter credit still flows
// across the domain hop:
//
//   1. Capture incoming params (utm_*, fbclid, gclid, fpr, via, ref…)
//   2. Read the FirstPromoter _fprom_tid cookie if it landed on this domain
//      (set by fpr.js after fpr.init/click in the <head>)
//   3. Merge with localStorage first-touch attribution
//   4. Append everything to https://sweetz.ai/ and window.location.replace
//   5. Fire-and-forget "landing_view" beacon for measurement
//
// All of step 1-4 runs synchronously on DOMContentLoaded so the redirect
// fires within ~10ms after parse. The <meta refresh> fallback covers the
// (very rare) case where JS is disabled or throws.
//
// Zero dependencies. Ships to Vercel as a static file.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  // Where the main app lives
  const APP_HOME_URL = "https://sweetz.ai/";

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

  function getIncomingParams() {
    const q = new URLSearchParams(window.location.search);
    const o = {};
    FORWARD_PARAMS.forEach(function (k) {
      const v = q.get(k);
      if (v) o[k] = v;
    });
    // Capture affiliate slug from path: sweetzai.com/luminox → via=luminox
    if (!o.via) {
      const pathSlug = window.location.pathname.replace(/^\//, "");
      if (pathSlug && /^[a-z0-9_-]{2,30}$/i.test(pathSlug)) {
        o.via = pathSlug;
      }
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

  // ── Build forward URL ──────────────────────────────────────────────────
  function buildForwardUrl() {
    const u = new URL(APP_HOME_URL);
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
        navigator.sendBeacon(
          "https://sweetz.ai/api/landing-event",
          new Blob([body], { type: "text/plain" })
        );
      } else {
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

  // ── Fire beacon + redirect ─────────────────────────────────────────────
  // Run on DOMContentLoaded so the <meta refresh> fallback only fires if
  // we somehow don't make it here. sendBeacon survives navigation so the
  // event still arrives at sweetz.ai/api/landing-event after the hop.
  function go() {
    const forwardUrl = buildForwardUrl();
    fireEvent("landing_redirect", {
      referrer: document.referrer || null,
      utm_source: acquisition.utm_source || null,
      utm_medium: acquisition.utm_medium || null,
      utm_campaign: acquisition.utm_campaign || null,
      fbclid: acquisition.fbclid || null,
      gclid: acquisition.gclid || null,
      via: acquisition.via || null,
      destination: forwardUrl,
    });
    // replace() — no back-button entry for the bounce
    window.location.replace(forwardUrl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
})();
