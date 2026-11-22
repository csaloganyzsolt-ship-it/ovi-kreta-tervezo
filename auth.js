// Opcionális felhasználói fiók (Supabase Auth, jelszó nélküli belépési link).
// Klasszikus script (nem ES modul). Vendég módban (nincs belépés, vagy hiányzik a kulcs/könyvtár) semmi nem változik: a gomb rejtve marad.
(function () {
  'use strict';

  const LOGGED_OUT_LABEL = 'Belépés / Mentett terveim';
  const SENT_MESSAGE = 'Elküldtük a belépési linket az e-mail címedre!';

  const config = window.APP_CONFIG || {};
  const button = document.getElementById('authBtn');
  const form = document.getElementById('authForm');
  const state = { client: null, user: null, token: '' };

  function byId(id) { return document.getElementById(id); }

  function setMessage(id, message) {
    const el = byId(id);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function render() {
    const loggedIn = Boolean(state.user);
    if (button) {
      button.textContent = loggedIn ? state.user.email : LOGGED_OUT_LABEL;
      button.title = loggedIn ? 'Fiók és mentett terveim' : '';
      button.setAttribute('aria-label', loggedIn ? `Fiók: ${state.user.email}` : LOGGED_OUT_LABEL);
      button.classList.toggle('is-logged-in', loggedIn);
    }
    const out = byId('authLoggedOut');
    const inn = byId('authLoggedIn');
    if (out) out.hidden = loggedIn;
    if (inn) inn.hidden = !loggedIn;
    const email = byId('authUserEmail');
    if (email) email.textContent = loggedIn ? state.user.email : '';
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

  window.OviAuth = {
    isAvailable: () => Boolean(state.client),
    getUser: () => state.user,
    getAccessToken: () => state.token
  };

  const createClient = window.supabase?.createClient;
  if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY || typeof createClient !== 'function') {
    if (button) button.hidden = true;
    return;
  }

  state.client = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  // A visszahívásban nem várunk további Supabase-hívásra (az kölcsönös zárat okozna), csak az állapotot rögzítjük.
  state.client.auth.onAuthStateChange((_event, session) => applySession(session));

  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => {
      setMessage('authStatus', '');
      setMessage('authError', '');
      openModal('authModal');
      (state.user ? byId('authLogout') : byId('authEmail'))?.focus();
    });
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('authStatus', '');
    setMessage('authError', '');
    const input = byId('authEmail');
    const email = String(input?.value || '').trim();
    if (!email || !input.checkValidity()) {
      setMessage('authError', 'Adj meg érvényes e-mail címet.');
      return;
    }
    const submit = byId('authSubmit');
    if (submit) submit.disabled = true;
    try {
      const { error } = await state.client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/tervezo.html` }
      });
      if (error) throw error;
      setMessage('authStatus', SENT_MESSAGE);
    } catch (error) {
      setMessage('authError', `A belépési link küldése sikertelen: ${error.message}`);
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  byId('authLogout')?.addEventListener('click', async () => {
    setMessage('authError', '');
    try {
      const { error } = await state.client.auth.signOut();
      if (error) throw error;
      if (typeof closeModals === 'function') closeModals();
    } catch (error) {
      setMessage('authError', `A kijelentkezés sikertelen: ${error.message}`);
    }
  });

  render();
})();
