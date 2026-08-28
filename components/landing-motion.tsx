"use client";

import { useEffect } from "react";

// The landing page's two scroll behaviours: the stage reveals along the spine,
// and the compact slate bar that arms once the cold open leaves the frame.
// Renders nothing - it only wires observers to markup the server already sent.
export function LandingMotion() {
  useEffect(() => {
    const reveals = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".row"));

    const showAll = () => {
      reveals.forEach((el) => el.classList.add("is-in"));
      rows.forEach((el) => el.classList.add("is-lit"));
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
      showAll();
      return;
    }

    // Stage activation: light the spine segment + node once the row is entered.
    const spine = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-lit");
            spine.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -22% 0px", threshold: 0 },
    );

    // Content reveal: one short, one-way move per block.
    const content = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            content.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    rows.forEach((el) => spine.observe(el));
    reveals.forEach((el) => content.observe(el));

    // Anything already on screen at load resolves immediately.
    const initial = window.setTimeout(() => {
      reveals.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) el.classList.add("is-in");
      });
    }, 60);

    // Backstop: never strand content invisible. Scoped to what the reader has
    // actually reached rather than fired on a load-relative timer - the cold
    // open holds the first screen, so a blanket reveal would spend every stage
    // animation before the reader ever scrolls into the loop.
    let lastSweep = 0;

    const sweep = () => {
      let pending = false;

      reveals.forEach((el) => {
        if (el.classList.contains("is-in")) return;
        if (el.getBoundingClientRect().top < window.innerHeight) {
          el.classList.add("is-in");
        } else {
          pending = true;
        }
      });

      rows.forEach((el) => {
        if (el.classList.contains("is-lit")) return;
        if (el.getBoundingClientRect().top < window.innerHeight) {
          el.classList.add("is-lit");
        } else {
          pending = true;
        }
      });

      if (!pending) {
        window.removeEventListener("scroll", onView);
        window.removeEventListener("resize", onView);
      }
    };

    // Throttled by timestamp rather than requestAnimationFrame: this is the
    // fallback for the observer, and rAF is paused in the same conditions that
    // stop the observer firing, which would take the safety net down with it.
    const onView = () => {
      const now = performance.now();
      if (now - lastSweep < 100) return;
      lastSweep = now;
      sweep();
    };

    window.addEventListener("scroll", onView, { passive: true });
    window.addEventListener("resize", onView, { passive: true });

    // Cold open only: raise the compact slate bar once the title card has left
    // the frame. Never hides content - the bar is a convenience duplicate of
    // the header CTA.
    const hero = document.getElementById("co-hero");
    const bar = document.getElementById("co-slatebar");
    let slate: IntersectionObserver | null = null;
    if (hero && bar) {
      slate = new IntersectionObserver(
        (entries) => {
          bar.classList.toggle("co-is-on", !entries[0].isIntersecting);
        },
        { threshold: 0, rootMargin: "-70% 0px 0px 0px" },
      );
      slate.observe(hero);
    }

    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("scroll", onView);
      window.removeEventListener("resize", onView);
      spine.disconnect();
      content.disconnect();
      slate?.disconnect();
    };
  }, []);

  return null;
}
