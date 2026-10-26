const statusLabels = {
  site_found: 'Site candidat',
  platform_only: 'Plateforme',
  needs_review: 'À enrichir',
  contact_found: 'Contact trouvé',
  contact_form_only: 'Formulaire',
  no_public_contact: 'Aucun contact',
  extraction_failed: 'Échec analyse',
  email_sent: 'E-mail envoyé',
  rejected: 'Écarté',
};

const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const notice = document.getElementById('notice');
const searchInput = document.getElementById('search');
const statusFilter = document.getElementById('status-filter');
const emailSearchFilter = document.getElementById('email-search-filter');
const extractionButton = document.getElementById('start-extraction');
const purgeButton = document.getElementById('purge-database');
const testEmailButton = document.getElementById('send-test-email');
const autoSendDelayInput = document.getElementById('auto-send-delay');
const autoSendLimitInput = document.getElementById('auto-send-limit');
const autoSendStartButton = document.getElementById('start-auto-send');
const autoSendStopButton = document.getElementById('stop-auto-send');
const autoSendStatus = document.getElementById('auto-send-status');
let searchTimer;
let extractionTimer;
let displayedProspects = [];
let autoSendTimer;
let autoSendRunning = false;
let autoSendQueue = [];
let autoSendSentCount = 0;

function showNotice(message, type = 'success') {
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}

function renderSummary(summary) {
  document.getElementById('metric-prospects').textContent = summary.prospects;
  document.getElementById('metric-sites').textContent = summary.statuses.site_found ?? 0;
  document.getElementById('metric-review').textContent = summary.statuses.needs_review ?? 0;
  document.getElementById('metric-emails').textContent = summary.emails;
  document.getElementById('metric-duplicates').textContent = summary.duplicateEmails;
  document.getElementById('pending-sites').textContent = summary.pendingSites;
}

function renderImports(imports) {
  const container = document.getElementById('imports-list');
  container.replaceChildren();
  if (!imports.length) {
    container.append(text('p', 'Aucun fichier importé.', 'empty'));
    return;
  }
  for (const item of imports) {
    const row = document.createElement('article');
    row.className = 'stack-row';
    const copy = document.createElement('div');
    copy.append(text('strong', item.sourcePath), text('small', formatDate(item.importedAt)));
    row.append(copy, text('b', `${item.postCount} posts`, 'soft-badge'));
    container.append(row);
  }
}

function renderDuplicates(duplicates) {
  const container = document.getElementById('duplicates-list');
  const empty = document.getElementById('duplicates-empty');
  document.getElementById('duplicate-badge').textContent = duplicates.length;
  container.replaceChildren();
  empty.hidden = duplicates.length > 0;
  for (const item of duplicates) {
    const row = document.createElement('article');
    row.className = 'duplicate-row';
    row.append(text('strong', item.email));
    row.append(
      text(
        'small',
        `Conservé pour ${item.retainedFor} · écarté pour ${item.duplicateFor}`,
      ),
    );
    container.append(row);
  }
}

async function loadDashboard() {
  const data = await requestJson('/api/dashboard');
  renderSummary(data.summary);
  renderImports(data.imports);
  renderDuplicates(data.duplicateEmails);
  renderExtraction(data.extractionRun);
  return data;
}

function renderExtraction(run) {
  const status = document.getElementById('extraction-status');
  const running = run?.status === 'running';
  extractionButton.disabled = running;
  if (!run) {
    status.textContent = 'Aucune analyse lancée.';
  } else if (running) {
    status.textContent = `${run.processedCount}/${run.requestedCount} traité(s) · ${run.emailsFound} e-mail(s) · ${run.formsFound} formulaire(s)`;
  } else {
    status.textContent = `Dernière analyse : ${run.processedCount} site(s), ${run.emailsFound} e-mail(s), ${run.formsFound} formulaire(s), ${run.errorCount} erreur(s).`;
  }

  clearTimeout(extractionTimer);
  if (running) {
    extractionTimer = setTimeout(async () => {
      try {
        await refresh();
      } catch (error) {
        showNotice(error.message, 'error');
      }
    }, 1500);
  }
}

