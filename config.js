// A telepített (publikus) backend címe, záró perjel nélkül, pl. 'https://ovi-kreta-tervezo.onrender.com'.
// Üresen hagyva csak a helyi (localhost) futtatás működik.
// paywallEnabled: a fizetési kapu a teszt-frontenden (GitHub Pages / localhost); stripeTestMode a tesztkártya-tippet mutatja.
window.APP_CONFIG = {
  apiBaseUrl: 'https://ovi-kreta-tervezo-api.onrender.com',
  paywallEnabled: true,
  turnstileSiteKey: '0x4AAAAAAGFSc8Zzow6VmxQ9',
  company: { stripeTestMode: true },
};
window.OVITERVEZO_CONFIG = window.APP_CONFIG;
