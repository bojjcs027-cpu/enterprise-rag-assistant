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


    navButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetTab = btn.getAttribute("data-tab");

            navButtons.forEach(b => b.classList.remove("active"));
            tabPanes.forEach(pane => pane.classList.remove("active"));

            btn.classList.add("active");
            document.getElementById(targetTab).classList.add("active");

            if (targetTab === "eval-tab")  loadEvaluationHistory();
            if (targetTab === "docs-tab")  loadDocuments();
        });
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

    function escapeHTML(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#039;");
    }

    // Lightweight markdown: bold, italic, inline code, citation links
    function formatMarkdown(rawText) {
        let s = escapeHTML(rawText);
        // Bold: **text**
        s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        // Italic: *text* (single asterisk, not double)
        s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
        // Inline code: `code`
        s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
        // Citation links: [file.md#Section] or [file.md#Section, page N]
        const citationPattern = /\[([a-zA-Z0-9_\-\.]+(?:#[^\],\n]+)?(?:,\s*page\s*\d+)?)\]/g;
        s = s.replace(citationPattern, (match, citeKey) => {
            const lookupKey = citeKey.split(",")[0].trim();
            return `<a class="citation-link" data-cite="${escapeHTML(lookupKey)}">[cite: ${escapeHTML(citeKey)}]</a>`;
        });
        return s;
    }

    // ----------------------------------------------------------------
    // Provider Status + System Stats Sidebar
    // ----------------------------------------------------------------
    const providerPill      = document.getElementById("active-provider-pill");
    const providerName      = document.getElementById("active-provider-name");
    const systemStatsPanel  = document.getElementById("system-stats-panel");

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

    // Character counter
    queryInput.addEventListener("input", () => {
        const len = queryInput.value.length;
        charCounter.textContent = `${len} / 500`;
        charCounter.classList.toggle("counter-warn", len > 400);
    });

    // Ctrl+Enter shortcut
    queryInput.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";

        const formattedAnswer = formatMarkdown(text);
        bubble.innerHTML = `
            <div class="msg-answer-text"><p>${formattedAnswer}</p></div>
            <span class="msg-timestamp">${timestamp ? formatDate(timestamp) : formatTime()}</span>
        `;
        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        
        // Bind inline citation link clicks
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
        charCounter.textContent = "0 / 500";
        charCounter.classList.remove("counter-warn");

        const loaderId = appendLoader();
        chatHistory.scrollTop = chatHistory.scrollHeight;

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
                removeLoader(loaderId);
                const err = await res.json().catch(() => ({ detail: "Unknown error" }));
                appendMessage("system", `Error: ${err.detail || "Request failed."}`);
                return;
            }

            removeLoader(loaderId);
            conversationHistory += `User: ${query}\n`;

            if (res.headers.get("content-type") && res.headers.get("content-type").includes("text/event-stream")) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let done = false;
                
                const msgDiv = document.createElement("div");
                msgDiv.className = "message system-msg";
                const avatar = document.createElement("div");
                avatar.className = "msg-avatar";
                avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';
                const bubble = document.createElement("div");
                bubble.className = "msg-bubble";
                const answerText = document.createElement("div");
                answerText.className = "msg-answer-text";
                answerText.innerHTML = "<p><i>Thinking...</i></p>";
                
                bubble.appendChild(answerText);
                msgDiv.appendChild(avatar);
                msgDiv.appendChild(bubble);
                chatHistory.appendChild(msgDiv);
                
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
                                            answerText.innerHTML = "<p></p>";
                                        } else if (data.type === "chunk") {
                                            rawAnswer += data.content;
                                            answerText.innerHTML = `<p>${formatMarkdown(rawAnswer)}</p>`;
                                            chatHistory.scrollTop = chatHistory.scrollHeight;
                                        } else if (data.type === "done") {
                                            clearTimeout(timeoutId);
                                            conversationHistory += `Assistant: ${data.data.answer}\n\n`;
                                            appendAgentResponseFooter(bubble, data.data, metadata);
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
                    if (streamErr.name === "AbortError") {
                        if (!gotAnyData) {
                            msgDiv.remove();
                            appendMessage("system", "Error: Request timed out (90s). The backend may still be processing.");
                        } else {
                            answerText.innerHTML = `<p>${formatMarkdown(rawAnswer || "Response timed out mid-stream.")}</p>`;
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
                if (!gotAnyData) {
                    msgDiv.remove();
                    appendMessage("system", "Error: No response received from the server.");
                }

            } else {
                // Non-streaming JSON response
                const data = await res.json();
                clearTimeout(timeoutId);

                storeSessionDocs(data.reranked_documents, query);

                conversationHistory += `Assistant: ${data.answer}\n\n`;
                appendAgentResponse(data);
                updateProviderStatus();
            }

        } catch (err) {
            clearTimeout(timeoutId);
            removeLoader(loaderId);
            if (err.name === "AbortError") {
                appendMessage("system", "Error: The request timed out after 90 seconds.");
            } else {
                appendMessage("system", `Network Error: ${err.message}`);
            }
        }

        chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    // --- Chat rendering helpers ---

    function appendMessage(sender, text, timestamp = null) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${sender === "user" ? "user-msg" : "system-msg"}`;

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.innerHTML = sender === "user"
            ? '<i class="fa-solid fa-user"></i>'
            : '<i class="fa-solid fa-robot"></i>';

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = `<p>${escapeHTML(text)}</p><span class="msg-timestamp">${timestamp ? formatDate(timestamp) : formatTime()}</span>`;

        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
    }

    function appendLoader() {
        const id = "loader_" + Date.now();
        const msgDiv = document.createElement("div");
        msgDiv.className = "message system-msg";
        msgDiv.id = id;

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = `
            <div class="chat-loader">
                <span></span><span></span><span></span>
            </div>`;

        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        return id;
    }

    function removeLoader(id) {
        const el = document.getElementById(id);
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

    function appendAgentResponseFooter(bubble, doneData, metadata) {
        const timeSpan = document.createElement("span");
        timeSpan.className = "msg-timestamp";
        timeSpan.innerText = formatTime();
        bubble.appendChild(timeSpan);
        
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

        // Copy-to-clipboard button
        const copyBtn = document.createElement("button");
        copyBtn.className = "msg-copy-btn";
        copyBtn.title = "Copy answer";
        copyBtn.setAttribute("aria-label", "Copy answer to clipboard");
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(doneData.answer).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
                    copyBtn.classList.remove("copied");
                }, 2000);
            });
        });
        bubble.appendChild(copyBtn);
        
        // Bind inline citation link clicks
        bubble.querySelectorAll(".citation-link").forEach(link => {
            link.addEventListener("click", () => openCitationModal(link.getAttribute("data-cite")));
        });
        
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function appendAgentResponse(data) {
        const msgDiv = document.createElement("div");
        msgDiv.className = "message system-msg";

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";

        // Render markdown-formatted answer
        const formattedAnswer = formatMarkdown(data.answer);
        const cacheHtml = data.cached ? '<span class="cache-badge"><i class="fa-solid fa-bolt"></i> Served from Cache</span>' : '';
        bubble.innerHTML = `
            <div class="msg-answer-text"><p>${formattedAnswer}</p></div>
            <span class="msg-timestamp">${formatTime()}</span>
            ${cacheHtml}
        `;

        // Pipeline visualization + performance/debug panels (real metrics)
        bubble.appendChild(buildPipelinePanel(
            data.provider,
            data.metrics,
            data.debug,
            (data.retrieved_documents || []).length,
            (data.reranked_documents  || []).length,
        ));

        // Citations footer panel
        const citPanel = buildCitationsPanel(data.citations);
        if (citPanel) bubble.appendChild(citPanel);

        // Copy-to-clipboard button (appears on bubble hover)
        const copyBtn = document.createElement("button");
        copyBtn.className = "msg-copy-btn";
        copyBtn.title = "Copy answer";
        copyBtn.setAttribute("aria-label", "Copy answer to clipboard");
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(data.answer).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
                    copyBtn.classList.remove("copied");
                }, 2000);
            });
        });
        bubble.appendChild(copyBtn);

        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);

        // Bind inline citation link clicks
        bubble.querySelectorAll(".citation-link").forEach(link => {
            link.addEventListener("click", () => openCitationModal(link.getAttribute("data-cite")));
        });
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

                    if (col.key === "bm25") {
                        addTag(`BM25: ${fmtScore(item.bm25_score, 2)}`, "tag rrf-score-tag");
                    } else if (col.key === "vector") {
                        addTag(`Sim: ${fmtScore(item.vector_similarity, 3)}`, "tag rrf-score-tag");
                        addTag(`L2: ${fmtScore(item.vector_distance, 2)}`);
                    } else if (col.key === "rrf") {
                        addTag(`RRF: ${fmtScore(item.score, 4)}`, "tag rrf-score-tag");
                        addTag(`V:${item.vector_rank ?? "—"} B:${item.bm25_rank ?? "—"}`);
                        addTag(`BM25: ${fmtScore(item.bm25_score, 1)} · Sim: ${fmtScore(item.vector_similarity, 2)}`);
                    } else if (col.key === "reranked") {
                        addTag(`CE: ${fmtScore(item.rerank_score, 3)}`, "tag rerank-score-tag");
                        addTag(`Conf: ${item.confidence !== undefined ? (item.confidence * 100).toFixed(1) + "%" : "—"}`);
                        addTag(`RRF: ${fmtScore(item.score, 4)}`);
                        addTag(`Final #${item.final_rank ?? index + 1}`);
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
                <h3 class="card-value">${(run.mean_retrieval_recall * 100).toFixed(0)}%</h3>
                <p class="card-desc">Ground-truth docs fetched ${deltaHtml(run.mean_retrieval_recall, prev?.mean_retrieval_recall)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(139,92,246,0.12);">
                    <i class="fa-solid fa-quote-left" style="color:#8B5CF6;"></i>
                </div>
                <span class="card-label">Citation Precision</span>
                <h3 class="card-value">${(run.mean_citation_precision * 100).toFixed(0)}%</h3>
                <p class="card-desc">Valid citations generated ${deltaHtml(run.mean_citation_precision, prev?.mean_citation_precision)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(59,130,246,0.12);">
                    <i class="fa-solid fa-brain" style="color:#3B82F6;"></i>
                </div>
                <span class="card-label">Faithfulness</span>
                <h3 class="card-value">${(run.mean_faithfulness ?? 0).toFixed(2)}</h3>
                <p class="card-desc">Answer alignment to context ${deltaHtml(run.mean_faithfulness, prev?.mean_faithfulness)}</p>
            </div>
            <div class="metric-card">
                <div class="card-icon-wrap" style="background:rgba(239,68,68,0.12);">
                    <i class="fa-solid fa-ghost" style="color:#EF4444;"></i>
                </div>
                <span class="card-label">Hallucination</span>
                <h3 class="card-value">${(run.mean_hallucination ?? 0).toFixed(2)}</h3>
                <p class="card-desc">Inverse of faithfulness score ${deltaHtml(run.mean_hallucination, prev?.mean_hallucination, false)}</p>
            </div>
            <div class="metric-card pass">
                <div class="card-icon-wrap" style="background:rgba(245,158,11,0.12);">
                    <i class="fa-solid fa-trophy" style="color:#F59E0B;"></i>
                </div>
                <span class="card-label">Answer Relevance</span>
                <h3 class="card-value">${(run.mean_answer_relevance ?? 0).toFixed(2)}</h3>
                <p class="card-desc">Semantic similarity to query ${deltaHtml(run.mean_answer_relevance, prev?.mean_answer_relevance)}</p>
            </div>
            <div class="metric-card">
                <div class="card-icon-wrap" style="background:rgba(239,68,68,0.12);">
                    <i class="fa-solid fa-stopwatch" style="color:#EF4444;"></i>
                </div>
                <span class="card-label">Mean Latency</span>
                <h3 class="card-value">${run.mean_latency.toFixed(2)}s</h3>
                <p class="card-desc">Average generation time ${deltaHtml(run.mean_latency, prev?.mean_latency, false)}</p>
            </div>
        `;
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

    dropZone.addEventListener("dragover", e => {
        e.preventDefault();
        dropZone.style.borderColor = "var(--accent-indigo)";
        dropZone.style.background  = "rgba(99, 102, 241, 0.05)";
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.style.borderColor = "var(--border-color)";
        dropZone.style.background  = "var(--bg-glass)";
    });

    dropZone.addEventListener("drop", e => {
        e.preventDefault();
        dropZone.style.borderColor = "var(--border-color)";
        dropZone.style.background  = "var(--bg-glass)";
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

    function showPipeline(fileNames) {
        pipelineFiles.innerHTML = fileNames
            .map(n => `<span class="tag">${escapeHTML(n)}</span>`).join(" ");
        pipelinePanel.style.display = "block";
        progressTrack.style.display = "block";
        progressFill.style.width = "0%";
        progressLabel.textContent = "";
        renderStepper(0);
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

    // --- Library listing: search, counters, metadata cards ------------------

    const librarySearch = document.getElementById("library-search");
    const docCounter    = document.getElementById("doc-counter");
    const chunkCounter  = document.getElementById("chunk-counter");

    let searchDebounce = null;
    librarySearch.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => loadDocuments(librarySearch.value.trim()), 300);
    });

    const EXT_BADGES = { md: "badge-md", txt: "badge-txt", pdf: "badge-pdf", docx: "badge-docx" };
    const STATUS_BADGES = {
        completed: ["status-completed", "fa-circle-check", "Indexed"],
        failed:    ["status-failed",    "fa-circle-xmark", "Failed"],
        uploaded:  ["status-processing","fa-hourglass-half", "Queued"],
        chunking:  ["status-processing","fa-scissors", "Chunking"],
        embedding: ["status-processing","fa-brain", "Embedding"],
        indexing:  ["status-processing","fa-database", "Indexing"],
    };

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

            docsGrid.innerHTML = "";

            if (!data.documents || data.documents.length === 0) {
                docsGrid.innerHTML = search
                    ? `<div class="debug-empty-state"><i class="fa-solid fa-magnifying-glass"></i><h3>No Matches</h3><p>No documents match "${escapeHTML(search)}".</p></div>`
                    : `<div class="debug-empty-state"><i class="fa-solid fa-folder-open"></i><h3>Library Empty</h3><p>Upload files above to populate the search database.</p></div>`;
                return;
            }

            const maxChunks = Math.max(...data.documents.map(d => d.chunk_count), 1);

            data.documents.forEach(doc => {
                const card = document.createElement("div");
                card.className = "doc-file-card";

                const sizeKb   = (doc.size_bytes / 1024).toFixed(1);
                const extClass = EXT_BADGES[doc.file_type] || "badge-txt";
                const chunkPct = Math.max(5, Math.round((doc.chunk_count / maxChunks) * 100));
                const [stCls, stIcon, stLabel] = STATUS_BADGES[doc.status] || STATUS_BADGES.uploaded;
                const uploadedTs = new Date(doc.uploaded_at).getTime() / 1000;

                // Delete is admin-only (backend enforces with 403 as well)
                const deleteBtnHtml = Auth.isAdmin()
                    ? `<button class="action-btn-secondary delete-doc-btn" data-docid="${doc.id}" data-filename="${escapeHTML(doc.filename)}" title="Delete document" style="padding: 4px 8px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);"><i class="fa-solid fa-trash"></i></button>`
                    : "";

                card.innerHTML = `
                    <div class="icon-row" style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <i class="fa-regular fa-file-lines file-icon"></i>
                            <div class="doc-badges">
                                <span class="tag file-ext-badge ${extClass}">.${doc.file_type}</span>
                                <span class="tag">${doc.chunk_count} chunks</span>
                                <span class="tag doc-status-badge ${stCls}" title="${escapeHTML(doc.error_message || "")}"><i class="fa-solid ${stIcon}"></i> ${stLabel}</span>
                            </div>
                        </div>
                        ${deleteBtnHtml}
                    </div>
                    <h4 title="${escapeHTML(doc.filename)}">${escapeHTML(doc.filename)}</h4>
                    <div class="chunk-progress-track">
                        <div class="chunk-progress-fill" style="width:${chunkPct}%"></div>
                    </div>
                    <div class="meta-row">
                        <span>${sizeKb} KB</span>
                        <span>${formatDate(uploadedTs)}</span>
                    </div>
                    <div class="meta-row">
                        <span title="Uploaded by"><i class="fa-solid fa-user-pen"></i> ${escapeHTML(doc.uploaded_by_name || "—")}</span>
                    </div>`;

                docsGrid.appendChild(card);
            });

            // Bind delete events
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
        } catch (err) {
            console.error("Failed to load documents list:", err);
        }
    }

    // ----------------------------------------------------------------
    // Initial page load — runs only after successful authentication.
    // Auth.init() restores a stored session or shows the login overlay;
    // startApp() is invoked with the authenticated user.
    // ----------------------------------------------------------------
    const initialChatHTML = chatHistory.innerHTML; // welcome message snapshot
    const runEvalButton   = document.getElementById("run-eval-btn");
    const uploadSection   = document.querySelector(".upload-section");

    function applyRoleVisibility() {
        // Admin-only controls: document upload and evaluation trigger.
        // The backend enforces this with 403s regardless of what the UI shows.
        const isAdmin = Auth.isAdmin();
        if (uploadSection) uploadSection.style.display = isAdmin ? "" : "none";
        if (runEvalButton) runEvalButton.style.display = isAdmin ? "" : "none";
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
        loadDocuments();
        loadEvaluationHistory();
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
        document.querySelectorAll(".modal.active").forEach(m => m.classList.remove("active"));
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

    Auth.init(startApp);
});
