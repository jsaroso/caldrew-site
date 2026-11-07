// Replaces webflow.js: language dropdown, nav scroll state and the contact form.
(function () {
  // Language dropdowns
  var dropdowns = document.querySelectorAll('[data-dropdown]');
  function closeAll(except) {
    dropdowns.forEach(function (d) {
      if (d === except) return;
      d.querySelector('.w-dropdown-list').classList.remove('w--open');
      d.querySelector('.w-dropdown-toggle').classList.remove('w--open');
      d.querySelector('.w-dropdown-toggle').setAttribute('aria-expanded', 'false');
    });
  }
  dropdowns.forEach(function (d) {
    var toggle = d.querySelector('.w-dropdown-toggle');
    var list = d.querySelector('.w-dropdown-list');
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !list.classList.contains('w--open');
      closeAll(d);
      list.classList.toggle('w--open', open);
      toggle.classList.toggle('w--open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  document.addEventListener('click', function () { closeAll(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

  // Contact form
  var form = document.querySelector('form[data-contact]');
  if (!form) return;
  var wrap = form.closest('.w-form');
  var done = wrap.querySelector('.w-form-done');
  var fail = wrap.querySelector('.w-form-fail');
  var button = form.querySelector('[type=submit]');
  var label = button.value;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    fail.style.display = 'none';
    button.value = button.getAttribute('data-wait') || label;
    button.disabled = true;
    fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); })
      .then(function () { form.style.display = 'none'; done.style.display = 'block'; })
      .catch(function () {
        fail.style.display = 'block';
        button.value = label;
        button.disabled = false;
        if (window.turnstile) window.turnstile.reset();
      });
  });
})();
