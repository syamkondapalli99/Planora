/* =========================================================
   PLANORA SIGN-IN PAGE  (login.js)

   Supabase Auth:
   - Continue with Google / Apple (OAuth, comes back to this page)
   - Email + password: sign in, create account (with email
     confirmation when it's switched on), forgot password
   - Already signed in → straight into Planora (no login flash)
   - First sign-in → short onboarding → Home
   ========================================================= */

(function () {

    const $ = id => document.getElementById(id);
    const auth = () => window.PlanoraAuth;
    const sb = () => window.PlanoraAuth && PlanoraAuth.client;

    let busy = false;
    let mode = "login";
    let lastEmail = "";
    let resendKind = "signup";


    /* ---------------- small helpers ---------------- */

    function showError(id, message) {
        const el = $(id);
        if (!el) return;
        el.textContent = message || "";
        el.hidden = !message;
    }
    function banner(message, type) {
        const el = $("auth-banner");
        el.textContent = message || "";
        el.className = "auth-banner" + (type ? " is-" + type : "");
        el.hidden = !message;
    }
    const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

    // Loading state: spinner, disabled, aria-busy. Every other auth button is disabled too.
    function setBusy(button, on, label) {
        busy = on;
        document.querySelectorAll("#auth-main button, #auth-main input").forEach(el => {
            if (el.id === "skip-btn") return;
            if (on) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; }
            else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === "1"; delete el.dataset.wasDisabled; }
        });
        if (!button) return;
        const span = button.querySelector("span") || button;
        if (on) {
            button.dataset.label = span.textContent;
            span.textContent = label || "Please wait…";
            button.setAttribute("aria-busy", "true");
            button.classList.add("is-busy");
        } else {
            if (button.dataset.label) span.textContent = button.dataset.label;
            button.removeAttribute("aria-busy");
            button.classList.remove("is-busy");
        }
    }

    function showMain() {
        $("auth-checking").hidden = true;
        $("auth-main").hidden = false;
    }
    function showChecking(text) {
        $("auth-checking-text").textContent = text || "Loading…";
        $("auth-checking").hidden = false;
        $("auth-main").hidden = true;
    }

    function showMode(next) {
        mode = next;
        const titles = {
            login: ["Welcome back", "Plan your day. Get more done."],
            signup: ["Create your Planora account", "Free, and ready in a minute."],
            forgot: ["Reset your password", ""],
            sent: ["Check your email", ""]
        };
        $("auth-title").textContent = titles[next][0];
        $("auth-subtitle").textContent = titles[next][1];
        $("auth-subtitle").hidden = !titles[next][1];
        $("login-form").hidden = next !== "login";
        $("signup-form").hidden = next !== "signup";
        $("forgot-form").hidden = next !== "forgot";
        $("check-email").hidden = next !== "sent";
        const oauth = next === "login" || next === "signup";
        $("oauth-buttons").hidden = !oauth;
        $("email-divider").hidden = !oauth;
        $("footer-to-signup").hidden = next !== "login";
        $("footer-to-login").hidden = next !== "signup";
        ["login-error", "signup-error", "forgot-error", "check-email-error"].forEach(id => showError(id, ""));
        if (next !== "sent") banner("");
        const first = { login: "login-email", signup: "signup-name", forgot: "forgot-email" }[next];
        if (first && window.innerWidth > 700) setTimeout(() => {
            const active = document.activeElement;
            const typing = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
            if (!typing && $(first)) $(first).focus();     // don't pull the cursor out of a box you're already in
        }, 20);
        if (next === "forgot" && $("login-email").value) $("forgot-email").value = $("login-email").value;
    }

    function showSent(text, kind) {
        resendKind = kind;
        $("check-email-text").innerHTML = text;
        $("resend-btn").hidden = !kind;
        showMode("sent");
    }

    function togglePassword(button) {
        const input = button.parentElement.querySelector("input");
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.innerHTML = `<i class="ti ${show ? "ti-eye-off" : "ti-eye"}" aria-hidden="true"></i>`;
        button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    }

    function updateRules() {
        const pw = $("signup-password").value, cf = $("signup-confirm").value;
        const set = (rule, ok) => {
            const li = document.querySelector(`#pw-rules [data-rule="${rule}"]`);
            li.classList.toggle("ok", ok);
            li.querySelector("i").className = "ti " + (ok ? "ti-circle-check-filled" : "ti-circle");
        };
        set("length", pw.length >= 8);
        set("match", pw.length > 0 && pw === cf);
    }

    function notReady() {
        if (auth() && auth().configured) return false;
        const msg = auth() && auth().isDev
            ? "Sign-in isn't connected yet: add your Supabase URL and anon key to planora-config.js. You can use \"Skip to dashboard\" meanwhile."
            : "Sign-in is being set up. Please try again soon.";
        banner(msg, "warn");
        return true;
    }


    /* ---------------- after any successful sign-in ---------------- */

    async function signedIn(note) {
        showChecking(note || "Signing you in…");
        try {
            const user = await auth().afterSignIn();
            if (user.onboarded) {
                location.replace(localStorage.getItem("planora_pref_start_page") || "home.html");
            } else {
                startOnboarding(user);
            }
        } catch (error) {
            showMain();
            showMode("login");
            banner(auth().friendlyError(error).message, "error");
        }
    }

    function startOnboarding(user) {
        if (typeof currentStep !== "undefined") currentStep = 1;   // eslint-disable-line no-global-assign
        if (typeof showStep === "function") showStep(1);
        document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
        $("onboarding-screen").classList.add("active");
        const heading = document.querySelector('.onboard-step[data-step="1"] h2');
        if (heading && user && user.name && !user.guest) {
            heading.textContent = `Welcome, ${user.name.split(/\s+/)[0]}! What do you want Planora to help you with?`;
        }
    }


    /* ---------------- email + password ---------------- */

    async function login() {
        if (busy || notReady()) return;
        const email = $("login-email").value.trim();
        const password = $("login-password").value;
        if (!email || !password) return showError("login-error", "Please enter your email and password.");
        if (!isEmail(email)) return showError("login-error", "Please enter a valid email address.");
        showError("login-error", "");
        setBusy($("login-submit"), true, "Signing in…");
        try {
            const { error } = await sb().auth.signInWithPassword({ email, password });
            if (error) throw error;
            setBusy($("login-submit"), false);
            await signedIn();
        } catch (error) {
            setBusy($("login-submit"), false);
            const friendly = auth().friendlyError(error);
            if (/confirm your email/.test(friendly.message)) {
                lastEmail = email;
                showSent(`Please confirm your email first. We sent a link to <strong>${escapeHtml(email)}</strong>. Open it on this device, then sign in.`, "signup");
                return;
            }
            showError("login-error", friendly.message);
        }
    }

    async function createAccount() {
        if (busy || notReady()) return;
        const name = $("signup-name").value.trim();
        const email = $("signup-email").value.trim().toLowerCase();
        const password = $("signup-password").value;
        const confirm = $("signup-confirm").value;
        if (!isEmail(email)) return showError("signup-error", "Please enter a valid email address.");
        if (password.length < 8) return showError("signup-error", "Password must be at least 8 characters.");
        if (password !== confirm) return showError("signup-error", "Passwords don't match.");
        showError("signup-error", "");
        setBusy($("signup-submit"), true, "Creating account…");
        try {
            const { data, error } = await sb().auth.signUp({
                email, password,
                options: { emailRedirectTo: auth().siteBase(), data: name ? { full_name: name } : {} }
            });
            if (error) throw error;
            setBusy($("signup-submit"), false);
            // Supabase hides whether an email is taken when confirmation is on: no identities = already registered
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                showError("signup-error", "An account with this email already exists. Sign in instead, or reset your password.");
                return;
            }
            if (data.session) { await signedIn("Setting up your account…"); return; }
            lastEmail = email;
            showSent(`We sent a confirmation link to <strong>${escapeHtml(email)}</strong>. Open it on this device to finish creating your account.`, "signup");
        } catch (error) {
            setBusy($("signup-submit"), false);
            showError("signup-error", auth().friendlyError(error).message);
        }
    }

    async function forgot() {
        if (busy || notReady()) return;
        const email = $("forgot-email").value.trim().toLowerCase();
        if (!isEmail(email)) return showError("forgot-error", "Please enter a valid email address.");
        showError("forgot-error", "");
        setBusy($("forgot-submit"), true, "Sending…");
        try {
            const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: auth().siteBase() + "reset-password.html" });
            if (error) throw error;
            setBusy($("forgot-submit"), false);
            lastEmail = email;
            // Same message whether or not the account exists (doesn't reveal who uses Planora)
            showSent(`If there's a Planora account for <strong>${escapeHtml(email)}</strong>, you'll get an email with a link to choose a new password.`, "recovery");
        } catch (error) {
            setBusy($("forgot-submit"), false);
            showError("forgot-error", auth().friendlyError(error).message);
        }
    }

    async function resend() {
        if (busy || !lastEmail) return;
        setBusy($("resend-btn"), true, "Sending…");
        try {
            const { error } = resendKind === "recovery"
                ? await sb().auth.resetPasswordForEmail(lastEmail, { redirectTo: auth().siteBase() + "reset-password.html" })
                : await sb().auth.resend({ type: "signup", email: lastEmail, options: { emailRedirectTo: auth().siteBase() } });
            if (error) throw error;
            setBusy($("resend-btn"), false);
            showError("check-email-error", "");
            auth().toast("Sent. Check your inbox (and spam folder).", "success");
        } catch (error) {
            setBusy($("resend-btn"), false);
            showError("check-email-error", auth().friendlyError(error).message);
        }
    }


    /* ---------------- Google / Apple (Supabase OAuth) ---------------- */

    async function providerEnabled(provider) {
        try {
            const cfg = window.PLANORA_CONFIG || {};
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(`${String(cfg.supabaseUrl).replace(/\/$/, "")}/auth/v1/settings`, {
                headers: { apikey: cfg.supabaseAnonKey }, signal: ctrl.signal
            });
            clearTimeout(timer);
            if (!res.ok) return null;
            const settings = await res.json();
            return settings && settings.external ? Boolean(settings.external[provider]) : null;
        } catch { return null; }
    }

    async function oauth(provider) {
        if (busy || notReady()) return;
        const label = provider === "apple" ? "Apple" : "Google";
        const button = $(provider + "-btn");
        banner("");
        setBusy(button, true, `Opening ${label}…`);
        try {
            // Is this provider switched on in Supabase? (public settings; if they can't be read, just try)
            const enabled = await providerEnabled(provider);
            if (enabled === false) {
                setBusy(button, false);
                banner(`${label} sign-in isn't turned on yet. Please use email for now.`, "warn");
                return;
            }
            const { data, error } = await sb().auth.signInWithOAuth({
                provider,
                options: { redirectTo: auth().siteBase(), skipBrowserRedirect: true }
            });
            if (error) throw error;
            // go to Google / Apple; it comes back to this page
            location.assign(data.url);
            setTimeout(() => setBusy(button, false), 8000);
        } catch (error) {
            setBusy(button, false);
            banner(auth().friendlyError(error, label).message, "error");
        }
    }


    /* ---------------- Google: official pop-up ----------------
       With a Google Client ID in planora-config.js, Google's own button opens a
       small pop-up that says "Sign in to planoraai.net". The ID token it returns
       is checked by Supabase (signInWithIdToken, with a one-time nonce).
       If Google's script can't load, the normal redirect button stays. */

    let gsiNonce = null;
    let gsiReady = false;
    let gsiFailed = false;

    function randomHex(bytes) {
        return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
    }
    async function sha256Hex(text) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }
    function waitForGoogleScript(ms) {
        return new Promise(resolve => {
            const start = Date.now();
            (function poll() {
                if (window.google && google.accounts && google.accounts.id) return resolve(true);
                if (gsiFailed || Date.now() - start > ms) return resolve(false);
                setTimeout(poll, 100);
            })();
        });
    }

    function renderGoogleButton() {
        if (!gsiReady) return;
        const host = $("gsi-btn");
        const width = Math.round($("oauth-buttons").getBoundingClientRect().width) || 360;
        host.innerHTML = "";
        google.accounts.id.renderButton(host, {
            type: "standard", theme: "outline", size: "large", text: "continue_with",
            shape: "rectangular", logo_alignment: "center", width: Math.max(220, Math.min(400, width))
        });
        host.hidden = false;
        $("google-btn").hidden = true;
    }

    // While Google's button is loading (usually under a second), the stand-in button
    // waits instead of starting the full-page sign-in.
    function holdGoogleButton(on) {
        const btn = $("google-btn");
        if (!on && busy) { btn.dataset.wasDisabled = ""; }      // another sign-in is running: re-enable when it ends
        else btn.disabled = on;
        btn.classList.toggle("is-loading", on);
        if (on) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
    }

    async function setupGooglePopup() {
        const cfg = window.PLANORA_CONFIG || {};
        if (!auth().configured || !cfg.googleClientId || !window.crypto || !crypto.subtle) return;
        holdGoogleButton(true);
        try { await loadGooglePopup(cfg); }
        finally { holdGoogleButton(false); }
    }

    async function loadGooglePopup(cfg) {
        if (await providerEnabled("google") === false) return;   // the normal button explains it isn't on yet
        if (!document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')) {
            const tag = document.createElement("script");
            tag.src = "https://accounts.google.com/gsi/client";
            tag.async = true;
            tag.onerror = () => { gsiFailed = true; };      // blocked or offline: stop waiting straight away
            document.head.appendChild(tag);
        }
        if (!(await waitForGoogleScript(6000))) return;          // blocked or offline: keep the redirect button
        try {
            gsiNonce = randomHex(32);
            google.accounts.id.initialize({
                client_id: cfg.googleClientId,
                callback: onGoogleCredential,
                nonce: await sha256Hex(gsiNonce),
                ux_mode: "popup",
                auto_select: false,
                itp_support: true
            });
            gsiReady = true;
            renderGoogleButton();
            let t;
            window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(renderGoogleButton, 200); });
        } catch (error) {
            gsiReady = false;
            $("gsi-btn").hidden = true;
            $("google-btn").hidden = false;
        }
    }

    async function onGoogleCredential(response) {
        if (busy || !response || !response.credential) return;
        const backTo = mode === "signup" ? "signup" : "login";
        showChecking("Signing you in…");
        try {
            const { error } = await sb().auth.signInWithIdToken({ provider: "google", token: response.credential, nonce: gsiNonce });
            if (error) throw error;
            await signedIn();
        } catch (error) {
            showMain();
            showMode(backTo);
            banner(auth().friendlyError(error, "Google").message, "error");
        }
    }


    /* ---------------- development only: try without an account ---------------- */

    function skip() {
        try {
            const user = auth().startGuest();
            location.replace(user.onboarded ? "home.html" : "index.html");
        } catch (error) { banner(error.message, "error"); }
    }


    /* ---------------- onboarding → save answers ---------------- */

    function selectedText(step, selector) {
        return Array.from(document.querySelectorAll(`.onboard-step[data-step="${step}"] ${selector}.selected`)).map(el => el.textContent.trim());
    }

    async function finishOnboarding() {
        const time = selectedText(2, ".option-card")[0] || null;
        const prefs = {
            goal: selectedText(1, ".option-card")[0] || null,
            productiveTimes: time ? [time] : [],
            activeDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            reminders: false
        };
        const next = $("next-btn");
        if (next) { next.disabled = true; next.textContent = "Setting up…"; }
        try {
            await auth().updateProfile({ prefs, onboarded: true });
            location.replace("home.html");
        } catch (error) {
            if (next) { next.disabled = false; next.textContent = "Let's go"; }
            auth().toast(error.message, "error");
        }
    }


    /* ---------------- start ---------------- */

    function escapeHtml(t) {
        const d = document.createElement("div");
        d.textContent = String(t);
        return d.innerHTML;
    }

    function oauthErrorFromUrl() {
        const q = new URLSearchParams(location.search);
        const h = new URLSearchParams(location.hash.replace(/^#/, ""));
        const err = q.get("error") || h.get("error");
        if (!err) return null;
        const desc = q.get("error_description") || h.get("error_description") || err;
        const code = q.get("error_code") || h.get("error_code") || "";
        // tidy the address bar
        history.replaceState(null, "", location.pathname);
        return auth().friendlyError({ message: `${err} ${code} ${desc}` });
    }

    async function init() {
        const params = new URLSearchParams(location.search);

        // wire up the page
        $("login-form").addEventListener("submit", e => { e.preventDefault(); login(); });
        $("signup-form").addEventListener("submit", e => { e.preventDefault(); createAccount(); });
        $("forgot-form").addEventListener("submit", e => { e.preventDefault(); forgot(); });
        $("forgot-link").addEventListener("click", () => showMode("forgot"));
        $("resend-btn").addEventListener("click", resend);
        $("google-btn").addEventListener("click", () => oauth("google"));
        $("apple-btn").addEventListener("click", () => oauth("apple"));
        $("skip-btn").addEventListener("click", skip);
        document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => showMode(b.dataset.mode)));
        document.querySelectorAll("[data-pw-toggle]").forEach(b => b.addEventListener("click", () => togglePassword(b)));
        ["signup-password", "signup-confirm"].forEach(id => $(id).addEventListener("input", updateRules));

        const a = auth();
        $("skip-btn").hidden = !a.isDev;
        if (!a.configured) {
            $("auth-config-note").textContent = a.isDev
                ? "Development: Supabase isn't connected yet (planora-config.js). Sign-in buttons are disabled until it is."
                : "";
            $("auth-config-note").hidden = !a.isDev;
        }

        const oauthError = oauthErrorFromUrl();
        let message = null, type = "info";
        if (params.has("signedout")) message = "You've been signed out.";
        if (params.has("expired")) { message = "Your session has ended. Please sign in again."; type = "warn"; }
        if (params.has("deleted")) message = "Your account has been deleted.";
        if (oauthError) { message = oauthError.message; type = "error"; }
        if (params.get("mode") === "signup") showMode("signup");
        else if (params.get("mode") === "forgot") showMode("forgot");
        else showMode("login");

        // Guest (development) who hasn't finished onboarding yet
        if (a.isGuest && a.isGuest() && !params.has("signedout")) { location.replace("home.html"); return; }

        // Signed in already (or just back from Google/Apple/an email link)? Go straight in.
        if (a.configured && !params.has("signedout") && !params.has("deleted")) {
            showChecking(params.has("code") ? "Signing you in…" : "Loading…");
            try {
                const { data, error } = await sb().auth.getSession();
                if (error) throw error;
                if (data.session) { await signedIn(); return; }
            } catch (error) {
                message = auth().friendlyError(error).message;
                type = "error";
            }
            if (params.has("code")) history.replaceState(null, "", location.pathname);
        }
        showMain();
        if (message) banner(message, type);
        if (!a.configured) notReady();
        setupGooglePopup();
    }

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && (mode === "forgot" || mode === "sent")) showMode("login");
    });

    window.PlanoraLogin = { login, createAccount, showMode, togglePassword, google: () => oauth("google"), apple: () => oauth("apple"), skip, finishOnboarding };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();
