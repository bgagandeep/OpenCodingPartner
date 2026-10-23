(function () {
  const storageKey = "ocp-marketing-theme";
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");
  const order = ["dark", "light", "system"];

  function applyTheme(mode) {
    root.setAttribute("data-theme", mode);
    if (toggle) {
      const label =
        mode === "dark" ? "Theme: Dark" : mode === "light" ? "Theme: Light" : "Theme: System";
      toggle.setAttribute("aria-label", label);
    }
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* ignore */
    }
  }

  function nextTheme(current) {
    const i = order.indexOf(current);
    return order[(i + 1) % order.length];
  }

  const saved = (() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  })();

  if (saved && order.includes(saved)) {
    applyTheme(saved);
  } else {
    applyTheme("dark");
  }

  toggle?.addEventListener("click", () => {
    const current = root.getAttribute("data-theme") || "dark";
    applyTheme(nextTheme(current));
  });

  const revealEls = document.querySelectorAll("[data-reveal]");
  if (!revealEls.length) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealEls.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );

  revealEls.forEach((el) => observer.observe(el));
})();
