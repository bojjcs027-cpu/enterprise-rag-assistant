// ---------------------------------------------------------------------------
// OmniGuard Authentication Module (JWT)
//
// Loaded before app.js. Exposes window.Auth:
//   Auth.init(onAuthenticated)  — session restore or show login overlay
//   Auth.fetch(url, options)    — fetch with Bearer header + auto-refresh
//   Auth.getUser() / Auth.isAdmin()
//   Auth.logout()
//
// Token storage: localStorage when "Remember me" is checked (survives browser
// restarts), sessionStorage otherwise (cleared when the tab closes).
// ---------------------------------------------------------------------------

window.Auth = (() => {
    const STORAGE_KEY = "omni_auth_v1";

    let accessToken  = null;
    let refreshToken = null;
    let currentUser  = null;
    let usePersistentStorage = false;
    let onAuthenticatedCb = null;
    let refreshInFlight = null; // single-flight refresh promise

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    function saveSession() {
        const payload = JSON.stringify({ accessToken, refreshToken, user: currentUser });
        try {
            if (usePersistentStorage) {
                localStorage.setItem(STORAGE_KEY, payload);
                sessionStorage.removeItem(STORAGE_KEY);
            } else {
                sessionStorage.setItem(STORAGE_KEY, payload);
                localStorage.removeItem(STORAGE_KEY);
            }
        } catch (e) {
            console.warn("[Auth] Could not persist session:", e);
        }
    }

    function loadSession() {
        try {
            let raw = sessionStorage.getItem(STORAGE_KEY);
            usePersistentStorage = false;
            if (!raw) {
                raw = localStorage.getItem(STORAGE_KEY);
                usePersistentStorage = !!raw;
            }
            if (!raw) return false;
            const data = JSON.parse(raw);
            accessToken  = data.accessToken  || null;
            refreshToken = data.refreshToken || null;
            currentUser  = data.user         || null;
            return !!(accessToken && refreshToken);
        } catch (e) {
            return false;
        }
    }

    function clearSession() {
        accessToken = refreshToken = currentUser = null;
        try {
            sessionStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* ignore */ }
    }

    function adoptTokens(tokenResponse) {
        accessToken  = tokenResponse.access_token;
        refreshToken = tokenResponse.refresh_token;
        currentUser  = tokenResponse.user;
        saveSession();
    }

    // ------------------------------------------------------------------
    // API calls
    // ------------------------------------------------------------------

    async function apiLogin(email, password, remember) {
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, remember }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(extractDetail(body) || "Login failed.");
        usePersistentStorage = remember;
        adoptTokens(body);
        return body.user;
    }

    async function apiSignup(fullName, email, password) {
        const res = await fetch("/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ full_name: fullName, email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(extractDetail(body) || "Signup failed.");
        usePersistentStorage = false; // fresh signups default to session-only
        adoptTokens(body);
        return body.user;
    }

    async function apiRefresh() {
        if (!refreshToken) throw new Error("No refresh token.");
        const res = await fetch("/api/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(extractDetail(body) || "Session expired.");
        adoptTokens(body);
    }

    function refreshOnce() {
        // Collapse concurrent 401s into a single refresh round-trip
        if (!refreshInFlight) {
            refreshInFlight = apiRefresh().finally(() => { refreshInFlight = null; });
        }
        return refreshInFlight;
    }

    async function apiLogout() {
        if (refreshToken) {
            try {
                await fetch("/api/auth/logout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh_token: refreshToken }),
                });
            } catch (e) { /* server unreachable — still clear locally */ }
        }
        clearSession();
    }

    // Pydantic 422 errors arrive as {detail: [{msg, loc}...]}; auth errors as {detail: "..."}
    function extractDetail(body) {
        if (!body || !body.detail) return null;
        if (typeof body.detail === "string") return body.detail;
        if (Array.isArray(body.detail)) {
            return body.detail.map(d => d.msg || JSON.stringify(d)).join(" ");
        }
        return JSON.stringify(body.detail);
    }

    // ------------------------------------------------------------------
    // Authenticated fetch with automatic refresh-and-retry
    // ------------------------------------------------------------------

    async function authFetch(url, options = {}) {
        const doFetch = () => {
            const headers = new Headers(options.headers || {});
            if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
            return fetch(url, { ...options, headers });
        };

        let res = await doFetch();
        if (res.status === 401 && refreshToken) {
            try {
                await refreshOnce();
                res = await doFetch(); // retry once with the fresh token
            } catch (e) {
                console.warn("[Auth] Token refresh failed — returning to login.", e);
                clearSession();
                showOverlay();
                throw new Error("Your session has expired. Please sign in again.");
            }
        }
        return res;
    }

    // ------------------------------------------------------------------
    // UI: overlay, forms, dropdown, profile modal
    // ------------------------------------------------------------------

    const $ = (id) => document.getElementById(id);

    function initialsOf(name) {
        return (name || "?")
            .split(/\s+/).filter(Boolean).slice(0, 2)
            .map(p => p[0].toUpperCase()).join("") || "?";
    }

    function showError(el, message) {
        el.textContent = message;
        el.style.display = "block";
    }

    function hideError(el) {
        el.style.display = "none";
    }

    function showOverlay() {
        const overlay = $("sso-overlay");
        const mainApp = $("main-app");
        overlay.style.display = "flex";
        overlay.style.opacity = "1";
        overlay.classList.add("active");
        mainApp.style.display = "none";
    }

    function hideOverlayShowApp() {
        const overlay = $("sso-overlay");
        const mainApp = $("main-app");
        overlay.style.opacity = "0";
        overlay.style.transition = "opacity 0.4s ease";
        setTimeout(() => {
            overlay.style.display = "none";
            mainApp.style.display = "flex";
            mainApp.style.opacity = "0";
            mainApp.style.transition = "opacity 0.4s ease";
            requestAnimationFrame(() => { mainApp.style.opacity = "1"; });
        }, 400);
        renderUserMenu();
    }

    function renderUserMenu() {
        if (!currentUser) return;
        $("user-menu").style.display = "block";
        $("user-avatar-initials").textContent = initialsOf(currentUser.full_name);
        $("user-menu-name").textContent = currentUser.full_name;
        $("user-menu-role").textContent =
            currentUser.role === "admin" ? "Administrator" : "Analyst";
    }

    function toggleDropdown(forceClose = false) {
        const dd = $("user-menu-dropdown");
        const trigger = $("user-menu-trigger");
        const isOpen = dd.style.display !== "none";
        const next = forceClose ? false : !isOpen;
        dd.style.display = next ? "block" : "none";
        trigger.setAttribute("aria-expanded", String(next));
    }

    function openProfileModal() {
        toggleDropdown(true);
        const feedback = $("profile-feedback");
        hideError(feedback);
        $("profile-avatar-initials").textContent = initialsOf(currentUser.full_name);
        $("profile-name").textContent = currentUser.full_name;
        $("profile-email").textContent = currentUser.email;
        $("profile-role-tag").textContent =
            currentUser.role === "admin" ? "Administrator" : "Analyst";
        $("profile-joined-tag").textContent =
            "Joined " + new Date(currentUser.created_at).toLocaleDateString();
        $("profile-name-input").value = currentUser.full_name;
        $("profile-current-password").value = "";
        $("profile-new-password").value = "";
        $("profile-modal").classList.add("active");

        // Refresh from the server in the background so the modal is accurate
        authFetch("/api/auth/me")
            .then(r => r.ok ? r.json() : null)
            .then(user => {
                if (user) {
                    currentUser = user;
                    saveSession();
                    $("profile-name").textContent = user.full_name;
                    $("profile-email").textContent = user.email;
                }
            })
            .catch(() => { /* offline — keep cached values */ });
    }

    function bindUI() {
        const loginForm    = $("login-form");
        const signupForm   = $("signup-form");
        const switchBtn    = $("auth-switch-btn");
        const switchLabel  = $("auth-switch-label");
        const subtitle     = $("auth-subtitle");
        const errorBox     = $("auth-error");
        let mode = "login";

        switchBtn.addEventListener("click", () => {
            mode = mode === "login" ? "signup" : "login";
            hideError(errorBox);
            loginForm.style.display  = mode === "login"  ? "" : "none";
            signupForm.style.display = mode === "signup" ? "" : "none";
            subtitle.textContent    = mode === "login" ? "Sign in to your account" : "Create your account";
            switchLabel.textContent = mode === "login" ? "Don't have an account?" : "Already have an account?";
            switchBtn.textContent   = mode === "login" ? "Sign up" : "Sign in";
        });

        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            hideError(errorBox);
            const btn = $("login-submit-btn");
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in…';
            try {
                const user = await apiLogin(
                    $("login-email").value.trim(),
                    $("login-password").value,
                    $("login-remember").checked
                );
                $("login-password").value = "";
                hideOverlayShowApp();
                if (onAuthenticatedCb) onAuthenticatedCb(user);
            } catch (err) {
                showError(errorBox, err.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
            }
        });

        signupForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            hideError(errorBox);
            const password = $("signup-password").value;
            if (password !== $("signup-confirm").value) {
                showError(errorBox, "Passwords do not match.");
                return;
            }
            const btn = $("signup-submit-btn");
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating account…';
            try {
                const user = await apiSignup(
                    $("signup-name").value.trim(),
                    $("signup-email").value.trim(),
                    password
                );
                $("signup-password").value = "";
                $("signup-confirm").value = "";
                hideOverlayShowApp();
                if (onAuthenticatedCb) onAuthenticatedCb(user);
            } catch (err) {
                showError(errorBox, err.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
            }
        });

        // Dropdown
        $("user-menu-trigger").addEventListener("click", (e) => {
            e.stopPropagation();
            toggleDropdown();
        });
        document.addEventListener("click", () => toggleDropdown(true));

        $("menu-logout-btn").addEventListener("click", async () => {
            await apiLogout();
            window.location.reload();
        });

        $("menu-profile-btn").addEventListener("click", openProfileModal);
        $("close-profile-modal-btn").addEventListener("click", () =>
            $("profile-modal").classList.remove("active"));
        $("profile-modal").addEventListener("click", (e) => {
            if (e.target === $("profile-modal")) $("profile-modal").classList.remove("active");
        });

        // Profile: rename
        $("profile-name-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const feedback = $("profile-feedback");
            hideError(feedback);
            try {
                const res = await authFetch("/api/auth/me", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ full_name: $("profile-name-input").value.trim() }),
                });
                const body = await res.json();
                if (!res.ok) throw new Error(extractDetail(body) || "Update failed.");
                currentUser = body;
                saveSession();
                renderUserMenu();
                $("profile-name").textContent = body.full_name;
                feedback.className = "auth-success";
                showError(feedback, "Name updated.");
            } catch (err) {
                feedback.className = "auth-error";
                showError(feedback, err.message);
            }
        });

        // Profile: change password
        $("profile-password-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const feedback = $("profile-feedback");
            hideError(feedback);
            try {
                const res = await authFetch("/api/auth/me", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        current_password: $("profile-current-password").value,
                        new_password: $("profile-new-password").value,
                    }),
                });
                const body = await res.json();
                if (!res.ok) throw new Error(extractDetail(body) || "Password change failed.");
                $("profile-current-password").value = "";
                $("profile-new-password").value = "";
                feedback.className = "auth-success";
                showError(feedback, "Password changed. Other sessions were signed out.");
            } catch (err) {
                feedback.className = "auth-error";
                showError(feedback, err.message);
            }
        });
    }

    // ------------------------------------------------------------------
    // Bootstrap
    // ------------------------------------------------------------------

    async function init(onAuthenticated) {
        onAuthenticatedCb = onAuthenticated;
        bindUI();

        if (!loadSession()) {
            showOverlay();
            return;
        }

        // Validate the stored session; authFetch transparently refreshes an
        // expired access token using the stored refresh token.
        try {
            const res = await authFetch("/api/auth/me");
            if (!res.ok) throw new Error("Session invalid");
            currentUser = await res.json();
            saveSession();
            hideOverlayShowApp();
            if (onAuthenticatedCb) onAuthenticatedCb(currentUser);
        } catch (e) {
            clearSession();
            showOverlay();
        }
    }

    return {
        init,
        fetch: authFetch,
        getUser: () => currentUser,
        isAdmin: () => !!currentUser && currentUser.role === "admin",
        logout: apiLogout,
        // Read-only token accessor for XMLHttpRequest-based uploads
        // (fetch cannot report upload progress). Additive; no behaviour change.
        getAccessToken: () => accessToken,
    };
})();
