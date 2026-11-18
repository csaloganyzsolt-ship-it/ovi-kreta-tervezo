// A telepített (publikus) backend címe, záró perjel nélkül, pl. 'https://ovi-kreta-tervezo.onrender.com'.
// Üresen hagyva csak a helyi (localhost) futtatás működik.
// paywallEnabled: a fizetési kapu a teszt-frontenden (GitHub Pages / localhost); stripeTestMode a tesztkártya-tippet mutatja.
window.APP_CONFIG = {
  apiBaseUrl: 'https://ovi-kreta-tervezo-api.onrender.com',
  paywallEnabled: true,
  turnstileSiteKey: '0x4AAAAAAGFSc8Zzow6VmxQ9',
  barionPixelId: 'BP-U0p5Sp7I1Q-EF',
  company: {
    type: 'ev',
    name: 'Csalogány Zsolt egyéni vállalkozó',
    taxId: '68274568-1-28',
    regLabel: 'EV nyilvántartási szám',
    regNo: '51507048',
    court: '',
    address: '9153 Öttevény, Kossuth Lajos utca 26.',
    vatNote: 'Alanyi adómentes (AAM) értékesítés, az árak 0 Ft ÁFÁ-t tartalmaznak.',
    email: 'info@ovitervezo.hu',
    stripeTestMode: true
  },
};
