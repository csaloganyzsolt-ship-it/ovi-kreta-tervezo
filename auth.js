// Opcionális felhasználói fiók (Supabase Auth: e-mail + jelszó, jelszó-visszaállítás, előkészített Google belépés).
// Klasszikus script (nem ES modul). Vendég módban (nincs belépés, vagy hiányzik a kulcs/könyvtár) semmi nem változik: a gomb rejtve marad.
(function () {
  'use strict';

  const LOGGED_OUT_LABEL = 'Belépés / Regisztráció';
  const LOGGED_IN_LABEL = 'Fiókom';
  const PROFILE_PAGE = 'profil.html';
  const MIN_PASSWORD_LENGTH = 8;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Módonként: mely mezők látszanak, és milyen szövegek tartoznak hozzá.
  const MODES = {
    login: {
      title: 'Bejelentkezés',
      intro: 'Lépj be a fiókodba, hogy a tervezeteid és a számlázási adataid bármely eszközről elérhetők legyenek. Regisztráció nélkül is használhatod az OviTervezőt.',
      submit: 'Bejelentkezés', password: true, email: true, name: false, forgot: true, social: true, tabs: true, back: false, autocomplete: 'current-password'
    },
    register: {
      title: 'Regisztráció',
      intro: 'Hozz létre ingyenes fiókot: a tervezeteid felhőben is megmaradnak, a számlázási adataid pedig a vásárlásnál automatikusan kitöltődnek.',
      submit: 'Regisztráció', password: true, email: true, name: true, forgot: false, social: true, tabs: true, back: false, autocomplete: 'new-password'
    },
    forgot: {
      title: 'Elfelejtett jelszó',
      intro: 'Add meg a fiókod e-mail címét, és küldünk egy linket az új jelszó megadásához.',
      submit: 'Visszaállító link küldése', password: false, email: true, name: false, forgot: false, social: false, tabs: false, back: true, autocomplete: 'current-password'
    },
    recovery: {
      title: 'Új jelszó megadása',
      intro: 'Add meg az új jelszavadat, amellyel ezután belépsz.',
      submit: 'Jelszó mentése', password: true, email: false, name: false, forgot: false, social: false, tabs: false, back: false, autocomplete: 'new-password'
    }
  };

  const config = window.APP_CONFIG || {};
  const button = document.getElementById('authBtn');
  const form = document.getElementById('authForm');
  const state = { client: null, user: null, token: '', mode: 'login' };
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function byId(id) { return document.getElementById(id); }

  function setMessage(id, message) {
    const el = byId(id);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function clearMessages() {
    setMessage('authStatus', '');
    setMessage('authError', '');
  }

  function setHidden(id, hidden) {
    const el = byId(id);
    if (el) el.hidden = hidden;
  }

  function setMode(mode) {
    const spec = MODES[mode] || MODES.login;
    state.mode = MODES[mode] ? mode : 'login';
    clearMessages();
    const title = byId('authModalTitle');
    if (title) title.textContent = spec.title;
    const intro = byId('authIntro');
    if (intro) intro.textContent = spec.intro;
    const submit = byId('authSubmit');
    if (submit) submit.textContent = spec.submit;
    setHidden('authTabs', !spec.tabs);
    setHidden('authNameField', !spec.name);
    setHidden('authEmailField', !spec.email);
    setHidden('authPasswordField', !spec.password);
    setHidden('authForgot', !spec.forgot);
    setHidden('authSocial', !spec.social);
    setHidden('authBack', !spec.back);
    document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
      const active = tab.dataset.authTab === state.mode;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.classList.toggle('is-active', active);
    });
    const password = byId('authPassword');
    if (password) {
      password.autocomplete = spec.autocomplete;
      password.type = 'password';
    }
    const toggle = byId('authPasswordToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', 'Jelszó megjelenítése');
    }
  }

  function openAuthModal(mode = 'login') {
    setMode(mode);
    if (typeof openModal === 'function') openModal('authModal');
    byId(state.mode === 'recovery' ? 'authPassword' : 'authEmail')?.focus();
  }

  function render() {
    const loggedIn = Boolean(state.user);
    if (!button) return;
    button.textContent = loggedIn ? LOGGED_IN_LABEL : LOGGED_OUT_LABEL;
    button.title = loggedIn ? `Fiók: ${state.user.email}` : '';
    button.setAttribute('aria-label', loggedIn ? `${LOGGED_IN_LABEL} (${state.user.email})` : LOGGED_OUT_LABEL);
    button.classList.toggle('is-logged-in', loggedIn);
  }

  function applySession(session) {
    const previousId = state.user?.id || null;
    state.token = session?.access_token || '';
    state.user = session?.user?.id && session.user.email ? { id: session.user.id, email: session.user.email } : null;
    render();
    // A szinkronizálás csak tényleges belépéskor/kilépéskor fut (a tokenfrissítés nem indítja újra).
    if ((state.user?.id || null) !== previousId) {
      document.dispatchEvent(new CustomEvent('ovi-auth-change', { detail: { user: state.user } }));
    }
  }

  function apiBaseUrl() {
    const configured = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
    if (configured === 'same-origin') return window.location.origin;
    if (configured) return configured;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || !host ? 'http://localhost:4000' : '';
  }

  // Hitelesített JSON-hívás a backendnek; a hibát (a szerver magyar üzenetével) kivételként dobja.
  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(`${apiBaseUrl()}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function signOut(scope = 'global') {
    if (!state.client) return;
    const { error } = await state.client.auth.signOut({ scope });
    if (error) throw error;
  }

  window.OviAuth = {
    isAvailable: () => Boolean(state.client),
    getUser: () => state.user,
    getAccessToken: () => state.token,
    ready,
    apiFetch,
    signOut,
    openModal: openAuthModal
  };

  const createClient = window.supabase?.createClient;
  if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY || typeof createClient !== 'function') {
    if (button) button.hidden = true;
    resolveReady();
    return;
  }

  state.client = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  // A visszahívásban nem várunk további Supabase-hívásra (az kölcsönös zárat okozna), csak az állapotot rögzítjük.
  state.client.auth.onAuthStateChange((event, session) => {
    applySession(session);
    resolveReady();
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => openAuthModal('recovery'), 0);
  });

  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => {
      if (state.user) {
        window.location.href = PROFILE_PAGE;
        return;
      }
      openAuthModal('login');
    });
  }

  document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.authTab));
  });
  byId('authForgot')?.addEventListener('click', () => setMode('forgot'));
  byId('authBack')?.addEventListener('click', () => setMode('login'));

  byId('authPasswordToggle')?.addEventListener('click', (event) => {
    const input = byId('authPassword');
    if (!input) return;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-pressed', visible ? 'true' : 'false');
    event.currentTarget.setAttribute('aria-label', visible ? 'Jelszó elrejtése' : 'Jelszó megjelenítése');
  });

  // A Google belépés előkészítve: amíg a szolgáltató nincs beállítva (googleAuthEnabled), a gomb inaktív és "Hamarosan" jelzést kap.
  const googleButton = byId('authGoogle');
  if (googleButton && config.googleAuthEnabled === true) {
    googleButton.disabled = false;
    googleButton.removeAttribute('aria-disabled');
    byId('authGoogleSoon')?.setAttribute('hidden', '');
    googleButton.addEventListener('click', async () => {
      clearMessages();
      try {
        const { error } = await state.client.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: `${window.location.origin}/tervezo.html` }
        });
        if (error) throw error;
      } catch (error) {
        setMessage('authError', `A Google belépés sikertelen: ${error.message}`);
      }
    });
  }

  function friendlyError(error) {
    const message = String(error?.message || '');
    if (/invalid login credentials/i.test(message)) return 'Hibás e-mail cím vagy jelszó.';
    if (/email not confirmed/i.test(message)) return 'Az e-mail címed még nincs megerősítve. Nézd meg a postaládádat a megerősítő levélért.';
    if (/rate limit|too many/i.test(message)) return 'Túl sok próbálkozás. Kérjük, várj pár percet, és próbáld újra.';
    if (/password.*(weak|short|least)|weak password/i.test(message)) return `A jelszó túl gyenge, legalább ${MIN_PASSWORD_LENGTH} karakter szükséges.`;
    return message || 'Ismeretlen hiba.';
  }

  function closeAuthModal() {
    if (typeof closeModals === 'function') closeModals();
  }

  async function runMode(mode, values) {
    const redirectTo = `${window.location.origin}/tervezo.html`;
    if (mode === 'login') {
      const { error } = await state.client.auth.signInWithPassword({ email: values.email, password: values.password });
      if (error) throw error;
      closeAuthModal();
      return '';
    }
    if (mode === 'register') {
      const { data, error } = await state.client.auth.signUp({
        email: values.email,
        password: values.password,
        options: { emailRedirectTo: redirectTo, data: values.name ? { full_name: values.name } : {} }
      });
      if (error) throw error;
      if (data?.session) {
        closeAuthModal();
        return '';
      }
      return 'Elküldtük a megerősítő levelet az e-mail címedre. A benne lévő linkre kattintva aktiválhatod a fiókodat.';
    }
    if (mode === 'forgot') {
      const { error } = await state.client.auth.resetPasswordForEmail(values.email, { redirectTo });
      if (error) throw error;
      return 'Ha az e-mail címhez tartozik fiók, elküldtük a jelszó-visszaállító linket.';
    }
    const { error } = await state.client.auth.updateUser({ password: values.password });
    if (error) throw error;
    closeAuthModal();
    return '';
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();
    const spec = MODES[state.mode];
    const email = String(byId('authEmail')?.value || '').trim();
    const password = String(byId('authPassword')?.value || '');
    const name = String(byId('authName')?.value || '').trim().slice(0, 120);
    if (spec.email && !EMAIL_PATTERN.test(email)) {
      setMessage('authError', 'Adj meg érvényes e-mail címet.');
      return;
    }
    if (spec.password && !password) {
      setMessage('authError', 'Add meg a jelszavadat.');
      return;
    }
    if (spec.password && state.mode !== 'login' && password.length < MIN_PASSWORD_LENGTH) {
      setMessage('authError', `A jelszó legalább ${MIN_PASSWORD_LENGTH} karakter hosszú legyen.`);
      return;
    }
    const submit = byId('authSubmit');
    if (submit) submit.disabled = true;
    try {
      const status = await runMode(state.mode, { email, password, name });
      if (status) setMessage('authStatus', status);
      const passwordInput = byId('authPassword');
      if (passwordInput) passwordInput.value = '';
    } catch (error) {
      setMessage('authError', friendlyError(error));
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  setMode('login');
  render();
})();
