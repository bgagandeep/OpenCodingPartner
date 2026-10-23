(function () {
  const storageKey = "ocp-marketing-theme";
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");
  const themeOrder = ["dark", "light", "system"];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function applyTheme(mode) {
    root.setAttribute("data-theme", mode);
    if (toggle) {
      toggle.setAttribute(
        "aria-label",
        mode === "dark" ? "Theme: Dark" : mode === "light" ? "Theme: Light" : "Theme: System"
      );
    }
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* ignore */
    }
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
    const current = root.getAttribute("data-theme") || "dark";
    const i = themeOrder.indexOf(current);
    applyTheme(themeOrder[(i + 1) % themeOrder.length]);
  });

  /* Scroll reveal */
  document.querySelectorAll("[data-reveal]").forEach((el) => {
    if (reducedMotion) {
      el.classList.add("is-visible");
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("is-visible");
          obs.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -5% 0px" }
    );
    obs.observe(el);
  });

  const featureList = document.querySelector(".feature-list");
  if (featureList && !reducedMotion) {
    const flObs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          featureList.classList.add("is-visible");
          flObs.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    flObs.observe(featureList);
  } else if (featureList) {
    featureList.classList.add("is-visible");
  }

  /* Studio assets from sibling session (website/assets/) */
  async function probeAsset(path) {
    try {
      const res = await fetch(path, { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  }

  (async function loadHeroMedia() {
    const wrap = document.getElementById("heroMedia");
    const video = document.getElementById("heroVideo");
    const picture = document.getElementById("heroPicture");
    if (!wrap) return;

    const hasVideo = await probeAsset("/assets/studio-demo.mp4");
    const hasShot = await probeAsset("/assets/hero-studio.webp");
    if (!hasVideo && !hasShot) return;

    wrap.hidden = false;
    wrap.classList.remove("hidden");
    wrap.classList.add("is-visible");

    if (hasVideo && video) {
      video.src = "/assets/studio-demo.mp4";
      video.style.display = "block";
      if (picture) picture.style.display = "none";
      try {
        await video.play();
      } catch {
        /* autoplay blocked — poster still shows */
      }
    } else if (picture) {
      picture.style.display = "block";
      if (video) video.style.display = "none";
    }
  })();

  /* Animated bot icons */
  const BOTS = [
    { name: "OCP Coder", role: "Coding", state: "working", hue: 195 },
    { name: "QA Reviewer", role: "Review", state: "thinking", hue: 280 },
    { name: "Security", role: "Gate", state: "waiting", hue: 42 },
    { name: "Research", role: "Context", state: "idle", hue: 160 },
    { name: "Computer", role: "Desktop", state: "done", hue: 210 },
  ];

  const STATUS_LINES = {
    working: "Implementing · tests and diffs",
    thinking: "Reading diff · mechanical review",
    waiting: "Awaiting your approval",
    idle: "Ready for the next task",
    done: "Stream live · you can take control",
  };

  function botSvg(hue, state) {
    const head = `hsl(${hue} 45% 18%)`;
    const face = `hsl(${hue} 35% 28%)`;
    const eye = `hsl(${hue} 80% 75%)`;
    return (
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      `<rect x="8" y="10" width="48" height="44" rx="16" fill="${head}"/>` +
      `<rect x="12" y="14" width="40" height="36" rx="12" fill="${face}"/>` +
      (state === "waiting"
        ? `<circle class="bot-ring" cx="32" cy="32" r="30" fill="none" stroke="${eye}" stroke-width="1.5" opacity="0.5"/>`
        : "") +
      `<rect class="eye-left" x="19" y="26" width="10" height="12" rx="4" fill="${eye}"/>` +
      `<rect class="eye-right" x="35" y="26" width="10" height="12" rx="4" fill="${eye}"/>` +
      "</svg>"
    );
  }

  const parade = document.querySelector("[data-bot-parade]");
  const statusLine = document.getElementById("botStatusLine");
  let focusIndex = 0;

  if (parade) {
    BOTS.forEach((bot, i) => {
      const slot = document.createElement("div");
      slot.className = "bot-slot" + (i === 0 ? " is-focus" : "");
      slot.innerHTML =
        `<div class="bot-face" data-state="${bot.state}">${botSvg(bot.hue, bot.state)}</div>` +
        `<span class="bot-label">${bot.name}</span>`;
      slot.addEventListener("click", () => setFocus(i));
      parade.appendChild(slot);
    });

    function setFocus(i) {
      focusIndex = i;
      parade.querySelectorAll(".bot-slot").forEach((el, j) => {
        el.classList.toggle("is-focus", j === i);
      });
      const bot = BOTS[i];
      if (statusLine) {
        statusLine.style.opacity = "0";
        setTimeout(() => {
          statusLine.textContent = `${bot.name} · ${STATUS_LINES[bot.state]}`;
          statusLine.style.opacity = "1";
        }, 180);
      }
    }

    if (!reducedMotion) {
      setInterval(() => setFocus((focusIndex + 1) % BOTS.length), 3200);
    }
  }

  /* Thread demo */
  const thread = document.querySelector("[data-live-thread]");
  if (thread) {
    const script = [
      { c: "thread-you", t: "Add validation tests — approve the plan first." },
      { c: "thread-bot", t: "Plan ready: 4 steps, then node --test." },
      { c: "thread-sys", t: "Waiting for approve" },
      { c: "thread-you", t: "approve" },
      { c: "thread-bot", t: "QA: exit 0 on the suite." },
    ];
    let idx = 0;
    let started = false;

    function addLine(item) {
      const line = document.createElement("div");
      line.className = "thread-line " + item.c;
      line.textContent = item.t;
      thread.appendChild(line);
    }

    if (reducedMotion) {
      script.forEach(addLine);
    } else {
      const tObs = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting || started) return;
          started = true;
          (function tick() {
            if (idx >= script.length) return;
            addLine(script[idx++]);
            setTimeout(tick, idx === 3 ? 1200 : 750);
          })();
        },
        { threshold: 0.3 }
      );
      tObs.observe(thread);
    }
  }

  /* Copy install */
  const copyBtn = document.getElementById("copyInstall");
  const installCmd = document.getElementById("installCmd");
  copyBtn?.addEventListener("click", async () => {
    const text = installCmd?.textContent?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 2000);
    } catch {
      copyBtn.textContent = "Copy manually";
    }
  });
})();
