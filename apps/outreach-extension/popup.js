(function registerPopup() {
  const extractButton = document.getElementById('extract');
  const extractAllButton = document.getElementById('extract-all');
  const downloadButton = document.getElementById('download');
  const summary = document.getElementById('summary');
  const status = document.getElementById('status');
  let extraction = null;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function render(data) {
    extraction = data;
    const linkCount = data.posts.reduce((total, post) => total + post.candidateLinks.length, 0);
    document.getElementById('post-count').textContent = String(data.posts.length);
    document.getElementById('link-count').textContent = String(linkCount);
    document.getElementById('empty-count').textContent = String(
      data.diagnostics.postsWithoutCandidateLink,
    );

    const preview = document.getElementById('preview');
    preview.replaceChildren();
    for (const post of data.posts.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'post';
      const title = document.createElement('strong');
      title.textContent = post.title || post.redditId;
      const detail = document.createElement('span');
      detail.textContent = `${post.candidateLinks.length} lien(s) candidat(s)`;
      row.append(title, detail);
      preview.append(row);
    }
    summary.hidden = false;
  }

  async function runExtraction(type) {
    extractButton.disabled = true;
    extractAllButton.disabled = true;
    summary.hidden = true;
    setStatus(
      type === 'GR_EXTRACT_ALL_POSTS' ? 'Chargement automatique des posts…' : 'Analyse de la page…',
    );
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https:\/\/www\.reddit\.com\/r\/playmygame(?:\/|$)/i.test(tab.url ?? '')) {
        throw new Error('Ouvre d’abord r/playmygame dans cet onglet.');
      }
      const response = await chrome.tabs.sendMessage(tab.id, { type });
      if (!response?.ok) throw new Error(response?.error || 'La page n’a pas pu être analysée.');
      render(response.data);
      setStatus(
        response.data.posts.length
          ? `${response.data.posts.length} publication(s) prête(s) à exporter.`
          : 'Aucun post Web trouvé. Vérifie le filtre et fais défiler la page.',
      );
    } catch (error) {
      const message =
        error instanceof Error && /Receiving end does not exist/i.test(error.message)
          ? 'Recharge la page Reddit après avoir installé l’extension.'
          : error instanceof Error
            ? error.message
            : String(error);
      setStatus(message, true);
    } finally {
      extractButton.disabled = false;
      extractAllButton.disabled = false;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'GR_EXTRACTION_PROGRESS') return;
    const activity =
      message.state === 'enriching'
        ? 'lecture des posts sans lien…'
        : message.state === 'loading'
          ? 'chargement de la suite…'
          : 'défilement…';
    setStatus(
      `${message.posts} publication(s) trouvée(s) — ${activity}`,
    );
  });

  extractAllButton.addEventListener('click', () => runExtraction('GR_EXTRACT_ALL_POSTS'));
  extractButton.addEventListener('click', () => runExtraction('GR_EXTRACT_VISIBLE_POSTS'));

  downloadButton.addEventListener('click', () => {
    if (!extraction) return;
    const blob = new Blob([`${JSON.stringify(extraction, null, 2)}\n`], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gamerank-candidates-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
