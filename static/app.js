// Frontend Dashboard Logic for OmniGuard Ask-My-Docs
// Connects to real FastAPI backend — no mocked data.

document.addEventListener("DOMContentLoaded", () => {

    // ----------------------------------------------------------------
    // Authentication is handled by auth.js (window.Auth): real JWT
    // login/signup, token refresh, profile dropdown, and logout.
    // This file starts the dashboard via Auth.init(startApp) at the bottom.
    // ----------------------------------------------------------------

    // ----------------------------------------------------------------
    // Tab Navigation
    // ----------------------------------------------------------------
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabPanes   = document.querySelectorAll(".tab-pane");


    const navOrder = Array.from(navButtons).map(b => b.getAttribute("data-tab"));

    function switchTab(targetTab) {
        const activePane = document.querySelector(".tab-pane.active");
        const nextPane = document.getElementById(targetTab);
        if (!nextPane || nextPane === activePane) return;

        // Directional slide+fade based on nav order — visiting a tab to the
        // right slides in from the right, and vice versa, so the motion
        // reads as spatial navigation rather than a generic cross-fade.
        const fromIdx = activePane ? navOrder.indexOf(activePane.id) : -1;
        const toIdx = navOrder.indexOf(targetTab);
        const dir = toIdx > fromIdx ? "right" : "left";

        navButtons.forEach(b => {
            const isTarget = b.getAttribute("data-tab") === targetTab;
            b.classList.toggle("active", isTarget);
            b.setAttribute("aria-selected", String(isTarget));
        });
        tabPanes.forEach(pane => pane.classList.remove("active", "tab-enter-left", "tab-enter-right"));

        nextPane.classList.add("active", `tab-enter-${dir}`);
        const clearEnterClass = () => nextPane.classList.remove("tab-enter-left", "tab-enter-right");
        nextPane.addEventListener("animationend", clearEnterClass, { once: true });
        // animationend can be delayed or never fire in some backgrounded/
        // automated rendering contexts (same class of issue as the rAF
        // throttling fixed in animateCounter) — this guarantees the
        // transient class is gone well after the 0.32s animation should
        // have finished, regardless of whether the event itself arrives.
        setTimeout(clearEnterClass, 500);

        if (targetTab === "eval-tab")  loadEvaluationHistory();
        if (targetTab === "docs-tab")  loadDocuments();
        if (targetTab === "admin-tab") loadAdminDashboard();
    }

    navButtons.forEach(btn => {
        btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
    });

    // Keyboard navigation: Left/Right (or Up/Down) arrows move focus and
    // switch tabs across the nav menu, matching the standard ARIA tablist
    // pattern; Home/End jump to the first/last visible tab.
    document.querySelector(".nav-menu").addEventListener("keydown", e => {
        if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(e.key)) return;
        const visible = Array.from(navButtons).filter(b => getComputedStyle(b).display !== "none");
        const current = visible.indexOf(document.activeElement);
        if (current === -1) return;
        e.preventDefault();
        let next;
        if (e.key === "Home") next = 0;
        else if (e.key === "End") next = visible.length - 1;
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % visible.length;
        else next = (current - 1 + visible.length) % visible.length;
        visible[next].focus();
        switchTab(visible[next].getAttribute("data-tab"));
    });

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    function formatDate(timestamp) {
        const d = new Date(timestamp * 1000);
        return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function formatTime() {
        return new Date().toLocaleString([], { hour: "2-digit", minute: "2-digit" });
    }

    function formatBytes(bytes) {
        if (!bytes) return "0 KB";
        const units = ["B", "KB", "MB", "GB"];
        let i = 0, v = bytes;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    // Animates a numeric label from its current displayed value to `target`
    // with an ease-out curve. Reused by the Admin Dashboard stat cards and
    // the Evaluation metric cards. `render` formats the interpolated number
    // for display (percent, seconds, plain integer, etc).
    function animateCounter(el, target, render, duration = 700) {
        const startVal = parseFloat(el.dataset.rawValue || "0") || 0;
        if (!isFinite(target)) target = 0;
        const startTime = performance.now();
        el.dataset.rawValue = String(target);
        let done = false;
        function finish() {
            if (done) return;
            done = true;
            el.textContent = render(target);
        }
        function tick(now) {
            if (done) return;
            const t = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
            el.textContent = render(startVal + (target - startVal) * eased);
            if (t < 1) requestAnimationFrame(tick);
            else finish();
        }
        requestAnimationFrame(tick);
        // requestAnimationFrame is throttled or fully paused in some
        // backgrounded/automated browser contexts — this guarantees the
        // correct final value lands on schedule even if rAF never fires.
        setTimeout(finish, duration + 150);
        el.classList.remove("counter-pulse");
        void el.offsetWidth;
        el.classList.add("counter-pulse");
    }

    // ------------------------------------------------------------------
    // Prometheus text-format parser — /metrics is exposed for scraping,
    // not as JSON, so the Admin Dashboard reads and parses it client-side
    // instead of requiring a new backend endpoint.
    // ------------------------------------------------------------------
    function parsePrometheusMetrics(text) {
        const samples = [];
        text.split("\n").forEach(line => {
            if (!line || line.startsWith("#")) return;
            const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([0-9.eE+\-]+|NaN|[+-]Inf)\s*$/);
            if (!m) return;
            const labels = {};
            if (m[3]) {
                m[3].split(",").forEach(pair => {
                    const kv = pair.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/);
                    if (kv) labels[kv[1]] = kv[2];
                });
            }
            samples.push({ name: m[1], labels, value: parseFloat(m[4]) });
        });
        return samples;
    }
    function sumSamples(samples, name, labelFilter = null) {
        return samples
            .filter(s => s.name === name && (!labelFilter || Object.entries(labelFilter).every(([k, v]) => s.labels[k] === v)))
            .reduce((acc, s) => acc + (isFinite(s.value) ? s.value : 0), 0);
    }
    function findSamples(samples, name) {
        return samples.filter(s => s.name === name);
    }

    // Semi-circular SVG gauge (0-1 input). Color follows the same
    // success/warning/danger thresholds used throughout the dashboard.
    function renderGauge(container, value, { invert = false } = {}) {
        const v = Math.max(0, Math.min(1, value || 0));
        const effective = invert ? 1 - v : v;
        const color = effective >= 0.75 ? "var(--accent-success)"
                    : effective >= 0.5  ? "var(--accent-warning)"
                    : "var(--accent-danger)";
        const r = 70, cx = 90, cy = 90;
        const startAngle = Math.PI, endAngle = Math.PI - Math.PI * v;
        const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
        const largeArc = v > 0.5 ? 1 : 0;
        container.innerHTML = `
            <svg viewBox="0 0 180 100" width="180" height="100">
                <path d="M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}"
                      fill="none" stroke="var(--bg-tertiary)" stroke-width="14" stroke-linecap="round"/>
                <path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}"
                      fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
                      style="transition: d 0.6s ease;"/>
                <text x="90" y="86" text-anchor="middle" class="gauge-value-text">${(v).toFixed(2)}</text>
            </svg>`;
    }

    function confClass(pct) {
        if (pct >= 70) return "conf-high";
        if (pct >= 40) return "conf-mid";
        return "conf-low";
    }

    // ------------------------------------------------------------------
    // Lazy-loaded third-party scripts. Chart.js (eval/admin dashboards)
    // and mammoth.js (DOCX preview) are only needed by a subset of visits,
    // so they're fetched on first use instead of blocking every page load.
    // ------------------------------------------------------------------
    const _scriptPromises = {};
    function loadScriptOnce(src) {
        if (_scriptPromises[src]) return _scriptPromises[src];
        _scriptPromises[src] = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => { delete _scriptPromises[src]; reject(new Error(`Failed to load ${src}`)); };
            document.head.appendChild(s);
        });
        return _scriptPromises[src];
    }
    function ensureChartJs() {
        if (window.Chart) return Promise.resolve();
        return loadScriptOnce("https://cdn.jsdelivr.net/npm/chart.js");
    }
    function ensureMammoth() {
        if (window.mammoth) return Promise.resolve();
        return loadScriptOnce("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js");
    }

    // ------------------------------------------------------------------
    // Offline detection — a non-blocking banner (existing session state
    // stays visible underneath) that appears when the browser reports no
    // connectivity and disappears automatically on reconnect.
    // ------------------------------------------------------------------
    const offlineBanner = document.getElementById("offline-banner");
    function updateOnlineState() {
        if (offlineBanner) offlineBanner.classList.toggle("visible", !navigator.onLine);
    }
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    updateOnlineState();

    // ------------------------------------------------------------------
    // Global load-failure state — reserved for one precise, rare signal
    // (see updateProviderStatus): the very first request to the backend
    // fails at the network level, meaning the server is unreachable, not
    // just slow (this app's own local-model warm-up can legitimately take
    // 30+ seconds, which must never trip this).
    // ------------------------------------------------------------------
    function showAppLoadError(message) {
        if (document.querySelector(".app-load-error")) return; // don't stack
        const el = document.createElement("div");
        el.className = "app-load-error";
        el.setAttribute("role", "alert");
        el.innerHTML = `
            <i class="fa-solid fa-plug-circle-xmark"></i>
            <h2>Connection Problem</h2>
            <p>${escapeHTML(message)}</p>
            <button type="button" class="action-btn" id="app-load-error-retry">
                <i class="fa-solid fa-arrows-rotate"></i> Retry
            </button>`;
        document.body.appendChild(el);
        el.querySelector("#app-load-error-retry").addEventListener("click", () => window.location.reload());
    }

    function escapeHTML(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#039;");
    }

    // ----------------------------------------------------------------
    // Markdown v2: paragraphs, headings, lists, links, fenced code with
    // syntax highlighting. Everything is escaped BEFORE markup insertion.
    // ----------------------------------------------------------------

    // Single-pass tokenizer — each segment escaped independently, so
    // generated markup can never be re-matched by later rules.
    function highlightCode(raw) {
        const tokenRe = new RegExp(
            "(\\/\\/[^\\n]*|#[^\\n]*)" +                                   // 1 comment
            "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')" +    // 2 string
            "|\\b(\\d+(?:\\.\\d+)?)\\b" +                                  // 3 number
            "|\\b(def|return|import|from|class|if|else|elif|for|while|in|not|and|or|None|True|False|const|let|var|function|async|await|try|except|catch|finally|with|as|lambda|raise|new|this|self|public|private|static|void|int|float|bool|str|string|null|undefined|true|false|print|console)\\b",
            "g");
        let out = "", last = 0, m;
        while ((m = tokenRe.exec(raw)) !== null) {
            out += escapeHTML(raw.slice(last, m.index));
            if (m[1] !== undefined)      out += `<span class="tok-comment">${escapeHTML(m[1])}</span>`;
            else if (m[2] !== undefined) out += `<span class="tok-string">${escapeHTML(m[2])}</span>`;
            else if (m[3] !== undefined) out += `<span class="tok-number">${escapeHTML(m[3])}</span>`;
            else                         out += `<span class="tok-keyword">${escapeHTML(m[4])}</span>`;
            last = m.index + m[0].length;
        }
        return out + escapeHTML(raw.slice(last));
    }

    function renderInline(escaped) {
        let s = escaped;
        s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
        s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
        // Links: [text](http…) — only http(s), escaped href, safe target
        s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');
        // Citation links: [file.md#Section] or [file.md#Section, page N]
        s = s.replace(/\[([a-zA-Z0-9_\-\.]+(?:#[^\],\n]+)?(?:,\s*page\s*\d+)?)\]/g, (match, citeKey) => {
            const lookupKey = citeKey.split(",")[0].trim();
            return `<a class="citation-link" data-cite="${citeKey ? escapeHTML(lookupKey) : ""}">[cite: ${citeKey}]</a>`;
        });
        return s;
    }

    function formatMarkdown(rawText) {
        if (!rawText) return "";
        // 1. Pull out fenced code blocks before any other processing
        const codeBlocks = [];
        let text = rawText.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
            codeBlocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
            return ` CODE${codeBlocks.length - 1} `;
        });

        // 2. Escape everything else, then build blocks line by line
        const lines = escapeHTML(text).split("\n");
        const blocks = [];
        let list = null; // {type: "ul"|"ol", items: []}
        const flushList = () => {
            if (!list) return;
            blocks.push(`<${list.type}>` + list.items.map(i => `<li>${renderInline(i)}</li>`).join("") + `</${list.type}>`);
            list = null;
        };
        let para = [];
        const flushPara = () => {
            if (!para.length) return;
            blocks.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
            para = [];
        };

        for (const line of lines) {
            const t = line.trim();
            const heading = t.match(/^(#{1,4})\s+(.*)$/);
            const bullet  = t.match(/^[-*]\s+(.*)$/);
            const number  = t.match(/^\d+[.)]\s+(.*)$/);
            const codeph  = t.match(/^ CODE(\d+) $/);

            if (codeph) {
                flushPara(); flushList();
                const cb = codeBlocks[Number(codeph[1])];
                blocks.push(
                    `<div class="code-block"><div class="code-block-head">` +
                    `<span class="code-lang">${escapeHTML(cb.lang)}</span>` +
                    `<button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code"><i class="fa-regular fa-copy"></i></button>` +
                    `</div><pre><code>${highlightCode(cb.code)}</code></pre></div>`);
            } else if (heading) {
                flushPara(); flushList();
                blocks.push(`<h4 class="md-heading">${renderInline(heading[2])}</h4>`);
            } else if (bullet) {
                flushPara();
                if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
                list.items.push(bullet[1]);
            } else if (number) {
                flushPara();
                if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
                list.items.push(number[1]);
            } else if (t === "") {
                flushPara(); flushList();
            } else {
                flushList();
                para.push(t);
            }
        }
        flushPara(); flushList();
        return blocks.join("");
    }

    // Wire up copy buttons inside rendered code blocks
    function bindCodeCopyButtons(scope) {
        scope.querySelectorAll(".code-copy-btn").forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = "1";
            btn.addEventListener("click", () => {
                const code = btn.closest(".code-block").querySelector("code");
                navigator.clipboard.writeText(code.innerText).then(() => {
                    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1600);
                });
            });
        });
    }

    // ----------------------------------------------------------------
    // Avatars: AI = gradient robot badge, user = profile initials
    // ----------------------------------------------------------------
    function makeAvatar(sender) {
        const avatar = document.createElement("div");
        if (sender === "user") {
            avatar.className = "msg-avatar user-avatar";
            const u = (window.Auth && Auth.getUser) ? Auth.getUser() : null;
            const name = u && u.full_name ? u.full_name.trim() : "";
            const initials = name
                ? name.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase()
                : "";
            avatar.innerHTML = initials
                ? `<span class="avatar-initials">${escapeHTML(initials)}</span>`
                : '<i class="fa-solid fa-user"></i>';
        } else {
            avatar.className = "msg-avatar ai-avatar";
            avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';
        }
        return avatar;
    }

    // ----------------------------------------------------------------
    // Relative timestamps ("just now", "5m ago"), refreshed every 30 s.
    // Absolute date/time lives in the title attribute (hover).
    // ----------------------------------------------------------------
    function relTime(tsMs) {
        const diff = Date.now() - tsMs;
        if (diff < 45 * 1000) return "just now";
        if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))}m ago`;
        if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)}h ago`;
        return new Date(tsMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    function timestampSpan(ts /* seconds (backend) or undefined = now */) {
        const tsMs = ts ? (ts < 1e12 ? ts * 1000 : ts) : Date.now();
        const span = document.createElement("span");
        span.className = "msg-timestamp";
        span.dataset.ts = String(tsMs);
        span.title = new Date(tsMs).toLocaleString();
        span.textContent = relTime(tsMs);
        return span;
    }
    setInterval(() => {
        document.querySelectorAll(".msg-timestamp[data-ts]").forEach(el => {
            el.textContent = relTime(Number(el.dataset.ts));
        });
    }, 30000);

    // ----------------------------------------------------------------
    // Toast notifications (share/export feedback)
    // ----------------------------------------------------------------
    function showToast(message, icon = "fa-circle-check") {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.setAttribute("role", "status");
        toast.innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHTML(message)}`;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add("toast-out"), 2200);
        setTimeout(() => toast.remove(), 2600);
    }

    // ----------------------------------------------------------------
    // AI thinking panel: typing dots + animated pipeline stages.
    // Stage cycling is time-based until real SSE events take over:
    // metadata event -> "Generating Answer…", done event -> "Rendering…".
    // ----------------------------------------------------------------
    const WAIT_STAGES = ["Searching Documents", "BM25 Retrieval", "FAISS Search", "Cross Encoder"];
    function buildThinkingPanel() {
        const panel = document.createElement("div");
        panel.className = "thinking-panel";
        panel.innerHTML = `
            <div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div>
            <span class="thinking-stage-text">${WAIT_STAGES[0]}…</span>`;
        const textEl = panel.querySelector(".thinking-stage-text");
        let idx = 0;
        const timer = setInterval(() => {
            if (idx < WAIT_STAGES.length - 1) {
                idx++;
                textEl.textContent = `${WAIT_STAGES[idx]}…`;
                textEl.classList.remove("stage-flip"); void textEl.offsetWidth;
                textEl.classList.add("stage-flip");
            }
        }, 650);
        const setStage = t => {
            clearInterval(timer);
            textEl.textContent = t;
            textEl.classList.remove("stage-flip"); void textEl.offsetWidth;
            textEl.classList.add("stage-flip");
        };
        return {
            el: panel,
            generating() { setStage("Generating Answer…"); },
            rendering()  { setStage("Rendering…"); },
            destroy()    { clearInterval(timer); panel.remove(); },
        };
    }

    // ----------------------------------------------------------------
    // Smart auto-scroll: follow the stream only while the user is near
    // the bottom; otherwise show a jump-to-bottom button.
    // ----------------------------------------------------------------
    const scrollBottomBtn = document.createElement("button");
    scrollBottomBtn.className = "scroll-bottom-btn";
    scrollBottomBtn.setAttribute("aria-label", "Scroll to latest message");
    scrollBottomBtn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
    document.querySelector(".chat-wrapper").appendChild(scrollBottomBtn);

    // NOTE: the chatHistory const is declared further down — use a direct
    // lookup here (this code runs at load time, before that declaration).
    const chatHistoryEl = document.getElementById("chat-history-container");
    function isNearBottom() {
        return chatHistoryEl.scrollHeight - chatHistoryEl.scrollTop - chatHistoryEl.clientHeight < 140;
    }
    function updateScrollBtn() {
        scrollBottomBtn.classList.toggle("visible", !isNearBottom());
    }
    function autoScroll(force = false) {
        if (force || isNearBottom()) chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        updateScrollBtn();
    }
    chatHistoryEl.addEventListener("scroll", updateScrollBtn, { passive: true });
    scrollBottomBtn.addEventListener("click", () => autoScroll(true));

    // ----------------------------------------------------------------
    // Export / share conversation (client-side Markdown)
    // ----------------------------------------------------------------
    function conversationToMarkdown() {
        const lines = ["# OmniGuard — Ask-My-Docs Conversation",
                       `_Exported ${new Date().toLocaleString()}_`, ""];
        document.querySelectorAll("#chat-history-container .message").forEach(m => {
            if (m.classList.contains("welcome-msg")) return;
            if (m.querySelector(".thinking-panel, .chat-loader")) return;
            const who = m.classList.contains("user-msg") ? "**You**" : "**OmniGuard**";
            const body = m.querySelector(".msg-answer-text") || m.querySelector(".msg-bubble > p") || m.querySelector(".msg-bubble");
            const text = body ? body.innerText.trim() : "";
            if (text) lines.push(`${who}:`, "", text, "", "---", "");
        });
        return lines.join("\n");
    }

    function exportConversation() {
        const md = conversationToMarkdown();
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `omniguard-chat-${stamp}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        showToast("Conversation exported", "fa-file-arrow-down");
    }

    async function shareConversation() {
        const md = conversationToMarkdown();
        if (navigator.share) {
            try {
                await navigator.share({ title: "OmniGuard Conversation", text: md });
                return;
            } catch (e) { /* user cancelled — fall through to clipboard */ }
        }
        await navigator.clipboard.writeText(md);
        showToast("Conversation copied to clipboard", "fa-share-nodes");
    }

    document.getElementById("export-chat-btn").addEventListener("click", exportConversation);
    document.getElementById("share-chat-btn").addEventListener("click", shareConversation);

    // ----------------------------------------------------------------
    // Provider Status + System Stats Sidebar
    // ----------------------------------------------------------------
    const providerPill      = document.getElementById("active-provider-pill");
    const providerName      = document.getElementById("active-provider-name");
    const systemStatsPanel  = document.getElementById("system-stats-panel");

    // Only the very first status check can trigger the full-screen error
    // state — later transient failures (a single dropped request mid-session)
    // just fall back to the existing soft "Connecting…" degradation below,
    // so one network blip never interrupts an otherwise-working session.
    let firstStatusCheckDone = false;

    async function updateProviderStatus() {
        try {
            const res = await Auth.fetch("/api/status");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const status = await res.json();

            const provider = (status.llm_provider || "unknown").toLowerCase();

            const labels = {
                local:               `LOCAL (${status.local_model || "flan-t5"})`,
                gemini:              "GEMINI ACTIVE",
                openai:              "OPENAI ACTIVE",
                extractive_fallback: "EXTRACTIVE FALLBACK",
            };
            providerName.innerText = labels[provider] || provider.toUpperCase() + " ACTIVE";

            if (provider === "extractive_fallback") {
                providerPill.className = "provider-pill mock";
            } else {
                providerPill.className = "provider-pill";
            }

            // Populate sidebar system stats
            if (systemStatsPanel) {
                const embeddingShort = (status.embedding_model || "").split("/").pop() || status.embedding_model || "—";
                systemStatsPanel.innerHTML = `
                    <div class="sys-stat-row">
                        <i class="fa-solid fa-file-circle-check"></i>
                        <span>${status.documents_indexed ?? "—"} chunks indexed</span>
                    </div>
                    <div class="sys-stat-row">
                        <i class="fa-solid fa-layer-group"></i>
                        <span>Top-K: ${status.top_k_retrieval ?? "—"} &rarr; Rerank: ${status.top_k_rerank ?? "—"}</span>
                    </div>
                    <div class="sys-stat-row">
                        <i class="fa-solid fa-microchip"></i>
                        <span title="${escapeHTML(status.embedding_model || "")}">${escapeHTML(embeddingShort)}</span>
                    </div>
                `;
            }
        } catch (err) {
            console.error("Provider status error:", err);
            providerName.innerText = "Connecting…";
            // A TypeError from fetch() means the request never reached the
            // server (DNS/connection failure) — distinct from an HTTP error
            // status, which means the server IS reachable. Only escalate to
            // the full-screen state on this specific, unambiguous signal,
            // and only on the first attempt (see comment above).
            if (!firstStatusCheckDone && err instanceof TypeError) {
                showAppLoadError("Can't reach the OmniGuard server. Check your connection and try again.");
            }
        } finally {
            firstStatusCheckDone = true;
        }
    }

    // ----------------------------------------------------------------
    // 1. CHAT WORKSPACE
    // ----------------------------------------------------------------
    const chatForm     = document.getElementById("chat-form");
    const queryInput   = document.getElementById("query-input");
    const chatHistory  = document.getElementById("chat-history-container");
    const clearChatBtn = document.getElementById("clear-chat-btn");
    const charCounter  = document.getElementById("char-counter");

    // Full retrieval records keyed by "source#section" (and by bare source as
    // fallback) — content, page, chunk id, every pipeline score, and the query
    // that retrieved them. Powers the citation buttons and the modal.
    let currentSessionDocs = {};
    let conversationHistory = "";
    let libraryIdByFilename = {};   // filename -> library doc id (Open Source button)

    function storeSessionDocs(docs, query) {
        (docs || []).forEach(doc => {
            const rec = { ...doc, query };
            const key = `${doc.source}#${doc.section}`;
            currentSessionDocs[key] = rec;
            if (!currentSessionDocs[doc.source]) currentSessionDocs[doc.source] = rec;
        });
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // Wraps query terms (>3 chars) found in already-escaped HTML with <mark>
    function highlightTerms(escapedHtml, query) {
        if (!query) return escapedHtml;
        const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/i)
            .filter(t => t.length > 3))];
        let out = escapedHtml;
        terms.forEach(t => {
            out = out.replace(new RegExp(`(${escapeRegExp(t)})`, "gi"), "<mark>$1</mark>");
        });
        return out;
    }

    function retrievalMethodOf(doc) {
        if (doc.bm25_rank != null && doc.vector_rank != null) return "Hybrid (BM25 + FAISS)";
        if (doc.bm25_rank != null) return "BM25 keyword (sparse)";
        if (doc.vector_rank != null) return "FAISS semantic (dense)";
        return "—";
    }

    function fmtScore(v, digits = 3) {
        return (v === null || v === undefined) ? "—" : Number(v).toFixed(digits);
    }

    function fmtMs(v) {
        return (v === null || v === undefined) ? "—" : `${Math.round(v)} ms`;
    }

    // Opens the original source document in a new tab (blob URL so the
    // Authorization header can be attached; window opened before the await
    // to survive popup blockers).
    async function openSourceDocument(filename) {
        const win = window.open("", "_blank");
        try {
            let id = libraryIdByFilename[filename];
            if (!id) {
                await loadDocuments();
                id = libraryIdByFilename[filename];
            }
            if (!id) throw new Error("Document not found in library.");
            const res = await Auth.fetch(`/api/library/${id}/file`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            win.location = URL.createObjectURL(blob);
        } catch (err) {
            if (win) win.close();
            alert(`Could not open source document: ${err.message}`);
        }
    }

    // Character counter + textarea auto-grow (up to ~5 lines)
    queryInput.addEventListener("input", () => {
        const len = queryInput.value.length;
        charCounter.textContent = `${len} / 500`;
        charCounter.classList.toggle("counter-warn", len > 400);
        queryInput.style.height = "auto";
        queryInput.style.height = Math.min(queryInput.scrollHeight, 132) + "px";
    });

    // Enter sends, Shift+Enter inserts a newline (Ctrl+Enter still sends)
    queryInput.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
    });

    // Global shortcuts: "/" focuses the input, Ctrl+K clears the chat,
    // Ctrl+Shift+E exports the conversation.
    document.addEventListener("keydown", e => {
        const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
        if (e.key === "/" && !typing) {
            e.preventDefault();
            queryInput.focus();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
            e.preventDefault();
            clearChatBtn.click();
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
            e.preventDefault();
            exportConversation();
        }
    });

    clearChatBtn.addEventListener("click", () => {
        chatHistory.innerHTML = `
            <div class="message system-msg">
                <div class="msg-avatar"><i class="fa-solid fa-robot"></i></div>
                <div class="msg-bubble">
                    <p>Chat history cleared. How can I help you check compliance policies today?</p>
                </div>
            </div>
        `;
        currentSessionDocs = {};
        conversationHistory = "";
        // Optional: Call an endpoint to clear DB history for this session if needed
    });

    // ----------------------------------------------------------------
    // History Loading
    // ----------------------------------------------------------------
    async function loadChatHistory() {
        try {
            const res = await Auth.fetch("/api/chat/history");
            if (!res.ok) return;
            const data = await res.json();
            if (data.history && data.history.length > 0) {
                // Clear initial greeting
                chatHistory.innerHTML = "";
                conversationHistory = "";
                data.history.forEach(msg => {
                    if (msg.role === "user") {
                        appendMessage("user", msg.content, msg.timestamp);
                        conversationHistory += `User: ${msg.content}\\n`;
                    } else {
                        // For assistant we just render markdown
                        appendHistoricalAgentResponse(msg.content, msg.timestamp);
                        conversationHistory += `Assistant: ${msg.content}\\n\\n`;
                    }
                });
                chatHistory.scrollTop = chatHistory.scrollHeight;
            }
        } catch(e) {
            console.error("Failed to load chat history", e);
        }
    }

    function appendHistoricalAgentResponse(text, timestamp) {
        const msgDiv = document.createElement("div");
        msgDiv.className = "message system-msg";

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = `<div class="msg-answer-text">${formatMarkdown(text)}</div>`;
        bubble.appendChild(timestampSpan(timestamp));

        msgDiv.appendChild(makeAvatar("ai"));
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);

        bindCodeCopyButtons(bubble);
        bubble.querySelectorAll(".citation-link").forEach(link => {
            link.addEventListener("click", () => openCitationModal(link.getAttribute("data-cite")));
        });
    }

    // Quick-prompt chips
    document.addEventListener("click", e => {
        if (e.target.classList.contains("prompt-chip")) {
            queryInput.value = e.target.getAttribute("data-query");
            charCounter.textContent = `${queryInput.value.length} / 500`;
            chatForm.dispatchEvent(new Event("submit"));
        }
    });

    chatForm.addEventListener("submit", async e => {
        e.preventDefault();
        const query = queryInput.value.trim();
        if (!query) return;

        appendMessage("user", query);
        queryInput.value = "";
        queryInput.style.height = "auto";   // collapse the auto-grown textarea
        charCounter.textContent = "0 / 500";
        charCounter.classList.remove("counter-warn");

        const loader = appendLoader();
        autoScroll(true);

        const controller = new AbortController();
        // Keep timeout alive for entire duration including stream read
        let timeoutId = setTimeout(() => {
            controller.abort();
        }, 90000); // 90s total timeout

        try {
            const res = await Auth.fetch("/api/chat", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ query, stream: true, history: conversationHistory }),
                signal:  controller.signal
            });

            if (!res.ok) {
                clearTimeout(timeoutId);
                removeLoader(loader);
                const err = await res.json().catch(() => ({ detail: "Unknown error" }));
                appendMessage("system", `Error: ${err.detail || "Request failed."}`);
                return;
            }

            conversationHistory += `User: ${query}\n`;

            if (res.headers.get("content-type") && res.headers.get("content-type").includes("text/event-stream")) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let done = false;

                // Convert the thinking-panel message in place into the answer
                const msgDiv = loader.msgDiv;
                const bubble = loader.bubble;
                const answerText = document.createElement("div");
                answerText.className = "msg-answer-text";
                bubble.appendChild(answerText);

                const CARET = '<span class="stream-caret" aria-hidden="true"></span>';
                let rawAnswer = "";
                let buffer = "";
                let metadata = null;
                let gotAnyData = false;
                
                try {
                    while (!done) {
                        const { value, done: readerDone } = await reader.read();
                        done = readerDone;
                        if (value) {
                            // FIX: split on actual newline \n, not the literal string "\\n"
                            buffer += decoder.decode(value, { stream: true });
                            // Normalize \r\n to \n for Windows servers
                            buffer = buffer.replace(/\r\n/g, "\n");
                            const lines = buffer.split("\n");
                            buffer = lines.pop(); // Keep the last incomplete line

                            for (const line of lines) {
                                if (!line.trim()) continue; // skip blank lines
                                if (line.startsWith("data: ")) {
                                    const dataStr = line.slice(6).trim();
                                    if (!dataStr || dataStr === "[DONE]") continue;
                                    try {
                                        const data = JSON.parse(dataStr);
                                        gotAnyData = true;
                                        if (data.type === "metadata") {
                                            metadata = data.data;
                                            storeSessionDocs(metadata.reranked_documents, query);
                                            loader.thinking.generating();
                                        } else if (data.type === "chunk") {
                                            if (!rawAnswer) loader.thinking.destroy();
                                            rawAnswer += data.content;
                                            answerText.innerHTML = formatMarkdown(rawAnswer) + CARET;
                                            autoScroll();
                                        } else if (data.type === "done") {
                                            clearTimeout(timeoutId);
                                            loader.thinking.rendering();
                                            conversationHistory += `Assistant: ${data.data.answer}\n\n`;
                                            // Final render without the caret, from the
                                            // authoritative answer (citations enforced)
                                            answerText.innerHTML = formatMarkdown(data.data.answer);
                                            bindCodeCopyButtons(answerText);
                                            loader.thinking.destroy();
                                            appendAgentResponseFooter(bubble, data.data, metadata, query);
                                            updateProviderStatus();
                                        }
                                    } catch (parseErr) {
                                        console.warn("SSE parse error:", parseErr, "Line:", line);
                                    }
                                }
                            }
                        }
                    }
                } catch (streamErr) {
                    clearTimeout(timeoutId);
                    loader.thinking.destroy();  // stop the stage timer
                    if (streamErr.name === "AbortError") {
                        if (!gotAnyData) {
                            msgDiv.remove();
                            appendMessage("system", "Error: Request timed out (90s). The backend may still be processing.");
                        } else {
                            answerText.innerHTML = formatMarkdown(rawAnswer || "Response timed out mid-stream.");
                        }
                    } else {
                        console.error("Stream read error:", streamErr);
                        if (!gotAnyData) {
                            msgDiv.remove();
                            appendMessage("system", `Stream Error: ${streamErr.message}`);
                        }
                    }
                    return;
                }

                // Stream ended without a "done" event — surface whatever we got
                loader.thinking.destroy();
                if (!gotAnyData) {
                    msgDiv.remove();
                    appendMessage("system", "Error: No response received from the server.");
                }

            } else {
                // Non-streaming JSON response
                removeLoader(loader);
                const data = await res.json();
                clearTimeout(timeoutId);

                storeSessionDocs(data.reranked_documents, query);

                conversationHistory += `Assistant: ${data.answer}\n\n`;
                appendAgentResponse(data);
                updateProviderStatus();
            }

        } catch (err) {
            clearTimeout(timeoutId);
            removeLoader(loader);
            if (err.name === "AbortError") {
                appendMessage("system", "Error: The request timed out after 90 seconds.");
            } else {
                appendMessage("system", `Network Error: ${err.message}`);
            }
        }

        autoScroll();
    });

    // --- Chat rendering helpers ---

    function appendMessage(sender, text, timestamp = null) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${sender === "user" ? "user-msg" : "system-msg"}`;

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = `<p>${escapeHTML(text)}</p>`;
        bubble.appendChild(timestampSpan(timestamp));

        msgDiv.appendChild(makeAvatar(sender));
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        autoScroll();
    }

    // The loader IS the response message: it starts as a thinking panel
    // cycling pipeline stages, and the streaming handler converts it in
    // place into the answer bubble (no element churn, no flicker).
    function appendLoader() {
        const id = "loader_" + Date.now();
        const msgDiv = document.createElement("div");
        msgDiv.className = "message system-msg";
        msgDiv.id = id;

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        const thinking = buildThinkingPanel();
        bubble.appendChild(thinking.el);

        msgDiv.appendChild(makeAvatar("ai"));
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        autoScroll(true);
        return { id, msgDiv, bubble, thinking };
    }

    function removeLoader(loader) {
        if (loader && loader.thinking) loader.thinking.destroy();
        const el = loader && document.getElementById(loader.id);
        if (el) el.remove();
    }
    
    // ------------------------------------------------------------------
    // Pipeline visualization + performance metrics + developer debug panel
    // ------------------------------------------------------------------

    function buildPipelinePanel(provider, metrics, debug, retrievedCount, rerankedCount) {
        const providerLabel = (provider || "unknown").toUpperCase();
        const wrap = document.createElement("div");
        wrap.className = "pipeline-badge";

        const t = (metrics && metrics.timings_ms) || {};
        const totalLabel = t.total !== undefined ? ` &middot; ${Math.round(t.total)} ms` : "";

        wrap.innerHTML = `
            <button class="pipeline-badge-toggle" aria-expanded="false">
                <i class="fa-solid fa-diagram-project"></i>
                <span>Pipeline &middot; ${escapeHTML(providerLabel)}${totalLabel}</span>
                <i class="fa-solid fa-chevron-down toggle-icon"></i>
            </button>
            <div class="pipeline-badge-details pipeline-details-rich" style="display:none;"></div>
        `;
        const details = wrap.querySelector(".pipeline-badge-details");

        // --- Stage flow with real execution times ---
        let stages;
        if (metrics && metrics.cache_hit) {
            stages = [
                ["User Query", null], ["Query Embedding", t.embedding],
                ["Semantic Cache", t.cache_check, "HIT"], ["Final Answer", null],
            ];
        } else {
            stages = [
                ["User Query", null],
                ["Query Embedding", t.embedding],
                ["Cache Check", t.cache_check, "MISS"],
                ["BM25 Retrieval", t.bm25],
                ["Vector Search (FAISS)", t.vector],
                ["Hybrid Merge (RRF)", t.fusion],
                ["Cross-Encoder Rerank", t.rerank],
                [`Top-${rerankedCount ?? "K"} Selected`, null],
                ["LLM Generation", t.llm],
                ["Final Answer", null],
            ];
        }
        const flow = document.createElement("div");
        flow.className = "pipeline-flow";
        flow.innerHTML = stages.map(([name, ms, tag], i) => {
            const time = ms !== null && ms !== undefined
                ? `<span class="stage-time">${fmtMs(ms)}</span>` : "";
            const tagHtml = tag ? `<span class="stage-tag ${tag === "HIT" ? "tag-hit" : ""}">${tag}</span>` : "";
            const arrow = i < stages.length - 1 ? '<i class="fa-solid fa-arrow-right pb-arrow"></i>' : "";
            return `<span class="pipeline-stage-chip">${escapeHTML(name)}${time}${tagHtml}</span>${arrow}`;
        }).join("");
        details.appendChild(flow);

        // --- Performance metrics panel ---
        if (metrics) {
            const tok = metrics.tokens || {};
            const est = tok.estimated ? " (est.)" : "";
            const perf = document.createElement("div");
            perf.className = "metrics-panel";
            perf.innerHTML = `
                <div class="metrics-panel-title"><i class="fa-solid fa-gauge-high"></i> Performance</div>
                <div class="metrics-grid-mini">
                    <span>Embedding</span><strong>${fmtMs(t.embedding)}</strong>
                    <span>Retrieval</span><strong>${fmtMs(t.retrieval ?? ((t.bm25 ?? 0) + (t.vector ?? 0) + (t.fusion ?? 0)))}</strong>
                    <span>Reranking</span><strong>${fmtMs(t.rerank)}</strong>
                    <span>LLM</span><strong>${fmtMs(t.llm)}</strong>
                    <span>Total</span><strong>${fmtMs(t.total)}</strong>
                    <span>Retrieved chunks</span><strong>${metrics.retrieved_chunks ?? "—"}</strong>
                    <span>Final chunks</span><strong>${metrics.final_chunks ?? "—"}</strong>
                    <span>Tokens used</span><strong>${tok.total ?? "—"}${est}</strong>
                    <span>Answer cache</span><strong class="${metrics.cache_hit ? "cache-hit" : "cache-miss"}">${metrics.cache_hit ? "HIT" : "MISS"}</strong>
                    <span>Retrieval cache</span><strong class="${metrics.retrieval_cache_hit ? "cache-hit" : "cache-miss"}">${metrics.retrieval_cache_hit ? "HIT" : "MISS"}</strong>
                </div>`;
            details.appendChild(perf);
        }

        // --- Developer debug panel ---
        if (debug) {
            const tok = (metrics && metrics.tokens) || {};
            const dbg = document.createElement("div");
            dbg.className = "metrics-panel";
            dbg.innerHTML = `
                <div class="metrics-panel-title"><i class="fa-solid fa-bug"></i> Debug</div>
                <div class="metrics-grid-mini">
                    <span>Request ID</span><strong class="mono">${escapeHTML(debug.request_id || "—")}</strong>
                    <span>LLM Provider</span><strong>${escapeHTML(debug.llm_provider || "—")}</strong>
                    <span>Model</span><strong class="mono">${escapeHTML(debug.llm_model || "—")}</strong>
                    <span>Embedding model</span><strong class="mono">${escapeHTML((debug.embedding_model || "—").split("/").pop())}</strong>
                    <span>Cross-encoder</span><strong class="mono">${escapeHTML((debug.rerank_model || "—").split("/").pop())}</strong>
                    <span>Indexed chunks</span><strong>${debug.chunk_count ?? "—"}</strong>
                    <span>Top-K</span><strong>${debug.top_k ?? "—"}</strong>
                    <span>Rerank-K</span><strong>${debug.rerank_k ?? "—"}</strong>
                    <span>Prompt tokens</span><strong>${tok.prompt ?? "—"}</strong>
                    <span>Completion tokens</span><strong>${tok.completion ?? "—"}</strong>
                    <span>Total tokens</span><strong>${tok.total ?? "—"}</strong>
                </div>`;
            details.appendChild(dbg);
        }

        const toggleBtn  = wrap.querySelector(".pipeline-badge-toggle");
        const toggleIcon = wrap.querySelector(".toggle-icon");
        toggleBtn.addEventListener("click", () => {
            const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
            toggleBtn.setAttribute("aria-expanded", String(!expanded));
            details.style.display = expanded ? "none" : "block";
            toggleIcon.style.transform = expanded ? "" : "rotate(180deg)";
        });
        return wrap;
    }

    // ------------------------------------------------------------------
    // Citations panel: page, chunk, confidence, scores, open/expand
    // ------------------------------------------------------------------

    function buildCitationsPanel(citations) {
        if (!citations || citations.length === 0) return null;
        const citPanel = document.createElement("div");
        citPanel.className = "citations-panel";
        citPanel.innerHTML = `<span class="section-title">References Retrieved</span>`;

        citations.forEach(cite => {
            const parts   = cite.split("#");
            const srcFile = parts[0];
            const srcSec  = parts[1] || "";
            const doc     = currentSessionDocs[cite] || currentSessionDocs[srcFile] || {};

            const row = document.createElement("div");
            row.className = "citation-row";

            const confidence = doc.confidence !== undefined
                ? `${(doc.confidence * 100).toFixed(1)}%` : "—";
            const chunkNo = doc.chunk_id
                ? doc.chunk_id.split("_").pop() : "—";

            row.innerHTML = `
                <button class="citation-item-btn citation-main-btn">
                    <i class="fa-solid fa-file-shield"></i>
                    <span class="citation-titles">
                        <span class="citation-doc-name">${escapeHTML(srcFile)}${srcSec ? " &middot; " + escapeHTML(srcSec) : ""}</span>
                        <span class="citation-sub">
                            Page ${doc.page ?? "—"} &middot; Chunk ${escapeHTML(String(chunkNo))}
                            &middot; Confidence ${confidence}
                            &middot; Score ${fmtScore(doc.rerank_score, 2)}
                        </span>
                    </span>
                </button>
                <button class="citation-icon-btn open-src" title="Open source document">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </button>
                <button class="citation-icon-btn expand-chunk" title="Expand chunk text">
                    <i class="fa-solid fa-expand"></i>
                </button>
            `;

            const expandDiv = document.createElement("div");
            expandDiv.className = "citation-expand";
            expandDiv.style.display = "none";
            expandDiv.innerHTML = doc.content
                ? `<div class="doc-content-block citation-chunk-text">${highlightTerms(escapeHTML(doc.content), doc.query)}</div>`
                : `<div class="doc-content-block citation-chunk-text">Chunk text unavailable.</div>`;

            row.querySelector(".citation-main-btn")
               .addEventListener("click", () => openCitationModal(cite));
            row.querySelector(".open-src")
               .addEventListener("click", () => openSourceDocument(srcFile));
            row.querySelector(".expand-chunk").addEventListener("click", (e) => {
                const open = expandDiv.style.display !== "none";
                expandDiv.style.display = open ? "none" : "block";
                e.currentTarget.innerHTML = open
                    ? '<i class="fa-solid fa-expand"></i>'
                    : '<i class="fa-solid fa-compress"></i>';
            });

            citPanel.appendChild(row);
            citPanel.appendChild(expandDiv);
        });
        return citPanel;
    }

    // Shared actions row: copy answer + regenerate response
    function buildActionsRow(answer, query) {
        const row = document.createElement("div");
        row.className = "msg-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "msg-action-btn";
        copyBtn.title = "Copy answer";
        copyBtn.setAttribute("aria-label", "Copy answer to clipboard");
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> <span>Copy</span>';
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(answer).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> <span>Copied</span>';
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> <span>Copy</span>';
                }, 2000);
            });
        });
        row.appendChild(copyBtn);

        if (query) {
            const regenBtn = document.createElement("button");
            regenBtn.className = "msg-action-btn";
            regenBtn.title = "Ask this question again";
            regenBtn.setAttribute("aria-label", "Regenerate response");
            regenBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> <span>Regenerate</span>';
            regenBtn.addEventListener("click", () => {
                if (document.querySelector(".thinking-panel")) return; // one at a time
                queryInput.value = query;
                chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            });
            row.appendChild(regenBtn);
        }
        return row;
    }

    function appendAgentResponseFooter(bubble, doneData, metadata, query) {
        bubble.appendChild(timestampSpan());

        if (doneData.cached) {
            const cacheBadge = document.createElement("span");
            cacheBadge.className = "cache-badge";
            cacheBadge.innerHTML = '<i class="fa-solid fa-bolt"></i> Served from Cache';
            bubble.appendChild(cacheBadge);
        }

        // Pipeline visualization + performance/debug panels (real metrics)
        bubble.appendChild(buildPipelinePanel(
            metadata.provider,
            doneData.metrics,
            doneData.debug,
            (metadata.retrieved_documents || []).length,
            (metadata.reranked_documents  || []).length,
        ));

        // Citations footer panel
        const citPanel = buildCitationsPanel(doneData.citations);
        if (citPanel) bubble.appendChild(citPanel);

        bubble.appendChild(buildActionsRow(doneData.answer, query));

        // Bind inline citation link clicks
        bubble.querySelectorAll(".citation-link").forEach(link => {
            link.addEventListener("click", () => openCitationModal(link.getAttribute("data-cite")));
        });

        autoScroll();
    }

    function appendAgentResponse(data) {
        const msgDiv = document.createElement("div");
        msgDiv.className = "message system-msg";

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = `<div class="msg-answer-text">${formatMarkdown(data.answer)}</div>`;
        bindCodeCopyButtons(bubble);

        msgDiv.appendChild(makeAvatar("ai"));
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);

        // Same footer as the streaming path (timestamp, cache badge,
        // pipeline, citations, copy + regenerate)
        appendAgentResponseFooter(bubble, data, data, data.query);
    }

    // ----------------------------------------------------------------
    // Citation modal
    // ----------------------------------------------------------------
    const modal         = document.getElementById("doc-viewer-modal");
    const closeModalBtn = document.getElementById("close-modal-btn");

    function openCitationModal(citeKey) {
        const parts   = citeKey.split("#");
        const source  = parts[0];
        const section = parts.length > 1 ? parts[1] : "General Reference";

        document.getElementById("modal-doc-title").innerText  = "Citation Verification";
        document.getElementById("modal-doc-source").innerText = source;

        const doc = currentSessionDocs[citeKey] || currentSessionDocs[source] || {};
        const sectionEl = document.getElementById("modal-doc-section");
        sectionEl.innerText = doc.page ? `${section} · Page ${doc.page}` : section;

        // Retrieval metadata + scores grid
        const extra = document.getElementById("modal-doc-extra");
        if (doc.chunk_id !== undefined || doc.rerank_score !== undefined) {
            const conf = doc.confidence !== undefined
                ? `${(doc.confidence * 100).toFixed(1)}%` : "—";
            extra.style.display = "grid";
            extra.innerHTML = `
                <span>Chunk ID</span><strong class="mono">${escapeHTML(doc.chunk_id || "—")}</strong>
                <span>Page</span><strong>${doc.page ?? "—"}</strong>
                <span>Retrieval method</span><strong>${retrievalMethodOf(doc)}</strong>
                <span>Confidence</span><strong>${conf}</strong>
                <span>Cross-encoder score</span><strong>${fmtScore(doc.rerank_score, 3)}</strong>
                <span>Hybrid (RRF) score</span><strong>${fmtScore(doc.score, 4)}</strong>
                <span>BM25 score</span><strong>${fmtScore(doc.bm25_score, 2)}</strong>
                <span>Vector similarity</span><strong>${fmtScore(doc.vector_similarity, 3)}</strong>
                <span>Matched query</span><strong class="mono">${escapeHTML(doc.query || "—")}</strong>
            `;
        } else {
            extra.style.display = "none";
            extra.innerHTML = "";
        }

        // Full chunk text with matched query terms highlighted
        const contentEl = document.getElementById("modal-doc-content");
        if (doc.content) {
            contentEl.innerHTML = highlightTerms(escapeHTML(doc.content), doc.query);
        } else {
            contentEl.innerText =
                "Reference context loaded dynamically. Content snippet unavailable in local cache.";
        }

        // Open Source button
        const openBtn = document.getElementById("modal-open-source-btn");
        openBtn.onclick = () => openSourceDocument(source);

        modal.classList.add("active");
    }

    closeModalBtn.addEventListener("click", () => modal.classList.remove("active"));
    window.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("active"); });

    // ----------------------------------------------------------------
    // 2. RETRIEVAL STEP INSPECTOR
    // ----------------------------------------------------------------
    const debugForm  = document.getElementById("debug-search-form");
    const debugInput = document.getElementById("debug-query-input");
    const debugGrid  = document.getElementById("debug-visualizer-container");

    debugForm.addEventListener("submit", async e => {
        e.preventDefault();
        const query = debugInput.value.trim();
        if (!query) return;

        debugGrid.innerHTML = `
            <div class="debug-empty-state">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <h3>Running Diagnostic Pipeline</h3>
                <p>Retrieving documents and calculating scores…</p>
            </div>`;

        try {
            const res = await Auth.fetch(`/api/debug-retrieve?query=${encodeURIComponent(query)}`);
            if (!res.ok) {
                const err = await res.json();
                debugGrid.innerHTML = `<div class="debug-empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Error</h3><p>${escapeHTML(err.detail)}</p></div>`;
                return;
            }
            renderDebugColumns(await res.json());
        } catch (err) {
            debugGrid.innerHTML = `<div class="debug-empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Network Error</h3><p>${escapeHTML(err.message)}</p></div>`;
        }
    });

    function renderDebugColumns(data) {
        debugGrid.innerHTML = "";

        // --- Pipeline timings strip (real per-stage execution times) ---
        if (data.timings_ms) {
            const t = data.timings_ms;
            const strip = document.createElement("div");
            strip.className = "debug-timings-strip";
            strip.innerHTML = `
                <span class="library-stat-chip"><i class="fa-solid fa-list-ol"></i> BM25 <strong>${fmtMs(t.bm25)}</strong></span>
                <span class="library-stat-chip"><i class="fa-solid fa-cube"></i> Vector <strong>${fmtMs(t.vector)}</strong></span>
                <span class="library-stat-chip"><i class="fa-solid fa-network-wired"></i> Fusion <strong>${fmtMs(t.fusion)}</strong></span>
                <span class="library-stat-chip"><i class="fa-solid fa-database"></i> Retrieval <strong>${fmtMs(t.retrieval)}</strong></span>
                <span class="library-stat-chip"><i class="fa-solid fa-filter-circle-dollar"></i> Rerank <strong>${fmtMs(t.rerank)}</strong></span>
                <span class="library-stat-chip"><i class="fa-solid fa-stopwatch"></i> Total <strong>${fmtMs(t.total)}</strong></span>
                ${data.retrieval_cache_hit
                    ? '<span class="library-stat-chip"><i class="fa-solid fa-bolt"></i> <strong class="cache-hit">Retrieval cache HIT</strong></span>'
                    : ""}
            `;
            debugGrid.appendChild(strip);
        }

        // Build source#section → rrfRank lookup for rank-change arrows in the reranked column
        const rrfRankMap = {};
        (data.rrf || []).forEach((item, i) => {
            rrfRankMap[`${item.source}#${item.section}`] = i + 1;
        });

        const columns = [
            { title: "BM25 Sparse (Keyword)",    icon: "fa-solid fa-list-ol",              key: "bm25",     scoreKey: "bm25_score"        },
            { title: "FAISS Dense (Semantic)",    icon: "fa-solid fa-cube",                 key: "vector",   scoreKey: "vector_similarity" },
            { title: "RRF Fusion (Combined)",     icon: "fa-solid fa-network-wired",        key: "rrf",      scoreKey: "score"             },
            { title: "Cross-Encoder (Reranked)",  icon: "fa-solid fa-filter-circle-dollar", key: "reranked", scoreKey: "rerank_score"      },
        ];

        columns.forEach(col => {
            const colDiv = document.createElement("div");
            colDiv.className = "debug-column";

            const colHeader = document.createElement("div");
            colHeader.className = "column-header";
            colHeader.innerHTML = `<i class="${col.icon}"></i> <h3>${col.title}</h3>`;
            colDiv.appendChild(colHeader);

            const colBody = document.createElement("div");
            colBody.className = "column-body";

            const docList = data[col.key];
            if (!docList || docList.length === 0) {
                colBody.innerHTML = `<div class="text-center" style="color:var(--text-muted);margin-top:20px;">No candidates retrieved.</div>`;
            } else {
                // Normalize scores for progress bars. The cross-encoder emits
                // logits (can be negative) — use its confidence (sigmoid) for
                // the bar instead.
                const barVal = (item) => col.key === "reranked"
                    ? (item.confidence ?? 0)
                    : (item[col.scoreKey] ?? item.score ?? 0);
                const maxScore = Math.max(...docList.map(barVal), 0.0001);

                docList.forEach((item, index) => {
                    const card = document.createElement("div");
                    card.className = "debug-card";

                    const page     = item.page || 1;
                    const section  = item.section || "General";
                    const scorePct = Math.max(0, Math.min(100, Math.round((barVal(item) / maxScore) * 100)));

                    // Rank-change arrow for reranked column
                    let rankChangeHtml = "";
                    if (col.key === "reranked") {
                        const rrfRank = rrfRankMap[`${item.source}#${item.section}`];
                        if (rrfRank !== undefined) {
                            const delta = rrfRank - (index + 1);
                            if (delta > 0) {
                                rankChangeHtml = `<span class="rank-arrow rank-up" title="Up ${delta} from RRF">&#9650;${delta}</span>`;
                            } else if (delta < 0) {
                                rankChangeHtml = `<span class="rank-arrow rank-down" title="Down ${Math.abs(delta)} from RRF">&#9660;${Math.abs(delta)}</span>`;
                            } else {
                                rankChangeHtml = `<span class="rank-arrow rank-same">&#8212;</span>`;
                            }
                        }
                    }

                    card.innerHTML = `
                        <div class="card-index-badge">${index + 1}${rankChangeHtml}</div>
                        <span class="source" title="${escapeHTML(item.source)}#${escapeHTML(section)}">${escapeHTML(item.source)}</span>
                        <div class="content debug-content-clamp">${escapeHTML(item.content)}</div>
                        <button class="expand-text-btn">Show more</button>
                        <div class="metrics-row">
                            <span class="tag section-tag">${escapeHTML(section)}</span>
                            <span class="tag">p.${page}</span>
                            <span class="tag" title="${escapeHTML(item.chunk_id || "")}">#${escapeHTML((item.chunk_id || "—").split("_").pop())}</span>
                        </div>`;

                    const metricsRow = card.querySelector(".metrics-row");
                    const addTag = (text, cls = "tag") => {
                        const el = document.createElement("span");
                        el.className = cls;
                        el.innerText = text;
                        metricsRow.appendChild(el);
                    };
                    // Better tables: secondary numeric details render as an
                    // aligned label/value grid instead of loose pill tags —
                    // easier to scan across cards than free-floating chips.
                    const addKvTable = (rows) => {
                        const kv = document.createElement("div");
                        kv.className = "debug-kv-table";
                        kv.innerHTML = rows.map(([label, value], i) =>
                            `<span class="kv-label${i === 0 ? " kv-row-alt" : ""}">${escapeHTML(label)}</span>
                             <span class="kv-value${i === 0 ? " kv-row-alt" : ""}">${escapeHTML(value)}</span>`
                        ).join("");
                        card.insertBefore(kv, metricsRow);
                    };

                    if (col.key === "bm25") {
                        addTag(`BM25: ${fmtScore(item.bm25_score, 2)}`, "tag rrf-score-tag");
                    } else if (col.key === "vector") {
                        addTag(`Sim: ${fmtScore(item.vector_similarity, 3)}`, "tag rrf-score-tag");
                        addKvTable([["L2 distance", fmtScore(item.vector_distance, 3)]]);
                    } else if (col.key === "rrf") {
                        addTag(`RRF: ${fmtScore(item.score, 4)}`, "tag rrf-score-tag");
                        addKvTable([
                            ["Vector rank", item.vector_rank !== null && item.vector_rank !== undefined ? `#${item.vector_rank}` : "—"],
                            ["BM25 rank",   item.bm25_rank   !== null && item.bm25_rank   !== undefined ? `#${item.bm25_rank}`   : "—"],
                            ["BM25 score",  fmtScore(item.bm25_score, 2)],
                            ["Vector sim",  fmtScore(item.vector_similarity, 3)],
                        ]);
                    } else if (col.key === "reranked") {
                        const confPct = item.confidence !== undefined ? item.confidence * 100 : null;
                        addTag(`CE: ${fmtScore(item.rerank_score, 3)}`, "tag rerank-score-tag");
                        addTag(
                            confPct !== null ? `Conf: ${confPct.toFixed(1)}%` : "Conf: —",
                            `tag ${confPct !== null ? confClass(confPct) : ""}`
                        );
                        addKvTable([
                            ["RRF score",  fmtScore(item.score, 4)],
                            ["Final rank", `#${item.final_rank ?? index + 1}`],
                        ]);
                    }

                    // Score progress bar
                    const barDiv = document.createElement("div");
                    barDiv.className = "score-bar-track";
                    const barClass = col.key === "reranked" ? "bar-rerank" : col.key === "rrf" ? "bar-rrf" : "";
                    barDiv.innerHTML = `<div class="score-bar-fill ${barClass}" style="width:${scorePct}%"></div>`;
                    card.appendChild(barDiv);

                    // Expand/collapse toggle
                    const contentEl = card.querySelector(".debug-content-clamp");
                    const expandBtn = card.querySelector(".expand-text-btn");
                    let isExpanded  = false;
                    expandBtn.addEventListener("click", () => {
                        isExpanded = !isExpanded;
                        contentEl.classList.toggle("debug-content-clamp", !isExpanded);
                        expandBtn.textContent = isExpanded ? "Show less" : "Show more";
                    });

                    colBody.appendChild(card);
                });
            }

            colDiv.appendChild(colBody);
            debugGrid.appendChild(colDiv);
        });
    }

    // ----------------------------------------------------------------
    // 3. EVALUATION PANEL
    // ----------------------------------------------------------------
    const runEvalBtn       = document.getElementById("run-eval-btn");
    const compareRunsBtn   = document.getElementById("compare-runs-btn");
    const evalHistoryTbody = document.getElementById("eval-history-tbody");
    let   metricsChart     = null;
    let   radarChart       = null;
    let   lastHistory      = [];
    let   compareMode      = false;

    runEvalBtn.addEventListener("click", async () => {
        runEvalBtn.disabled = true;
        runEvalBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Evaluating…`;

        try {
            const res = await Auth.fetch("/api/evaluate", { method: "POST" });
            if (!res.ok) {
                const err = await res.json();
                alert(`Evaluation failed: ${err.detail || "Unknown error."}`);
            } else {
                await loadEvaluationHistory();
                updateProviderStatus();
            }
        } catch (err) {
            console.error("Evaluation network failure:", err);
            alert("Network error while triggering evaluation.");
        } finally {
            runEvalBtn.disabled = false;
            runEvalBtn.innerHTML = `<i class="fa-solid fa-play"></i> Trigger Evaluation`;
        }
    });

    if (compareRunsBtn) {
        compareRunsBtn.addEventListener("click", () => {
            compareMode = !compareMode;
            compareRunsBtn.classList.toggle("active", compareMode);
            compareRunsBtn.innerHTML = compareMode
                ? `<i class="fa-solid fa-code-compare"></i> Exit Compare`
                : `<i class="fa-solid fa-code-compare"></i> Compare Runs`;
            if (lastHistory.length > 0) {
                const latest = lastHistory[lastHistory.length - 1];
                const prev   = lastHistory[lastHistory.length - 2];
                renderMetricCards(latest, compareMode ? prev : null);
            }
        });
    }

    async function loadEvaluationHistory() {
        try {
            await ensureChartJs();
            const res     = await Auth.fetch("/api/evaluate/history");
            const history = await res.json();
            if (!history || history.length === 0) return;

            lastHistory = history;
            const latest = history[history.length - 1];
            const prev   = history[history.length - 2];

            renderMetricCards(latest, compareMode ? prev : null);
            renderHistoryTable(history);
            drawMetricsChart(history);
            drawRadarChart(latest);

            if (history.length >= 2 && compareRunsBtn) {
                compareRunsBtn.style.display = "flex";
            }
        } catch (err) {
            console.error("Failed to load evaluation history:", err);
        }
    }

    function deltaHtml(current, previous, isHigherBetter = true) {
        if (previous === undefined || previous === null) return "";
        const diff = current - previous;
        if (Math.abs(diff) < 0.001) return `<span class="delta-flat">&mdash;</span>`;
        const isGood = isHigherBetter ? diff > 0 : diff < 0;
        const arrow  = diff > 0 ? "&#9650;" : "&#9660;";
        const cls    = isGood ? "delta-up" : "delta-down";
        return `<span class="${cls}">${arrow}${Math.abs(diff).toFixed(2)}</span>`;
    }

    function renderMetricCards(run, prev = null) {
        document.getElementById("metrics-cards-container").innerHTML = `
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(16,185,129,0.12);">
                    <i class="fa-solid fa-bullseye" style="color:#10B981;"></i>
                </div>
                <span class="card-label">Retrieval Recall</span>
                <h3 class="card-value" data-fmt="pct0" data-target="${run.mean_retrieval_recall}">0%</h3>
                <p class="card-desc">Ground-truth docs fetched ${deltaHtml(run.mean_retrieval_recall, prev?.mean_retrieval_recall)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(139,92,246,0.12);">
                    <i class="fa-solid fa-quote-left" style="color:#8B5CF6;"></i>
                </div>
                <span class="card-label">Citation Precision</span>
                <h3 class="card-value" data-fmt="pct0" data-target="${run.mean_citation_precision}">0%</h3>
                <p class="card-desc">Valid citations generated ${deltaHtml(run.mean_citation_precision, prev?.mean_citation_precision)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(59,130,246,0.12);">
                    <i class="fa-solid fa-brain" style="color:#3B82F6;"></i>
                </div>
                <span class="card-label">Faithfulness</span>
                <h3 class="card-value" data-fmt="dec2" data-target="${run.mean_faithfulness ?? 0}">0.00</h3>
                <p class="card-desc">Answer alignment to context ${deltaHtml(run.mean_faithfulness, prev?.mean_faithfulness)}</p>
            </div>
            <div class="metric-card">
                <div class="card-icon-wrap" style="background:rgba(239,68,68,0.12);">
                    <i class="fa-solid fa-ghost" style="color:#EF4444;"></i>
                </div>
                <span class="card-label">Hallucination</span>
                <h3 class="card-value" data-fmt="dec2" data-target="${run.mean_hallucination ?? 0}">0.00</h3>
                <p class="card-desc">Inverse of faithfulness score ${deltaHtml(run.mean_hallucination, prev?.mean_hallucination, false)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(245,158,11,0.12);">
                    <i class="fa-solid fa-trophy" style="color:#F59E0B;"></i>
                </div>
                <span class="card-label">Answer Relevance</span>
                <h3 class="card-value" data-fmt="dec2" data-target="${run.mean_answer_relevance ?? 0}">0.00</h3>
                <p class="card-desc">Semantic similarity to query ${deltaHtml(run.mean_answer_relevance, prev?.mean_answer_relevance)}</p>
            </div>
            <div class="metric-card">
                <div class="card-icon-wrap" style="background:rgba(239,68,68,0.12);">
                    <i class="fa-solid fa-stopwatch" style="color:#EF4444;"></i>
                </div>
                <span class="card-label">Mean Latency</span>
                <h3 class="card-value" data-fmt="sec2" data-target="${run.mean_latency}">0.00s</h3>
                <p class="card-desc">Average generation time ${deltaHtml(run.mean_latency, prev?.mean_latency, false)}</p>
            </div>
        `;

        const FMT = {
            pct0: v => `${Math.round(v * 100)}%`,
            dec2: v => v.toFixed(2),
            sec2: v => `${v.toFixed(2)}s`,
        };
        document.querySelectorAll("#metrics-cards-container .card-value[data-target]").forEach(el => {
            const target = parseFloat(el.dataset.target) || 0;
            animateCounter(el, target, FMT[el.dataset.fmt] || (v => v.toFixed(2)));
        });

        renderGauge(document.getElementById("faithfulness-gauge"), run.mean_faithfulness ?? 0);
        renderGauge(document.getElementById("hallucination-gauge"), run.mean_hallucination ?? 0, { invert: true });
    }

    function renderHistoryTable(history) {
        evalHistoryTbody.innerHTML = "";
        // Older eval runs predate the faithfulness/relevance metrics — default
        // missing numbers to 0 so one legacy row cannot break the whole table.
        [...history].reverse().forEach(run => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${formatDate(run.timestamp)}</td>
                <td><span class="tag">${escapeHTML(run.llm_provider)}</span></td>
                <td>${((run.mean_retrieval_recall ?? 0) * 100).toFixed(0)}%</td>
                <td>${(run.mean_mrr ?? 0).toFixed(2)}</td>
                <td>${((run.mean_citation_precision ?? 0) * 100).toFixed(0)}%</td>
                <td>${(run.mean_faithfulness ?? 0).toFixed(2)}</td>
                <td>${(run.mean_answer_relevance ?? 0).toFixed(2)}</td>
                <td>${(run.mean_latency ?? 0).toFixed(2)}s</td>`;
            evalHistoryTbody.appendChild(tr);
        });
    }

    function drawMetricsChart(history) {
        const ctx    = document.getElementById("metricsChart").getContext("2d");
        const labels = history.map((h, i) => `Run #${i + 1} (${new Date(h.timestamp * 1000).toLocaleDateString()})`);

        if (metricsChart) metricsChart.destroy();

        metricsChart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Retrieval Recall",
                        data:            history.map(h => h.mean_retrieval_recall),
                        borderColor:     "#10B981",
                        backgroundColor: "rgba(16, 185, 129, 0.08)",
                        borderWidth: 2, tension: 0.3, fill: true,
                        pointRadius: 4, pointHoverRadius: 6,
                    },
                    {
                        label: "Citation Precision",
                        data:            history.map(h => h.mean_citation_precision),
                        borderColor:     "#8B5CF6",
                        backgroundColor: "rgba(139, 92, 246, 0.08)",
                        borderWidth: 2, tension: 0.3, fill: true,
                        pointRadius: 4, pointHoverRadius: 6,
                    },
                    {
                        label: "Faithfulness",
                        data:            history.map(h => h.mean_faithfulness),
                        borderColor:     "#3B82F6",
                        backgroundColor: "rgba(59, 130, 246, 0.08)",
                        borderWidth: 2, tension: 0.3, fill: true,
                        pointRadius: 4, pointHoverRadius: 6,
                    },
                    {
                        label: "Hallucination",
                        data:            history.map(h => h.mean_hallucination),
                        borderColor:     "#EF4444",
                        backgroundColor: "rgba(239, 68, 68, 0.08)",
                        borderWidth: 2, tension: 0.3, fill: true,
                        pointRadius: 4, pointHoverRadius: 6,
                    },
                    {
                        label: "MRR",
                        data:            history.map(h => h.mean_mrr),
                        borderColor:     "#F59E0B",
                        backgroundColor: "rgba(245, 158, 11, 0.08)",
                        borderWidth: 2, tension: 0.3, fill: false,
                        pointRadius: 4, pointHoverRadius: 6,
                        borderDash: [4, 4],
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: {
                        labels: { color: "#9CA3AF", font: { family: "Plus Jakarta Sans", size: 12 } },
                    },
                    tooltip: {
                        backgroundColor: "#131E35",
                        borderColor: "rgba(255,255,255,0.08)",
                        borderWidth: 1,
                        titleColor: "#F3F4F6",
                        bodyColor: "#9CA3AF",
                    },
                },
                scales: {
                    x: {
                        grid:  { color: "rgba(255,255,255,0.03)" },
                        ticks: { color: "#6B7280", font: { family: "Plus Jakarta Sans" } },
                    },
                    y: {
                        min:   0,
                        max:   1.1,
                        grid:  { color: "rgba(255,255,255,0.03)" },
                        ticks: { color: "#6B7280", font: { family: "Plus Jakarta Sans" } },
                    },
                },
            },
        });
    }

    function drawRadarChart(run) {
        const ctx = document.getElementById("radarChart");
        if (!ctx) return;

        if (radarChart) radarChart.destroy();

        radarChart = new Chart(ctx.getContext("2d"), {
            type: "radar",
            data: {
                labels: ["Recall", "Citation", "Faithful", "Ans Rel", "Speed"],
                datasets: [{
                    label: "Latest Run",
                    data: [
                        run.mean_retrieval_recall,
                        run.mean_citation_precision,
                        run.mean_faithfulness,
                        run.mean_answer_relevance,
                        Math.max(0, Math.min(1, 1 - run.mean_latency / 10)),
                    ],
                    borderColor:          "#6366F1",
                    backgroundColor:      "rgba(99, 102, 241, 0.15)",
                    borderWidth:          2,
                    pointBackgroundColor: "#6366F1",
                    pointBorderColor:     "#fff",
                    pointRadius:          4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#131E35",
                        borderColor: "rgba(255,255,255,0.08)",
                        borderWidth: 1,
                        titleColor: "#F3F4F6",
                        bodyColor: "#9CA3AF",
                    },
                },
                scales: {
                    r: {
                        min: 0,
                        max: 1,
                        ticks: {
                            color: "#6B7280",
                            backdropColor: "transparent",
                            stepSize: 0.25,
                            font: { size: 10 },
                        },
                        grid:         { color: "rgba(255,255,255,0.06)" },
                        pointLabels:  { color: "#9CA3AF", font: { family: "Plus Jakarta Sans", size: 12 } },
                        angleLines:   { color: "rgba(255,255,255,0.06)" },
                    },
                },
            },
        });
    }

    // ----------------------------------------------------------------
    // ADMIN DASHBOARD — built entirely from existing endpoints
    // (GET /api/auth/users, GET /api/library, GET /metrics) so no backend
    // change is required. /metrics is Prometheus text format; parsed
    // client-side via parsePrometheusMetrics().
    // ----------------------------------------------------------------
    let adminDocsChart = null, adminApiChart = null, adminUsersChart = null;
    const CHART_COLORS = ["#818CF8", "#C084FC", "#10B981", "#F59E0B", "#EF4444", "#60A5FA"];

    function renderAdminStatCard(icon, color, label, target, fmt, sub = "") {
        const wrap = document.createElement("div");
        wrap.className = "metric-card";
        wrap.innerHTML = `
            <div class="card-icon-wrap" style="background:${color}1F;"><i class="fa-solid ${icon}" style="color:${color};"></i></div>
            <span class="card-label">${escapeHTML(label)}</span>
            <h3 class="card-value">0</h3>
            <p class="card-desc card-sub">${escapeHTML(sub)}</p>`;
        document.getElementById("admin-stats-grid").appendChild(wrap);
        animateCounter(wrap.querySelector(".card-value"), target, fmt);
    }

    function activityIcon(type) {
        return { upload: "icon-upload fa-cloud-arrow-up", completed: "icon-complete fa-circle-check",
                 failed: "icon-failed fa-circle-xmark", eval: "icon-eval fa-flask" }[type] || "icon-upload fa-circle-info";
    }

    async function loadAdminDashboard() {
        if (!Auth.isAdmin()) return;
        try {
            await ensureChartJs();
            const [usersRes, libRes, metricsRes, evalRes] = await Promise.all([
                Auth.fetch("/api/auth/users"),
                Auth.fetch("/api/library"),
                Auth.fetch("/metrics"),
                Auth.fetch("/api/evaluate/history"),
            ]);
            const users = usersRes.ok ? await usersRes.json() : [];
            const lib   = libRes.ok ? await libRes.json() : { documents: [], total_documents: 0, total_chunks: 0 };
            const metricsText = metricsRes.ok ? await metricsRes.text() : "";
            const evalHistory = evalRes.ok ? await evalRes.json() : [];
            const samples = parsePrometheusMetrics(metricsText);
            const docs = lib.documents || [];

            // --- Stat cards -------------------------------------------------
            const totalStorage = docs.reduce((a, d) => a + (d.size_bytes || 0), 0);
            const totalRequests = sumSamples(samples, "rag_http_requests_total");
            const totalErrors   = sumSamples(samples, "rag_http_errors_total");
            const activeUsers   = sumSamples(samples, "rag_active_users");
            const activeConvos  = sumSamples(samples, "rag_active_conversations");

            document.getElementById("admin-stats-grid").innerHTML = "";
            renderAdminStatCard("fa-users",        "#818CF8", "Total Users",         users.length,        v => Math.round(v));
            renderAdminStatCard("fa-user-check",   "#10B981", "Active Sessions",     activeUsers,         v => Math.round(v), "users, last 5 min");
            renderAdminStatCard("fa-comments",     "#60A5FA", "Active Conversations",activeConvos,        v => Math.round(v), "last 5 min");
            renderAdminStatCard("fa-file-lines",   "#C084FC", "Total Documents",     lib.total_documents ?? docs.length, v => Math.round(v));
            renderAdminStatCard("fa-cubes",        "#F59E0B", "Total Chunks",        lib.total_chunks ?? 0, v => Math.round(v));
            renderAdminStatCard("fa-hard-drive",   "#EF4444", "Storage Used",        totalStorage,        v => formatBytes(v));
            renderAdminStatCard("fa-server",       "#10B981", "API Requests",        totalRequests,       v => Math.round(v).toLocaleString());
            renderAdminStatCard("fa-triangle-exclamation", "#EF4444", "Server Errors (5xx)", totalErrors, v => Math.round(v));

            // --- Charts -------------------------------------------------------
            const typeCounts = {};
            docs.forEach(d => { typeCounts[d.file_type] = (typeCounts[d.file_type] || 0) + 1; });
            if (adminDocsChart) adminDocsChart.destroy();
            adminDocsChart = new Chart(document.getElementById("adminDocsChart").getContext("2d"), {
                type: "doughnut",
                data: {
                    labels: Object.keys(typeCounts).map(t => `.${t}`),
                    datasets: [{ data: Object.values(typeCounts), backgroundColor: CHART_COLORS, borderWidth: 0 }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: "bottom", labels: { color: "#9CA3AF", boxWidth: 10, font: { family: "Plus Jakarta Sans", size: 11 } } } },
                },
            });

            const pathTotals = {};
            findSamples(samples, "rag_http_requests_total").forEach(s => {
                pathTotals[s.labels.path || "?"] = (pathTotals[s.labels.path || "?"] || 0) + s.value;
            });
            const topPaths = Object.entries(pathTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
            if (adminApiChart) adminApiChart.destroy();
            adminApiChart = new Chart(document.getElementById("adminApiChart").getContext("2d"), {
                type: "bar",
                data: {
                    labels: topPaths.map(([p]) => p),
                    datasets: [{ data: topPaths.map(([, v]) => v), backgroundColor: "#818CF8", borderRadius: 6 }],
                },
                options: {
                    indexAxis: "y", responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: "rgba(255,255,255,0.03)" }, ticks: { color: "#6B7280" } },
                        y: { grid: { display: false }, ticks: { color: "#6B7280", font: { size: 10 } } },
                    },
                },
            });

            const roleCounts = users.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {});
            if (adminUsersChart) adminUsersChart.destroy();
            adminUsersChart = new Chart(document.getElementById("adminUsersChart").getContext("2d"), {
                type: "doughnut",
                data: {
                    labels: Object.keys(roleCounts),
                    datasets: [{ data: Object.values(roleCounts), backgroundColor: ["#F59E0B", "#818CF8"], borderWidth: 0 }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: "bottom", labels: { color: "#9CA3AF", boxWidth: 10, font: { family: "Plus Jakarta Sans", size: 11 } } } },
                },
            });

            // --- API usage detail chips ---------------------------------------
            const cacheHit  = sumSamples(samples, "rag_semantic_cache_events_total", { result: "hit" });
            const cacheMiss = sumSamples(samples, "rag_semantic_cache_events_total", { result: "miss" });
            const cacheRatio = (cacheHit + cacheMiss) > 0 ? (cacheHit / (cacheHit + cacheMiss)) * 100 : null;
            const meanLatency = (metric) => {
                const sum = sumSamples(samples, `${metric}_sum`);
                const count = sumSamples(samples, `${metric}_count`);
                return count > 0 ? sum / count : null;
            };
            const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

            const chips = [
                { label: "Error Rate", value: `${errorRate.toFixed(2)}%`, cls: errorRate > 5 ? "chip-bad" : errorRate > 1 ? "chip-warn" : "chip-good" },
                { label: "Cache Hit Ratio", value: cacheRatio !== null ? `${cacheRatio.toFixed(1)}%` : "—", cls: cacheRatio >= 50 ? "chip-good" : "chip-warn" },
                { label: "Avg Retrieval", value: meanLatency("rag_retrieval_seconds") !== null ? `${(meanLatency("rag_retrieval_seconds") * 1000).toFixed(0)} ms` : "—" },
                { label: "Avg Rerank", value: meanLatency("rag_rerank_seconds") !== null ? `${(meanLatency("rag_rerank_seconds") * 1000).toFixed(0)} ms` : "—" },
                { label: "Avg LLM", value: meanLatency("rag_llm_seconds") !== null ? `${meanLatency("rag_llm_seconds").toFixed(2)} s` : "—" },
                { label: "Uploads Total", value: Math.round(sumSamples(samples, "rag_uploads_total")).toLocaleString() },
            ];
            document.getElementById("admin-api-chips").innerHTML = chips.map(c => `
                <div class="admin-api-chip ${c.cls || ""}">
                    <span class="chip-label">${escapeHTML(c.label)}</span>
                    <span class="chip-value">${escapeHTML(c.value)}</span>
                </div>`).join("");

            // --- Users table ----------------------------------------------------
            const usersTbody = document.getElementById("admin-users-tbody");
            usersTbody.innerHTML = users.length === 0
                ? `<tr><td colspan="5" class="text-center">No users found.</td></tr>`
                : users.map(u => `
                    <tr>
                        <td>${escapeHTML(u.full_name)}</td>
                        <td>${escapeHTML(u.email)}</td>
                        <td><span class="tag ${u.role === "admin" ? "conf-mid" : ""}">${escapeHTML(u.role)}</span></td>
                        <td><span class="tag ${u.is_active ? "conf-high" : "conf-low"}">${u.is_active ? "Active" : "Disabled"}</span></td>
                        <td>${escapeHTML(formatDate(new Date(u.created_at).getTime() / 1000))}</td>
                    </tr>`).join("");

            // --- Recent Activity feed (real events: uploads + eval runs) -------
            const events = [];
            docs.forEach(d => {
                events.push({
                    ts: new Date(d.uploaded_at).getTime(),
                    type: d.status === "failed" ? "failed" : d.status === "completed" ? "completed" : "upload",
                    html: `<strong>${escapeHTML(d.uploaded_by_name || "Someone")}</strong> uploaded <strong>${escapeHTML(d.filename)}</strong>${d.status === "failed" ? " — indexing failed" : ""}`,
                });
            });
            evalHistory.forEach(run => {
                events.push({
                    ts: run.timestamp * 1000,
                    type: "eval",
                    html: `Evaluation run completed — <strong>${(run.mean_retrieval_recall * 100).toFixed(0)}%</strong> recall, <strong>${run.mean_latency.toFixed(1)}s</strong> latency`,
                });
            });
            events.sort((a, b) => b.ts - a.ts);
            const feed = document.getElementById("admin-activity-feed");
            feed.innerHTML = events.length === 0
                ? `<p class="admin-empty-note">No activity recorded yet.</p>`
                : events.slice(0, 15).map(e => `
                    <div class="activity-item">
                        <div class="activity-icon ${activityIcon(e.type)}"><i class="fa-solid ${activityIcon(e.type).split(" ")[1]}"></i></div>
                        <div class="activity-text">${e.html}</div>
                        <span class="activity-time">${relTime(e.ts)}</span>
                    </div>`).join("");

        } catch (err) {
            console.error("Failed to load admin dashboard:", err);
        }
    }

    const adminRefreshBtn = document.getElementById("admin-refresh-btn");
    if (adminRefreshBtn) adminRefreshBtn.addEventListener("click", async () => {
        adminRefreshBtn.classList.add("btn-loading");
        adminRefreshBtn.disabled = true;
        try {
            await loadAdminDashboard();
        } finally {
            adminRefreshBtn.classList.remove("btn-loading");
            adminRefreshBtn.disabled = false;
        }
    });

    // ----------------------------------------------------------------
    // 4. KNOWLEDGE LIBRARY
    // ----------------------------------------------------------------
    const dropZone     = document.getElementById("drop-zone");
    const fileUploader = document.getElementById("file-uploader");
    const uploadStatus = document.getElementById("upload-status");
    const uploadIcon   = document.getElementById("upload-icon");
    const docsGrid     = document.getElementById("documents-grid-container");

    dropZone.addEventListener("click", () => fileUploader.click());

    fileUploader.addEventListener("change", () => {
        if (fileUploader.files.length > 0) uploadFiles(fileUploader.files);
    });

    // Counter-based drag tracking: dragenter/dragleave fire on every child
    // element too, so a naive toggle flickers as the pointer crosses child
    // boundaries. A depth counter only clears the active state once the
    // pointer has actually left the drop zone's whole subtree.
    let dragDepth = 0;
    dropZone.addEventListener("dragenter", e => {
        e.preventDefault();
        dragDepth++;
        dropZone.classList.add("drag-active");
    });
    dropZone.addEventListener("dragover", e => e.preventDefault());
    dropZone.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dropZone.classList.remove("drag-active");
    });
    dropZone.addEventListener("drop", e => {
        e.preventDefault();
        dragDepth = 0;
        dropZone.classList.remove("drag-active");
        if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
    });

    // --- Upload pipeline UI -------------------------------------------------

    const pipelinePanel  = document.getElementById("upload-pipeline-panel");
    const pipelineFiles  = document.getElementById("upload-pipeline-files");
    const stepperEl      = document.getElementById("upload-stepper");
    const progressTrack  = document.getElementById("upload-progress-track");
    const progressFill   = document.getElementById("upload-progress-fill");
    const progressLabel  = document.getElementById("upload-progress-label");

    const PIPELINE_STAGES = [
        { key: "uploading", label: "Uploading", icon: "fa-cloud-arrow-up" },
        { key: "chunking",  label: "Chunking",  icon: "fa-scissors" },
        { key: "embedding", label: "Embedding", icon: "fa-brain" },
        { key: "indexing",  label: "Indexing",  icon: "fa-database" },
        { key: "completed", label: "Completed", icon: "fa-circle-check" },
    ];
    // Backend statuses map onto stepper stages ("uploaded" = waiting for chunking)
    const STATUS_TO_STAGE = {
        uploaded: 1, chunking: 1, embedding: 2, indexing: 3, completed: 4,
    };

    function renderStepper(activeIndex, failed = false) {
        stepperEl.innerHTML = PIPELINE_STAGES.map((s, i) => {
            let cls = "step-pending";
            if (failed && i >= activeIndex) cls = "step-failed";
            else if (i < activeIndex)  cls = "step-done";
            else if (i === activeIndex) cls = (i === PIPELINE_STAGES.length - 1) ? "step-done" : "step-active";
            const icon = (cls === "step-done") ? "fa-check"
                       : (cls === "step-failed") ? "fa-xmark" : s.icon;
            const spin = cls === "step-active" ? " fa-fade" : "";
            const arrow = i < PIPELINE_STAGES.length - 1
                ? '<i class="fa-solid fa-arrow-right step-arrow"></i>' : "";
            return `
                <span class="pipeline-step ${cls}">
                    <i class="fa-solid ${icon}${spin}"></i> ${s.label}
                </span>${arrow}`;
        }).join("");
    }

    const FILE_TYPE_ICONS = {
        md: "fa-solid fa-file-lines icon-md",
        txt: "fa-solid fa-file-lines icon-txt",
        pdf: "fa-solid fa-file-pdf icon-pdf",
        docx: "fa-solid fa-file-word icon-docx",
    };
    function fileIconClass(ext) { return FILE_TYPE_ICONS[ext] || "fa-solid fa-file"; }

    function showPipeline(fileNames) {
        pipelineFiles.innerHTML = fileNames.map(n => {
            const ext = (n.split(".").pop() || "").toLowerCase();
            return `<span class="tag queued-file-chip" data-filename="${escapeHTML(n)}"><i class="${fileIconClass(ext)}"></i> ${escapeHTML(n)}</span>`;
        }).join(" ");
        pipelinePanel.style.display = "block";
        progressTrack.style.display = "block";
        progressFill.style.width = "0%";
        progressLabel.textContent = "";
        renderStepper(0);
    }

    // Appends a per-file done/failed mark to its queued-file chip as the
    // batch status poll resolves each document (nice at-a-glance state for
    // multi-file uploads, since files can finish at different times).
    function markQueuedFile(filename, status) {
        const chip = pipelineFiles.querySelector(`.queued-file-chip[data-filename="${CSS.escape(filename)}"]`);
        if (!chip || chip.querySelector(".stage-mark")) return;
        const mark = document.createElement("i");
        mark.className = status === "failed"
            ? "fa-solid fa-circle-xmark stage-mark mark-failed"
            : "fa-solid fa-circle-check stage-mark mark-done";
        chip.appendChild(mark);
    }

    function hidePipelineSoon(delayMs = 4000) {
        setTimeout(() => { pipelinePanel.style.display = "none"; }, delayMs);
    }

    function showUploadStatus(html, type) {
        uploadStatus.className = `upload-status ${type}`;
        uploadStatus.innerHTML = html;
        if (type === "success" || type === "error") {
            setTimeout(() => { uploadStatus.innerHTML = ""; }, 8000);
        }
    }

    // XMLHttpRequest is used (rather than fetch) because it exposes upload
    // progress events for the progress bar.
    function xhrUpload(formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/library/upload");
            const token = Auth.getAccessToken();
            if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress(e.loaded / e.total);
            };
            xhr.onload = () => {
                let body = {};
                try { body = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
                if (xhr.status >= 200 && xhr.status < 300) resolve(body);
                else {
                    const detail = typeof body.detail === "string"
                        ? body.detail
                        : (Array.isArray(body.detail) ? body.detail.map(d => d.msg).join(" ") : `HTTP ${xhr.status}`);
                    reject(new Error(detail));
                }
            };
            xhr.onerror   = () => reject(new Error("Network error during upload."));
            xhr.ontimeout = () => reject(new Error("Upload timed out."));
            xhr.send(formData);
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function pollBatchUntilDone(ids) {
        const idsParam = ids.join(",");
        for (;;) {
            await sleep(1000);
            const res = await Auth.fetch(`/api/library/status?ids=${idsParam}`);
            if (!res.ok) throw new Error("Failed to fetch processing status.");
            const data = await res.json();

            data.documents.forEach(d => {
                if (d.status === "completed" || d.status === "failed") markQueuedFile(d.filename, d.status);
            });

            const failed = data.documents.filter(d => d.status === "failed");
            if (failed.length) {
                renderStepper(STATUS_TO_STAGE[failed[0].status] ?? 1, true);
                throw new Error(
                    "Indexing failed: " + (failed[0].error_message || "unknown error")
                );
            }

            // Show the least-advanced stage across the batch
            const stageIdx = Math.min(
                ...data.documents.map(d => STATUS_TO_STAGE[d.status] ?? 1)
            );
            renderStepper(stageIdx);
            progressLabel.textContent =
                PIPELINE_STAGES[stageIdx].key === "completed"
                    ? "All files indexed."
                    : `${PIPELINE_STAGES[stageIdx].label}…`;

            if (data.all_done) return data.documents;
        }
    }

    async function uploadFiles(files) {
        const formData = new FormData();
        const names = [];
        for (let i = 0; i < files.length; i++) {
            const name = files[i].name.toLowerCase();
            if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".pdf") || name.endsWith(".docx")) {
                formData.append("files", files[i]);
                names.push(files[i].name);
            }
        }

        if (names.length === 0) {
            showUploadStatus("Only .md, .txt, .pdf, or .docx files are allowed.", "error");
            return;
        }

        if (uploadIcon) uploadIcon.classList.add("uploading");
        showPipeline(names);

        try {
            // Cheap authenticated call first so an expired access token is
            // refreshed before the XHR (which bypasses Auth.fetch) runs.
            await Auth.fetch("/api/auth/me");

            // Stage 1: Uploading (real byte progress)
            const accepted = await xhrUpload(formData, (frac) => {
                progressFill.style.width = `${Math.round(frac * 100)}%`;
                progressLabel.textContent = `Uploading… ${Math.round(frac * 100)}%`;
            });
            progressFill.style.width = "100%";

            if (accepted.skipped && accepted.skipped.length) {
                showUploadStatus(
                    `<i class="fa-solid fa-triangle-exclamation"></i> Skipped: ${escapeHTML(accepted.skipped.join("; "))}`,
                    "error"
                );
            }

            if (!accepted.document_ids || accepted.document_ids.length === 0) {
                pipelinePanel.style.display = "none";
                return;
            }

            // Stages 2-5: poll the backend as it chunks, embeds, and indexes
            progressTrack.style.display = "none";
            await pollBatchUntilDone(accepted.document_ids);

            renderStepper(PIPELINE_STAGES.length - 1);
            progressLabel.textContent = "All files indexed.";
            showUploadStatus(
                `<i class="fa-solid fa-circle-check"></i> ${accepted.document_ids.length} file(s) indexed successfully.`,
                "success"
            );
            hidePipelineSoon();

            // Auto-refresh the UI after indexing
            loadDocuments();
            updateProviderStatus();
        } catch (err) {
            showUploadStatus(`<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHTML(err.message)}`, "error");
            hidePipelineSoon(6000);
            loadDocuments(); // refresh — some files may still have succeeded
        } finally {
            if (uploadIcon) uploadIcon.classList.remove("uploading");
            fileUploader.value = "";
        }
    }

    // --- Library listing: search, filters, sort, view toggle, cards ---------

    const librarySearch    = document.getElementById("library-search");
    const docCounter       = document.getElementById("doc-counter");
    const chunkCounter     = document.getElementById("chunk-counter");
    const filteredCountEl  = document.getElementById("library-filtered-count");
    const filterTypeSel    = document.getElementById("library-filter-type");
    const filterStatusSel  = document.getElementById("library-filter-status");
    const sortSel          = document.getElementById("library-sort");
    const viewGridBtn      = document.getElementById("library-view-grid");
    const viewListBtn      = document.getElementById("library-view-list");

    let searchDebounce = null;
    librarySearch.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => loadDocuments(librarySearch.value.trim()), 300);
    });

    // Last-fetched documents are cached so filter/sort/view changes re-render
    // instantly without a round trip — only the search box triggers a refetch.
    let libraryDocsCache = [];
    let libraryView = localStorage.getItem("omni_library_view") === "list" ? "list" : "grid";

    function setLibraryView(view) {
        libraryView = view;
        localStorage.setItem("omni_library_view", view);
        docsGrid.classList.toggle("list-view", view === "list");
        viewGridBtn.classList.toggle("active", view === "grid");
        viewListBtn.classList.toggle("active", view === "list");
        viewGridBtn.setAttribute("aria-pressed", String(view === "grid"));
        viewListBtn.setAttribute("aria-pressed", String(view === "list"));
    }
    viewGridBtn.addEventListener("click", () => setLibraryView("grid"));
    viewListBtn.addEventListener("click", () => setLibraryView("list"));
    setLibraryView(libraryView);

    [filterTypeSel, filterStatusSel, sortSel].forEach(el =>
        el.addEventListener("change", () => renderLibraryList()));

    const EXT_BADGES = { md: "badge-md", txt: "badge-txt", pdf: "badge-pdf", docx: "badge-docx" };
    const STATUS_BADGES = {
        completed: ["status-completed", "fa-circle-check", "Indexed"],
        failed:    ["status-failed",    "fa-circle-xmark", "Failed"],
        uploaded:  ["status-processing","fa-hourglass-half", "Queued"],
        chunking:  ["status-processing","fa-scissors", "Chunking"],
        embedding: ["status-processing","fa-brain", "Embedding"],
        indexing:  ["status-processing","fa-database", "Indexing"],
    };
    const PROCESSING_STATUSES = new Set(["uploaded", "chunking", "embedding", "indexing"]);

    function applyFilterAndSort(docs) {
        const typeF   = filterTypeSel.value;
        const statusF = filterStatusSel.value;
        let out = docs.filter(d => {
            if (typeF !== "all" && d.file_type !== typeF) return false;
            if (statusF === "all") return true;
            if (statusF === "processing") return PROCESSING_STATUSES.has(d.status);
            return d.status === statusF;
        });
        const [key, dir] = sortSel.value.split("-");
        const mul = dir === "asc" ? 1 : -1;
        out.sort((a, b) => {
            switch (key) {
                case "name":   return mul * a.filename.localeCompare(b.filename);
                case "size":   return mul * (a.size_bytes - b.size_bytes);
                case "chunks": return mul * (a.chunk_count - b.chunk_count);
                default:       return mul * (new Date(a.uploaded_at) - new Date(b.uploaded_at));
            }
        });
        return out;
    }

    function renderLibraryList() {
        const docs = applyFilterAndSort(libraryDocsCache);
        const totalCached = libraryDocsCache.length;

        filteredCountEl.style.display = docs.length !== totalCached ? "" : "none";
        filteredCountEl.textContent = `${docs.length} shown`;

        docsGrid.innerHTML = "";
        if (docs.length === 0) {
            const hasFilters = filterTypeSel.value !== "all" || filterStatusSel.value !== "all";
            const searching = librarySearch.value.trim();
            docsGrid.innerHTML = searching
                ? `<div class="debug-empty-state"><i class="fa-solid fa-magnifying-glass"></i><h3>No Matches</h3><p>No documents match "${escapeHTML(searching)}".</p></div>`
                : hasFilters
                ? `<div class="debug-empty-state"><i class="fa-solid fa-filter-circle-xmark"></i><h3>No Documents Match These Filters</h3><p>Try a different type or status filter.</p></div>`
                : `<div class="debug-empty-state"><i class="fa-solid fa-folder-open"></i><h3>Library Empty</h3><p>Upload files above to populate the search database.</p></div>`;
            return;
        }

        const maxChunks = Math.max(...docs.map(d => d.chunk_count), 1);

        docs.forEach((doc, i) => {
            const card = document.createElement("div");
            card.className = "doc-file-card";
            card.style.setProperty("--card-i", i);

            const sizeKb   = (doc.size_bytes / 1024).toFixed(1);
            const extClass = EXT_BADGES[doc.file_type] || "badge-txt";
            const chunkPct = Math.max(5, Math.round((doc.chunk_count / maxChunks) * 100));
            const [stCls, stIcon, stLabel] = STATUS_BADGES[doc.status] || STATUS_BADGES.uploaded;
            const uploadedTs = new Date(doc.uploaded_at).getTime() / 1000;

            const previewBtnHtml = doc.status === "completed"
                ? `<button class="action-btn-secondary preview-doc-btn" data-docid="${doc.id}" title="Preview document"><i class="fa-solid fa-eye"></i></button>`
                : "";
            // Delete is admin-only (backend enforces with 403 as well)
            const deleteBtnHtml = Auth.isAdmin()
                ? `<button class="action-btn-secondary delete-doc-btn" data-docid="${doc.id}" data-filename="${escapeHTML(doc.filename)}" title="Delete document" style="padding: 4px 8px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);"><i class="fa-solid fa-trash"></i></button>`
                : "";

            card.innerHTML = `
                <div class="icon-row" style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <i class="${fileIconClass(doc.file_type)} file-icon"></i>
                        <div class="doc-badges">
                            <span class="tag file-ext-badge ${extClass}">.${doc.file_type}</span>
                            <span class="tag">${doc.chunk_count} chunks</span>
                            <span class="tag doc-status-badge ${stCls}" title="${escapeHTML(doc.error_message || "")}"><i class="fa-solid ${stIcon}"></i> ${stLabel}</span>
                        </div>
                    </div>
                    <div class="doc-card-actions">${previewBtnHtml}${deleteBtnHtml}</div>
                </div>
                <h4 title="${escapeHTML(doc.filename)}">${escapeHTML(doc.filename)}</h4>
                <div class="chunk-progress-track">
                    <div class="chunk-progress-fill" style="width:${chunkPct}%"></div>
                </div>
                <div class="meta-row">
                    <span title="File size"><i class="fa-solid fa-weight-hanging"></i> ${sizeKb} KB</span>
                    <span title="Upload date"><i class="fa-solid fa-calendar"></i> ${formatDate(uploadedTs)}</span>
                </div>
                <div class="meta-row">
                    <span title="Uploaded by"><i class="fa-solid fa-user-pen"></i> ${escapeHTML(doc.uploaded_by_name || "—")}</span>
                </div>`;

            docsGrid.appendChild(card);
        });

        document.querySelectorAll(".preview-doc-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                const doc = libraryDocsCache.find(d => String(d.id) === e.currentTarget.getAttribute("data-docid"));
                if (doc) openDocPreview(doc, e.currentTarget);
            });
        });

        document.querySelectorAll(".delete-doc-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                const docId    = e.currentTarget.getAttribute("data-docid");
                const filename = e.currentTarget.getAttribute("data-filename");
                if (!confirm(`Are you sure you want to delete ${filename}? This will trigger a reindex.`)) return;

                const originalBtnHtml = e.currentTarget.innerHTML;
                e.currentTarget.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                e.currentTarget.disabled = true;

                try {
                    const res = await Auth.fetch(`/api/library/${docId}`, { method: "DELETE" });
                    if (!res.ok) {
                        const err = await res.json().catch(()=>({detail:"Unknown error"}));
                        alert(`Failed to delete: ${err.detail}`);
                    } else {
                        loadDocuments();
                        updateProviderStatus();
                    }
                } catch (err) {
                    alert(`Network error: ${err.message}`);
                } finally {
                    if (e.currentTarget) {
                        e.currentTarget.innerHTML = originalBtnHtml;
                        e.currentTarget.disabled = false;
                    }
                }
            });
        });
    }

    async function loadDocuments(search = librarySearch ? librarySearch.value.trim() : "") {
        try {
            const url = search
                ? `/api/library?search=${encodeURIComponent(search)}`
                : "/api/library";
            const res = await Auth.fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // Library-wide counters (independent of search filter)
            docCounter.textContent   = data.total_documents;
            chunkCounter.textContent = data.total_chunks;

            // filename → id map used by the citation "Open Source" buttons
            (data.documents || []).forEach(d => { libraryIdByFilename[d.filename] = d.id; });

            libraryDocsCache = data.documents || [];
            renderLibraryList();
        } catch (err) {
            console.error("Failed to load documents list:", err);
        }
    }

    // ------------------------------------------------------------------
    // Document preview: TXT/MD (plain text), PDF (native browser viewer),
    // DOCX (mammoth.js -> HTML). Zoom, fullscreen, and best-effort
    // highlighting of chunks retrieved earlier in this chat session.
    // ------------------------------------------------------------------
    const previewModal      = document.getElementById("doc-preview-modal");
    const previewModalBody  = document.getElementById("preview-modal-content");
    const previewTitle      = document.getElementById("preview-doc-title");
    const previewFileIcon   = document.getElementById("preview-file-icon");
    const previewLoading    = document.getElementById("preview-loading");
    const previewWrap       = document.getElementById("preview-content-wrap");
    const previewErrorState = document.getElementById("preview-error-state");
    const previewErrorText  = document.getElementById("preview-error-text");
    const previewMetaGrid   = document.getElementById("preview-meta-grid");
    const previewChunksBlk  = document.getElementById("preview-chunks-block");
    const previewChunksList = document.getElementById("preview-chunk-list");
    const previewDownloadBtn= document.getElementById("preview-download-btn");
    const previewZoomLabel  = document.getElementById("preview-zoom-label");
    const previewZoomIn     = document.getElementById("preview-zoom-in");
    const previewZoomOut    = document.getElementById("preview-zoom-out");
    const previewFullscreen = document.getElementById("preview-fullscreen-btn");
    const closePreviewBtn   = document.getElementById("close-preview-modal-btn");

    let previewZoom = 100;
    let previewBlobUrl = null;

    function setPreviewZoom(pct) {
        previewZoom = Math.min(200, Math.max(50, pct));
        previewZoomLabel.textContent = `${previewZoom}%`;
        const content = previewWrap.firstElementChild;
        if (content) content.style.zoom = previewZoom / 100;
    }
    previewZoomIn.addEventListener("click", () => setPreviewZoom(previewZoom + 10));
    previewZoomOut.addEventListener("click", () => setPreviewZoom(previewZoom - 10));

    previewFullscreen.addEventListener("click", () => {
        if (!document.fullscreenElement) {
            previewModalBody.requestFullscreen?.().catch(() => {});
        } else {
            document.exitFullscreen?.().catch(() => {});
        }
    });
    document.addEventListener("fullscreenchange", () => {
        const active = document.fullscreenElement === previewModalBody;
        previewFullscreen.innerHTML = active
            ? '<i class="fa-solid fa-compress"></i>'
            : '<i class="fa-solid fa-expand"></i>';
    });

    function escapeRegExpChars(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    // Highlights exact retrieved-chunk text inside already-escaped HTML.
    // Whitespace in the chunk is treated as flexible (\s+) since DOCX/PDF
    // extraction can normalise line breaks differently than the source.
    function highlightChunksInHtml(escapedHtml, chunkTexts) {
        let out = escapedHtml;
        chunkTexts.forEach(raw => {
            const words = escapeHTML(raw.trim()).split(/\s+/).filter(Boolean);
            if (words.length < 3) return; // too short to safely match
            // Build a flexible pattern from a bounded window of the chunk so
            // very long chunks don't produce a catastrophic regex.
            const sample = words.slice(0, 24).map(escapeRegExpChars).join("\\s+");
            try {
                out = out.replace(new RegExp(sample, "i"), m => `<mark>${m}</mark>`);
            } catch (e) { /* malformed pattern — skip this chunk */ }
        });
        return out;
    }

    function retrievedChunksFor(filename) {
        // currentSessionDocs is keyed by "source#section" and bare "source";
        // collect unique chunk contents for this filename only.
        const seen = new Set();
        const out = [];
        Object.values(currentSessionDocs).forEach(rec => {
            if (rec.source === filename && rec.content && !seen.has(rec.chunk_id)) {
                seen.add(rec.chunk_id);
                out.push(rec);
            }
        });
        return out;
    }

    function renderPreviewMeta(doc) {
        const sizeKb = (doc.size_bytes / 1024).toFixed(1);
        const uploadedTs = new Date(doc.uploaded_at).getTime() / 1000;
        previewMetaGrid.innerHTML = `
            <span>Type</span><strong>.${escapeHTML(doc.file_type)}</strong>
            <span>Size</span><strong>${sizeKb} KB</strong>
            <span>Chunks</span><strong>${doc.chunk_count}</strong>
            <span>Status</span><strong>${escapeHTML(doc.status)}</strong>
            <span>Uploaded by</span><strong>${escapeHTML(doc.uploaded_by_name || "—")}</strong>
            <span>Uploaded</span><strong>${escapeHTML(formatDate(uploadedTs))}</strong>`;
    }

    function renderPreviewChunkList(chunks) {
        if (!chunks.length) { previewChunksBlk.style.display = "none"; return; }
        previewChunksBlk.style.display = "";
        previewChunksList.innerHTML = chunks.map(c => `
            <div class="preview-chunk-item" title="Section: ${escapeHTML(c.section || "General")}">
                ${escapeHTML((c.content || "").slice(0, 160))}${(c.content || "").length > 160 ? "…" : ""}
            </div>`).join("");
    }

    async function openDocPreview(doc, originEl) {
        // Open-from-card animation: scale in from the button's screen position.
        if (originEl) {
            const r = originEl.getBoundingClientRect();
            previewModalBody.style.setProperty("--open-origin-x", `${r.left + r.width / 2}px`);
            previewModalBody.style.setProperty("--open-origin-y", `${r.top + r.height / 2}px`);
        }
        previewModalBody.classList.remove("opening");
        void previewModalBody.offsetWidth;
        previewModalBody.classList.add("opening");

        previewTitle.textContent = doc.filename;
        previewFileIcon.className = `preview-title-icon ${fileIconClass(doc.file_type)}`;
        previewLoading.style.display = "";
        previewWrap.style.display = "none";
        previewErrorState.style.display = "none";
        previewWrap.innerHTML = "";
        setPreviewZoom(100);
        renderPreviewMeta(doc);
        const chunks = retrievedChunksFor(doc.filename);
        renderPreviewChunkList(chunks);
        previewDownloadBtn.onclick = () => openSourceDocument(doc.filename);

        previewModal.classList.add("active");

        if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); previewBlobUrl = null; }

        try {
            const res = await Auth.fetch(`/api/library/${doc.id}/file`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();

            if (doc.file_type === "txt" || doc.file_type === "md") {
                const text = await blob.text();
                const escaped = escapeHTML(text);
                const highlighted = highlightChunksInHtml(escaped, chunks.map(c => c.content));
                const pre = document.createElement("pre");
                pre.className = "preview-text";
                pre.innerHTML = highlighted;
                previewWrap.appendChild(pre);

            } else if (doc.file_type === "pdf") {
                previewBlobUrl = URL.createObjectURL(blob);
                const iframe = document.createElement("iframe");
                iframe.className = "preview-pdf-frame";
                iframe.title = doc.filename;
                iframe.src = previewBlobUrl;
                previewWrap.appendChild(iframe);

            } else if (doc.file_type === "docx") {
                try {
                    await ensureMammoth();
                } catch (loadErr) {
                    throw new Error("DOCX preview library failed to load. Check your connection and retry.");
                }
                const arrayBuffer = await blob.arrayBuffer();
                // mammoth's conversion has been observed to hang indefinitely
                // in some browser/automation environments — never let a
                // third-party parser freeze the modal. On timeout we fall
                // back to a clear message instead of a stuck spinner.
                const timeout = (ms) => new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("DOCX_TIMEOUT")), ms));
                let result;
                try {
                    result = await Promise.race([
                        window.mammoth.convertToHtml({ arrayBuffer }),
                        timeout(8000),
                    ]);
                } catch (raceErr) {
                    if (raceErr.message === "DOCX_TIMEOUT") {
                        throw new Error("DOCX preview timed out. Use “Download Original” to view this file.");
                    }
                    throw raceErr;
                }
                // mammoth output is structural HTML (p/h/table/etc.) with no
                // scripts; still strip any script/style/event-handler surface
                // defensively before insertion.
                const sanitized = result.value
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/\son\w+="[^"]*"/gi, "")
                    .replace(/\son\w+='[^']*'/gi, "");
                const div = document.createElement("div");
                div.className = "preview-docx-content";
                div.innerHTML = sanitized;
                if (chunks.length) {
                    div.innerHTML = highlightChunksInHtml(div.innerHTML, chunks.map(c => c.content));
                }
                previewWrap.appendChild(div);
            } else {
                throw new Error("Preview not supported for this file type.");
            }

            previewLoading.style.display = "none";
            previewWrap.style.display = "";

            const firstMark = previewWrap.querySelector("mark");
            if (firstMark) firstMark.scrollIntoView({ block: "center" });

        } catch (err) {
            previewLoading.style.display = "none";
            previewErrorState.style.display = "flex";
            previewErrorText.textContent = err.message || "Could not load this document.";
        }
    }

    function closeDocPreview() {
        if (document.fullscreenElement === previewModalBody) document.exitFullscreen?.().catch(() => {});
        previewModal.classList.remove("active");
        if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); previewBlobUrl = null; }
    }
    closePreviewBtn.addEventListener("click", closeDocPreview);
    previewModal.addEventListener("click", e => { if (e.target === previewModal) closeDocPreview(); });

    // ----------------------------------------------------------------
    // Initial page load — runs only after successful authentication.
    // Auth.init() restores a stored session or shows the login overlay;
    // startApp() is invoked with the authenticated user.
    // ----------------------------------------------------------------
    const initialChatHTML = chatHistory.innerHTML; // welcome message snapshot
    const runEvalButton   = document.getElementById("run-eval-btn");
    const uploadSection   = document.querySelector(".upload-section");

    function applyRoleVisibility() {
        // Admin-only controls: document upload, evaluation trigger, and the
        // Admin Dashboard tab. The backend enforces this with 403s on the
        // underlying endpoints regardless of what the UI shows.
        const isAdmin = Auth.isAdmin();
        if (uploadSection) uploadSection.style.display = isAdmin ? "" : "none";
        if (runEvalButton) runEvalButton.style.display = isAdmin ? "" : "none";
        const adminNavBtn = document.getElementById("admin-nav-btn");
        if (adminNavBtn) {
            adminNavBtn.style.display = isAdmin ? "" : "none";
            // A non-admin whose role changed (or a stale session) should
            // never stay parked on the admin tab — fall back to chat.
            if (!isAdmin && adminNavBtn.classList.contains("active")) {
                adminNavBtn.classList.remove("active");
                document.getElementById("admin-tab").classList.remove("active");
                document.querySelector('.nav-btn[data-tab="chat-tab"]').classList.add("active");
                document.getElementById("chat-tab").classList.add("active");
            }
        }
    }

    function startApp(user) {
        console.info(`[Auth] Signed in as ${user.email} (${user.role})`);
        applyRoleVisibility();
        // Reset chat pane in case a previous user's messages are on screen
        chatHistory.innerHTML = initialChatHTML;
        conversationHistory = "";
        currentSessionDocs = {};
        updateProviderStatus();
        showHistorySkeleton();
        loadChatHistory().finally(hideHistorySkeleton);
        // Evaluation history and Admin Dashboard data load on-demand when
        // their tab is first opened (see switchTab) — same as the Knowledge
        // Library — so Chart.js is never fetched for sessions that stay on
        // the chat/debugger tabs.
    }

    // ----------------------------------------------------------------
    // Phase A polish: ripple, skeletons, keyboard, a11y (UI-only)
    // ----------------------------------------------------------------

    // Lightweight ripple on primary buttons (respects reduced-motion)
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) {
        document.addEventListener("pointerdown", e => {
            // .nav-btn excluded: its active-indicator bar sits outside the
            // button bounds and overflow:hidden (ripple-host) would clip it.
            const host = e.target.closest(
                ".action-btn, .action-btn-secondary, .submit-btn, .sso-btn, .prompt-chip");
            if (!host) return;
            host.classList.add("ripple-host");
            const rect = host.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const ripple = document.createElement("span");
            ripple.className = "ripple";
            ripple.style.width = ripple.style.height = `${size}px`;
            ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
            ripple.style.top  = `${e.clientY - rect.top  - size / 2}px`;
            host.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);
        });
    }

    // Skeleton bubbles while chat history loads
    function showHistorySkeleton() {
        const wrap = document.createElement("div");
        wrap.id = "history-skeleton";
        wrap.innerHTML = [64, 42, 55].map(w => `
            <div class="skeleton-msg" aria-hidden="true">
                <div class="skeleton skeleton-avatar"></div>
                <div class="skeleton-lines">
                    <div class="skeleton" style="width:${w}%"></div>
                    <div class="skeleton" style="width:${Math.round(w * 0.7)}%"></div>
                </div>
            </div>`).join("");
        chatHistory.appendChild(wrap);
    }
    function hideHistorySkeleton() {
        const el = document.getElementById("history-skeleton");
        if (el) el.remove();
    }

    // Escape closes modals and the profile dropdown
    document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        if (document.getElementById("doc-preview-modal").classList.contains("active")) {
            closeDocPreview();
        } else {
            document.querySelectorAll(".modal.active").forEach(m => m.classList.remove("active"));
        }
        const dropdown = document.getElementById("user-menu-dropdown");
        if (dropdown && dropdown.style.display !== "none") {
            dropdown.style.display = "none";
            const trigger = document.getElementById("user-menu-trigger");
            if (trigger) trigger.setAttribute("aria-expanded", "false");
        }
    });

    // ARIA labels for icon-only controls created in markup
    const ariaLabels = {
        "submit-btn": "Send question",
        "close-modal-btn": "Close document viewer",
        "close-profile-modal-btn": "Close profile",
        "clear-chat-btn": "Clear chat history",
    };
    Object.entries(ariaLabels).forEach(([id, label]) => {
        const el = document.getElementById(id);
        if (el && !el.getAttribute("aria-label")) el.setAttribute("aria-label", label);
    });
    chatHistory.setAttribute("role", "log");
    chatHistory.setAttribute("aria-live", "polite");
    chatHistory.setAttribute("aria-label", "Chat conversation");

    // Debug/test hook (read-only helpers; harmless in production)
    window.__omniDebug = { formatMarkdown, conversationToMarkdown, relTime };

    Auth.init(startApp);
});
