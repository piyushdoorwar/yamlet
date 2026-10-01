/* Yamlet site — shared behaviour (nav, copy buttons, reveal, hero mock). */
(function () {
  "use strict";

  // Mobile navigation toggle
  const topbar = document.querySelector(".topbar");
  const toggle = document.querySelector(".nav-toggle");
  if (topbar && toggle) {
    const setOpen = (open) => {
      topbar.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    toggle.addEventListener("click", () => setOpen(!topbar.classList.contains("open")));
    topbar.querySelectorAll(".nav a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  }

  // Copy-to-clipboard buttons (also used by releases.js for rendered blocks)
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest(".copy-btn");
    if (!btn) return;
    const text = btn.dataset.copy ?? btn.closest(".cmd")?.querySelector("code")?.innerText ?? "";
    const ok = await copyText(text);
    const label = btn.querySelector("span");
    btn.classList.toggle("done", ok);
    if (label) label.textContent = ok ? "Copied" : "Press Ctrl+C";
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.classList.remove("done");
      if (label) label.textContent = "Copy";
    }, 1800);
  });

  // Scroll reveal
  const revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Also reveal anything already scrolled past (anchor jumps, reloads mid-page).
          if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
            entry.target.classList.add("in");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach((el) => obs.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("in"));
  }

  // Hero mock: variable hover peek + a pretend Send
  const mock = document.getElementById("mock");
  if (mock) {
    const v = document.getElementById("mockVar");
    const peek = mock.querySelector(".peek");
    const send = document.getElementById("mockSend");
    const resp = document.getElementById("mockResp");
    const time = document.getElementById("mockTime");

    const place = () => {
      const m = mock.getBoundingClientRect();
      const r = v.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left - m.left, m.width - peek.offsetWidth - 8));
      peek.style.left = left + "px";
      peek.style.top = r.bottom - m.top + 8 + "px";
    };
    const show = () => { place(); mock.classList.add("peeking"); };
    const hide = () => mock.classList.remove("peeking");

    v.addEventListener("mouseenter", show);
    v.addEventListener("mouseleave", hide);
    window.addEventListener("resize", () => mock.classList.contains("peeking") && place());

    // Briefly demonstrate the peek once the hero is visible.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      setTimeout(() => { show(); setTimeout(hide, 2600); }, 1100);
    }

    send.addEventListener("click", () => {
      resp.classList.add("loading");
      send.disabled = true;
      setTimeout(() => {
        time.textContent = 90 + Math.floor(Math.random() * 90) + " ms";
        resp.classList.remove("loading");
        send.disabled = false;
      }, 420);
    });
  }
})();
