(() => {
  const root = document.documentElement;
  const input = document.querySelector('[data-us-i]');
  const valueEl = document.querySelector('[data-us-v]');
  const reset = document.querySelector('[data-us-r]');
  function apply(value) {
    value = +value || 100;
    root.style.setProperty('--ui-scale', value / 100);
    localStorage.us = value;
    valueEl.textContent = value + '%';
    input.value = value;
  }
  input.oninput = (event) => apply(event.target.value);
  reset.onclick = () => apply(100);
  apply(localStorage.us || 100);
})();
