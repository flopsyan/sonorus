// Applies the saved theme before the first paint, so switching pages never
// flashes the wrong colours. Loaded as a normal script in <head>, deliberately
// tiny and synchronous.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('sonorus-theme');
  } catch (e) {
    // private mode / storage disabled: fall back to the OS preference
  }
  // Sonorus is designed dark first, so dark is the default. "Auto" is an
  // explicit choice the user can make in the header, not the fallback.
  var theme = 'dark';
  if (saved === 'light' || saved === 'dark') {
    theme = saved;
  } else if (saved === 'system') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
