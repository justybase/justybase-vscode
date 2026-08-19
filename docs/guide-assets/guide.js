(() => {
  document.body?.classList.replace('no-js', 'js');
  const sidebarToggle = document.querySelector('.sidebar-toggle');
  const sidebar = document.querySelector('#guide-sidebar');
  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-open');
      sidebarToggle.setAttribute('aria-expanded', String(open));
    });
  }

  document.querySelectorAll('[data-copy-code]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy-code') || '';
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = 'Copied';
        button.classList.add('is-copied');
        window.setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('is-copied'); }, 1400);
      } catch {
        button.textContent = 'Select text';
      }
    });
  });

  const search = document.querySelector('.guide-search');
  const input = document.querySelector('#guide-search-input');
  const results = document.querySelector('#search-results');
  const indexPath = document.body?.dataset.searchIndex;
  const siteRoot = document.body?.dataset.siteRoot || '';
  let pages = [];
  if (indexPath) fetch(indexPath).then((response) => response.ok ? response.json() : []).then((value) => { pages = Array.isArray(value) ? value : []; }).catch(() => undefined);
  const renderResults = () => {
    if (!input || !results) return;
    const query = input.value.trim().toLowerCase();
    if (query.length < 2) { results.innerHTML = ''; return; }
    const matches = pages.filter((page) => `${page.title} ${page.description} ${page.text}`.toLowerCase().includes(query)).slice(0, 8);
    results.innerHTML = matches.length
      ? matches.map((page) => `<a class="search-result" href="${siteRoot}${page.url}"><strong>${escapeText(page.title)}</strong><small>${escapeText(page.category)}</small></a>`).join('')
      : '<span class="search-result"><small>No matching page.</small></span>';
  };
  input?.addEventListener('input', renderResults);
  search?.addEventListener('submit', (event) => { event.preventDefault(); renderResults(); });

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }
})();
