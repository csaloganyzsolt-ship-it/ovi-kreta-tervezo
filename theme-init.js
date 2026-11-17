// Szinkron, a stíluslap előtt futó témaválasztás: a mentett sötét mód villanás nélkül érvényesül.
try {
  document.documentElement.dataset.theme = localStorage.getItem('oviKretaTheme') === 'dark' ? 'dark' : 'light';
} catch (_error) {}