function statusChip(status) {
  return text('span', statusLabels[status] ?? status, `status status-${status}`);
}

function emailSearchChip(status) {
  const labels = {
    not_searched: 'Non recherché',
    searching: 'En cours',
    searched: 'Recherché',
  };
  return text('span', labels[status] ?? status, `search-status search-status-${status}`);
}

async function copyText(value, label) {
  await navigator.clipboard.writeText(value);
  showNotice(`${label} copié dans le presse-papiers.`);
}

function copyButton(value, label) {
  const button = text('button', 'Copier', 'copy-button');
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      await copyText(value, label);
    } catch {
      showNotice('Impossible d’accéder au presse-papiers.', 'error');
    }
  });
  return button;
}

async function sendProspectEmail(prospect) {
  const result = await requestJson(
    `/api/prospects/${encodeURIComponent(prospect.redditId)}/send-email`,
    { method: 'POST' },
  );
  prospect.messageStatus = result.messageStatus;
  prospect.messageSentAt = result.messageSentAt;
  return result;
}

function outreachCell(prospect) {
  const cell = document.createElement('td');
  cell.className = 'outreach-cell';

  const actions = document.createElement('div');
  actions.className = 'send-actions';
  const isSent = () => prospect.messageStatus === 'sent';
  const hasContactPage = () => Boolean(prospect.contactPageUrl);
  const sentText = text(
    'small',
    isSent()
      ? `Accepté par le SMTP${prospect.messageSentAt ? ` · ${formatDate(prospect.messageSentAt)}` : ''}`
      : prospect.emailAddress
        ? 'Pas encore envoyé'
        : hasContactPage()
          ? 'Envoi manuel via la page Contact'
          : 'Aucun email ni page Contact',
    'delivery-status',
  );

  const sendButton = text(
    'button',
    isSent()
      ? prospect.emailAddress
        ? 'Mail envoyé'
        : 'Message envoyé'
      : prospect.emailAddress
        ? 'Envoyer le mail'
        : hasContactPage()
          ? 'Marquer envoyé'
          : 'Contact indisponible',
    'send-email-button',
  );
  sendButton.type = 'button';
  sendButton.disabled = isSent() || (!prospect.emailAddress && !prospect.contactPageUrl);

  const reactivateButton = text('button', 'Réactiver', 'reactivate-email-button');
  reactivateButton.type = 'button';
  reactivateButton.disabled = !isSent();

  function renderSendState() {
    const sent = isSent();
    sendButton.disabled = sent || (!prospect.emailAddress && !prospect.contactPageUrl);
    sendButton.textContent = sent
      ? prospect.emailAddress
        ? 'Mail envoyé'
        : 'Message envoyé'
      : prospect.emailAddress
        ? 'Envoyer le mail'
        : hasContactPage()
          ? 'Marquer envoyé'
          : 'Contact indisponible';
    reactivateButton.disabled = !sent;
    sentText.textContent = sent
      ? prospect.emailAddress
        ? `Accepté par le SMTP${prospect.messageSentAt ? ` · ${formatDate(prospect.messageSentAt)}` : ''}`
        : `Envoi manuel confirmé${prospect.messageSentAt ? ` · ${formatDate(prospect.messageSentAt)}` : ''}`
      : prospect.emailAddress
        ? 'Pas encore envoyé'
        : hasContactPage()
          ? 'Envoi manuel via la page Contact'
          : 'Aucun email ni page Contact';
  }

  if (prospect.emailAddress) {
    sendButton.addEventListener('click', async () => {
      sendButton.disabled = true;
      sendButton.textContent = 'Envoi…';
      try {
        const result = await sendProspectEmail(prospect);
        renderSendState();
        showNotice(`Mail accepté par Poste.io pour ${result.to}.`);
      } catch (error) {
        renderSendState();
        showNotice(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  } else if (prospect.contactPageUrl) {
    sendButton.addEventListener('click', async () => {
      sendButton.disabled = true;
      try {
        const result = await requestJson(
          `/api/prospects/${encodeURIComponent(prospect.redditId)}/message-status`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sent: true }),
          },
        );
        prospect.messageStatus = result.messageStatus;
        prospect.messageSentAt = result.messageSentAt;
        renderSendState();
        showNotice('Message envoyé via la page Contact et marqué comme tel.');
      } catch (error) {
        renderSendState();
        showNotice(error instanceof Error ? error.message : String(error), 'error');
      }
    });
  }

  reactivateButton.addEventListener('click', async () => {
    reactivateButton.disabled = true;
    try {
      const result = await requestJson(
        `/api/prospects/${encodeURIComponent(prospect.redditId)}/message-status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sent: false }),
        },
      );
      prospect.messageStatus = result.messageStatus;
      prospect.messageSentAt = result.messageSentAt;
      renderSendState();
      showNotice('Envoi réactivé pour ce prospect.');
    } catch (error) {
      renderSendState();
      showNotice(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  actions.append(sendButton, reactivateButton);
  cell.append(actions, sentText);
  renderSendState();

  const details = document.createElement('details');
  details.className = 'message-preparation';
  details.append(text('summary', 'Message prêt à copier'));
  let messageRendered = false;
  details.addEventListener('toggle', () => {
    if (!details.open || messageRendered) return;
    messageRendered = true;

    const recipient = document.createElement('div');
    recipient.className = 'copy-field';
    recipient.append(text('span', 'Destinataire'));
    if (prospect.emailAddress) {
      recipient.append(
        text('code', prospect.emailAddress),
        copyButton(prospect.emailAddress, 'E-mail'),
      );
    } else if (prospect.contactPageUrl) {
      const contactLink = document.createElement('a');
      contactLink.href = prospect.contactPageUrl;
      contactLink.target = '_blank';
      contactLink.rel = 'noreferrer';
      contactLink.textContent = 'Ouvrir la page Contact ↗';
      recipient.append(contactLink);
    } else {
      recipient.append(text('small', 'Aucun destinataire trouvé', 'muted'));
    }

    const subject = document.createElement('div');
    subject.className = 'copy-field';
    subject.append(
      text('span', 'Objet'),
      text('code', prospect.preparedMessage.subject),
      copyButton(prospect.preparedMessage.subject, 'Objet'),
    );

    const message = document.createElement('div');
    message.className = 'copy-field message-field';
    message.append(text('span', 'Message'));
    const messageText = document.createElement('textarea');
    messageText.readOnly = true;
    messageText.rows = 10;
    messageText.value = prospect.preparedMessage.body;
    message.append(messageText, copyButton(prospect.preparedMessage.body, 'Message'));

    details.append(recipient, subject, message);
  });
  cell.append(details);
  return cell;
}

async function loadProspects() {
  const parameters = new URLSearchParams({ limit: '500' });
  if (statusFilter.value) parameters.set('status', statusFilter.value);
  if (emailSearchFilter.value) {
    parameters.set('emailSearchStatus', emailSearchFilter.value);
  }
  if (searchInput.value.trim()) parameters.set('q', searchInput.value.trim());
  const prospects = await requestJson(`/api/prospects?${parameters}`);
  displayedProspects = prospects;
  const body = document.getElementById('prospects-body');
  const empty = document.getElementById('prospects-empty');
  body.replaceChildren();
  empty.hidden = prospects.length > 0;

  for (const prospect of prospects) {
    const row = document.createElement('tr');
    const sendCell = outreachCell(prospect);
    const gameNameCell = document.createElement('td');
    gameNameCell.append(
      text(
        'strong',
        prospect.gameTitle || 'Non trouvé',
        prospect.gameTitle ? undefined : 'muted',
      ),
    );

    const postTitleCell = document.createElement('td');
    postTitleCell.append(text('strong', prospect.title || prospect.redditId));
    postTitleCell.append(
      text('small', prospect.author ? `u/${prospect.author}` : prospect.redditId),
    );

    const statusCell = document.createElement('td');
    statusCell.append(statusChip(prospect.status));

    const importedCell = document.createElement('td');
    importedCell.append(text('span', formatDate(prospect.importedAt), 'date-cell'));

    const emailSearchCell = document.createElement('td');
    emailSearchCell.append(emailSearchChip(prospect.emailSearchStatus));

    const siteCell = document.createElement('td');
    if (prospect.candidateUrl) {
      const link = document.createElement('a');
      link.href = prospect.candidateUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = prospect.candidateHost;
      siteCell.append(link);
      if (prospect.candidateCount > 1) {
        siteCell.append(text('small', `+ ${prospect.candidateCount - 1} autre(s)`));
      }
    } else {
      siteCell.append(text('span', 'Aucun lien', 'muted'));
    }

    const emailCell = document.createElement('td');
    if (prospect.status === 'platform_only') {
      emailCell.append(text('span', 'Plateforme', 'muted'));
    } else if (prospect.emailPreview) {
      emailCell.append(text('span', prospect.emailPreview, 'email-preview'));
      if (prospect.emailCount > 1) {
        emailCell.append(text('small', `${prospect.emailCount} adresse(s)`));
      }
    } else if (prospect.contactPageUrl) {
      const contactLink = document.createElement('a');
      contactLink.href = prospect.contactPageUrl;
      contactLink.target = '_blank';
      contactLink.rel = 'noreferrer';
      contactLink.textContent = 'Page contact ↗';
      emailCell.append(contactLink);
    } else {
      emailCell.append(text('span', '0', 'mono muted'));
    }

    const sourceCell = document.createElement('td');
    const source = document.createElement('a');
    source.href = prospect.postUrl;
    source.target = '_blank';
    source.rel = 'noreferrer';
    source.textContent = 'Reddit ↗';
    sourceCell.append(source);

    row.append(
      sendCell,
      gameNameCell,
      postTitleCell,
      importedCell,
      statusCell,
      emailSearchCell,
      siteCell,
      emailCell,
      sourceCell,
    );
    body.append(row);
  }
}

function setAutoSendControls(running) {
  autoSendStartButton.disabled = running;
  autoSendStopButton.disabled = !running;
  autoSendDelayInput.disabled = running;
  autoSendLimitInput.disabled = running;
}

function stopAutoSend(message = 'Automatisation arrêtée.') {
  clearTimeout(autoSendTimer);
  autoSendTimer = undefined;
  autoSendRunning = false;
  autoSendQueue = [];
  setAutoSendControls(false);
  autoSendStatus.textContent = message;
}

async function runNextAutoSend() {
  if (!autoSendRunning) return;
  const prospect = autoSendQueue.shift();
  if (!prospect) {
    stopAutoSend(`Terminé : ${autoSendSentCount} mail(s) accepté(s) par Poste.io.`);
    return;
  }

  const total = autoSendSentCount + autoSendQueue.length + 1;
  autoSendStatus.textContent =
    `Envoi ${autoSendSentCount + 1}/${total} à ${prospect.emailAddress}…`;

  try {
    const result = await sendProspectEmail(prospect);
    autoSendSentCount += 1;
    showNotice(`Mail automatique accepté par Poste.io pour ${result.to}.`);
    await Promise.all([loadDashboard(), loadProspects()]);
    if (!autoSendRunning) {
      autoSendStatus.textContent =
        `Arrêté manuellement après ${autoSendSentCount} envoi(s).`;
      return;
    }
  } catch (error) {
    stopAutoSend(
      `Arrêt après ${autoSendSentCount} envoi(s) : ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    showNotice(autoSendStatus.textContent, 'error');
    return;
  }

  if (!autoSendQueue.length) {
    stopAutoSend(`Terminé : ${autoSendSentCount} mail(s) accepté(s) par Poste.io.`);
    return;
  }

  const delaySeconds = Number(autoSendDelayInput.value);
  autoSendStatus.textContent =
    `${autoSendSentCount} envoyé(s) · prochain dans ${delaySeconds} secondes`;
  autoSendTimer = setTimeout(runNextAutoSend, delaySeconds * 1000);
}

autoSendStartButton.addEventListener('click', () => {
  const delaySeconds = Number(autoSendDelayInput.value);
  const limit = Number(autoSendLimitInput.value);
  if (!Number.isInteger(delaySeconds) || delaySeconds < 30 || delaySeconds > 3600) {
    showNotice('Le délai doit être compris entre 30 et 3 600 secondes.', 'error');
    return;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    showNotice('Le maximum doit être compris entre 1 et 50 mails.', 'error');
    return;
  }

  autoSendQueue = displayedProspects
    .filter((prospect) => prospect.emailAddress && prospect.messageStatus !== 'sent')
    .slice(0, limit);
  if (!autoSendQueue.length) {
    showNotice('Aucun prospect visible avec un e-mail restant à contacter.', 'error');
    return;
  }

  autoSendSentCount = 0;
  autoSendRunning = true;
  setAutoSendControls(true);
  autoSendStatus.textContent =
    `${autoSendQueue.length} mail(s) en file · premier envoi immédiat`;
  runNextAutoSend();
});

autoSendStopButton.addEventListener('click', () => {
  stopAutoSend(`Arrêté manuellement après ${autoSendSentCount} envoi(s).`);
});

async function refresh() {
  await Promise.all([loadDashboard(), loadProspects()]);
}

async function importFile(file) {
  if (!file) return;
  dropZone.classList.add('loading');
  showNotice(`Import de ${file.name} en cours…`, 'pending');
  try {
    const content = await file.text();
    const result = await requestJson('/api/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: content,
    });
    showNotice(
      result.alreadyImported
        ? `${file.name} avait déjà été importé : aucun doublon créé.`
        : `${result.posts} prospects importés depuis ${file.name}.`,
    );
    await refresh();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    dropZone.classList.remove('loading');
    fileInput.value = '';
  }
}

fileInput.addEventListener('change', () => importFile(fileInput.files?.[0]));
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => importFile(event.dataTransfer?.files?.[0]));
statusFilter.addEventListener('change', loadProspects);
emailSearchFilter.addEventListener('change', loadProspects);
testEmailButton.addEventListener('click', async () => {
  testEmailButton.disabled = true;
  testEmailButton.textContent = 'Envoi du test…';
  showNotice('Envoi de l’e-mail test via le SMTP Poste.io…', 'pending');
  try {
    const result = await requestJson('/api/email/test', { method: 'POST' });
    showNotice(
      `Test accepté pour ${result.to} · ${result.gameTitle} · ${result.candidateUrl}`,
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    testEmailButton.disabled = false;
    testEmailButton.textContent = 'Envoyer l’e-mail test';
  }
});
purgeButton.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Supprimer tous les imports, prospects, analyses et e-mails ? Cette action est irréversible depuis l’IHM.',
  );
  if (!confirmed) return;
  purgeButton.disabled = true;
  try {
    const result = await requestJson('/api/database/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'PURGER' }),
    });
    showNotice(
      `Base purgée : ${result.deleted.prospects} prospect(s) et ${result.deleted.imports} import(s) supprimés.`,
    );
    await refresh();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    purgeButton.disabled = false;
  }
});
extractionButton.addEventListener('click', async () => {
  extractionButton.disabled = true;
  showNotice('Analyse des sites lancée en arrière-plan…', 'pending');
  try {
    await requestJson('/api/extraction/start', { method: 'POST' });
    await refresh();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'error');
    extractionButton.disabled = false;
  }
});
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProspects, 250);
});

refresh().catch((error) => showNotice(error.message, 'error'));
