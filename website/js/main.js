(function () {
  const storageKey = "ocp-marketing-theme";
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");
  const themeOrder = ["dark", "light", "system"];

  function applyTheme(mode) {
    root.setAttribute("data-theme", mode);
    if (toggle) {
      const label =
        mode === "dark" ? "Theme: Dark" : mode === "light" ? "Theme: Light" : "Theme: System";
      toggle.setAttribute("aria-label", label);
      toggle.dataset.mode = mode;
    }
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* ignore */
    }
  }

  function nextTheme(current) {
    const i = themeOrder.indexOf(current);
    return themeOrder[(i + 1) % themeOrder.length];
  }

  const saved = (() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  })();

  applyTheme(saved && themeOrder.includes(saved) ? saved : "dark");

  toggle?.addEventListener("click", () => {
    applyTheme(nextTheme(root.getAttribute("data-theme") || "dark"));
  });

  /* Scroll reveal */
  const revealEls = document.querySelectorAll("[data-reveal]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (revealEls.length && !reducedMotion) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }
    );
    revealEls.forEach((el) => observer.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  /* Studio preview tabs */
  const preview = document.querySelector("[data-studio-preview]");
  if (preview) {
    const tabs = preview.querySelectorAll("[data-preview-tab]");
    const panels = preview.querySelectorAll("[data-preview-panel]");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const id = tab.getAttribute("data-preview-tab");
        tabs.forEach((t) => {
          const on = t === tab;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        panels.forEach((p) => {
          p.hidden = p.getAttribute("data-preview-panel") !== id;
        });
      });
    });
  }

  /* Role gallery */
  const roleRoot = document.querySelector("[data-role-gallery]");
  if (roleRoot) {
    const buttons = roleRoot.querySelectorAll("[data-role]");
    const title = roleRoot.querySelector("[data-role-title]");
    const body = roleRoot.querySelector("[data-role-body]");
    const copy = {
      coding: {
        title: "OCP Coder",
        body: "Ships features end to end: reads the repo, writes a plan, waits for your approve, edits files, runs checks, and opens a PR-ready diff.",
      },
      qa: {
        title: "QA Reviewer",
        body: "Mechanical review after every coding task — inspects changed files, runs the named test command, and reports pass or fail without guessing.",
      },
      security: {
        title: "Security",
        body: "Looks for risky patterns in diffs and tool calls. Consequential actions stay gated until you allow once or deny.",
      },
      research: {
        title: "Research",
        body: "Explores docs, summarizes tradeoffs, and feeds context back to coding teammates without polluting the main thread.",
      },
      computer: {
        title: "Computer use",
        body: "Drives an isolated 1280×800 display — browser, mouse, keyboard — while you watch the live stream or take control.",
      },
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-role");
        const item = copy[key];
        if (!item) return;
        buttons.forEach((b) => b.classList.toggle("is-active", b === btn));
        if (title) title.textContent = item.title;
        if (body) body.textContent = item.body;
      });
    });
  }

  /* FAQ */
  document.querySelectorAll("[data-faq-trigger]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const item = trigger.closest("[data-faq-item]");
      const open = item?.classList.toggle("is-open");
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  /* Copy install command */
  const copyBtn = document.getElementById("copyInstall");
  const installBlock = document.getElementById("installCmd");
  copyBtn?.addEventListener("click", async () => {
    const text = installBlock?.textContent?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 2000);
    } catch {
      copyBtn.textContent = "Select & copy";
    }
  });

  /* Live thread demo */
  const thread = document.querySelector("[data-live-thread]");
  if (thread && !reducedMotion) {
    const script = [
      { who: "you", text: "Add validation tests and hand off to QA when the plan looks right." },
      { who: "coder", text: "Drafting plan — 4 steps, touches src/validate.ts and tests." },
      { who: "system", text: "Plan ready · Approve or deny" },
      { who: "you", text: "approve" },
      { who: "coder", text: "Editing 3 files · running node --test" },
      { who: "qa", text: "Diff looks good. Exit code 0 on the suite." },
      { who: "system", text: "Task complete · 3 files changed" },
    ];
    let index = 0;
    let started = false;

    function appendLine(entry) {
      const line = document.createElement("div");
      line.className = "thread-line thread-" + entry.who;
      const label =
        entry.who === "you"
          ? "You"
          : entry.who === "coder"
            ? "OCP Coder"
            : entry.who === "qa"
              ? "QA Reviewer"
              : "Studio";
      line.innerHTML =
        '<span class="thread-who">' +
        label +
        '</span><span class="thread-text">' +
        entry.text +
        "</span>";
      thread.appendChild(line);
      thread.scrollTop = thread.scrollHeight;
    }

    const threadObserver = new IntersectionObserver(
      (entries) => {
        if (started) return;
        if (!entries.some((e) => e.isIntersecting)) return;
        started = true;
        const tick = () => {
          if (index >= script.length) return;
          appendLine(script[index++]);
          setTimeout(tick, index === 3 ? 1400 : 900);
        };
        tick();
      },
      { threshold: 0.35 }
    );
    threadObserver.observe(thread);
  }

  /* Hero roster bot selection */
  document.querySelectorAll("[data-hero-bot]").forEach((row) => {
    row.addEventListener("click", () => {
      document.querySelectorAll("[data-hero-bot]").forEach((r) => r.classList.remove("is-selected"));
      row.classList.add("is-selected");
      const status = document.querySelector("[data-hero-status]");
      const name = row.querySelector(".bot-name")?.textContent;
      const sub = row.querySelector(".bot-status")?.textContent;
      if (status && name && sub) {
        status.innerHTML =
          '<strong>' + name + "</strong><span>" + sub + "</span>";
      }
    });
  });

  /* Provider marquee duplicate for seamless loop */
  const track = document.querySelector("[data-marquee-track]");
  if (track && !reducedMotion) {
    track.innerHTML += track.innerHTML;
  }
})();
