// content/mail-2925.js — Content script for 2925 Mail (steps 4, 7)
// Injected dynamically on: 2925.com

const MAIL2925_PREFIX = '[MultiPage:mail-2925]';
const isTopFrame = window === window.top;

console.log(MAIL2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(MAIL2925_PREFIX, 'Skipping child frame');
} else {

const SEEN_MAIL_STORAGE_KEY = 'seen2925MailKeys';

let seenMailKeys = new Set();

async function loadSeenMailKeys() {
  try {
    const data = await chrome.storage.session.get(SEEN_MAIL_STORAGE_KEY);
    if (data[SEEN_MAIL_STORAGE_KEY] && Array.isArray(data[SEEN_MAIL_STORAGE_KEY])) {
      seenMailKeys = new Set(data[SEEN_MAIL_STORAGE_KEY]);
      console.log(MAIL2925_PREFIX, `Loaded ${seenMailKeys.size} previously seen mail keys`);
    }
  } catch (err) {
    console.warn(MAIL2925_PREFIX, 'Session storage unavailable, using in-memory seen mail keys:', err?.message || err);
  }
}

loadSeenMailKeys();

async function persistSeenMailKeys() {
  try {
    await chrome.storage.session.set({ [SEEN_MAIL_STORAGE_KEY]: [...seenMailKeys] });
  } catch (err) {
    console.warn(MAIL2925_PREFIX, 'Could not persist seen mail keys, continuing in-memory only:', err?.message || err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`步骤 ${message.step}：邮箱轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

const MAIL_ITEM_SELECTORS = [
  '.mail-item',
  '.letter-item',
  '[class*="mailItem"]',
  '[class*="mail-item"]',
  '[class*="MailItem"]',
  '.el-table__row',
  'tr[class*="mail"]',
  '[class*="listItem"]',
  '[class*="list-item"]',
  'li[class*="mail"]',
];

function findMailItems() {
  for (const selector of MAIL_ITEM_SELECTORS) {
    const items = document.querySelectorAll(selector);
    if (items.length > 0) {
      return Array.from(items);
    }
  }
  return [];
}

function getMailItemText(item) {
  if (!item) return '';
  const parts = [];
  const seen = new Set();
  const attributeNames = [
    'title',
    'aria-label',
    'placeholder',
    'data-subject',
    'data-preview',
    'data-title',
    'data-content',
    'data-snippet',
    'data-summary',
    'data-from',
    'data-sender',
    'data-to',
    'data-recipient',
    'data-email',
  ];
  const collectText = value => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };
  const collectElement = element => {
    if (!element) return;
    collectText(element.textContent);
    attributeNames.forEach(attributeName => {
      try {
        if (typeof element.getAttribute === 'function') {
          collectText(element.getAttribute(attributeName));
        }
      } catch {}
    });
    try {
      Object.entries(element.dataset || {}).forEach(([key, value]) => {
        if (/^(subject|preview|title|content|snippet|summary|from|sender|to|recipient|email)$/i.test(key)) {
          collectText(value);
        }
      });
    } catch {}
  };

  collectElement(item);

  const contentCell = item.querySelector?.('td.content, .content, .mail-content');
  const titleEl = item.querySelector?.('.mail-content-title');
  const textEl = item.querySelector?.('.mail-content-text');
  collectElement(titleEl);
  collectElement(textEl);
  collectElement(contentCell);

  let extraNodes = [];
  try {
    extraNodes = Array.from(
      item.querySelectorAll?.(
        '[title], [aria-label], [data-subject], [data-preview], [data-title], [data-content], [data-snippet], [data-summary], [data-from], [data-sender], [data-to], [data-recipient], [data-email]'
      ) || []
    );
  } catch {}
  extraNodes.forEach(collectElement);

  return parts.join(' ');
}

function getMailItemTimeText(item) {
  const timeEl = item?.querySelector('.date-time-text, [class*="date-time"], [class*="time"], td.time');
  return (timeEl?.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeMailIdentityPart(value) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getMailItemId(item, index = 0) {
  const candidates = [
    item?.getAttribute?.('data-id'),
    item?.dataset?.id,
    item?.getAttribute?.('data-mail-id'),
    item?.dataset?.mailId,
    item?.getAttribute?.('data-key'),
    item?.getAttribute?.('key'),
  ].filter(Boolean);

  if (candidates.length > 0) {
    return String(candidates[0]);
  }

  return [
    index,
    normalizeMailIdentityPart(getMailItemTimeText(item)),
    normalizeMailIdentityPart(getMailItemText(item)).slice(0, 240),
  ].join('|');
}

function getCurrentMailIds(items = []) {
  const ids = new Set();
  items.forEach((item, index) => {
    ids.add(getMailItemId(item, index));
  });
  return ids;
}

function buildSeenMailKey({ itemId, itemTimestamp, text, code }) {
  const normalizedItemId = itemId ? String(itemId).trim() : '';
  const normalizedTimestamp = Number.isFinite(itemTimestamp) && itemTimestamp > 0 ? itemTimestamp : 0;
  const normalizedText = normalizeMailIdentityPart(text).slice(0, 240);
  const normalizedCode = (code || '').trim();
  return `mail:${normalizedItemId || 'no-id'}:${normalizedTimestamp}:${normalizedCode}:${normalizedText}`;
}

function normalizeMinuteTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  return date.getTime();
}

function resolveMailTimeWindowState(itemTimestamp, filterAfterMinute) {
  const itemMinute = normalizeMinuteTimestamp(itemTimestamp || 0);
  if (!filterAfterMinute) {
    return {
      itemMinute,
      passesTimeFilter: true,
      shouldBypassOldSnapshot: false,
    };
  }

  // 2925 列表时间文本不稳定，无法解析时不能直接丢弃，否则 A4 较慢场景下
  // 邮件已经到达但仍会被归入“旧快照”永久跳过。
  if (!itemMinute) {
    return {
      itemMinute: 0,
      passesTimeFilter: true,
      shouldBypassOldSnapshot: true,
    };
  }

  const passesTimeFilter = itemMinute >= filterAfterMinute;
  return {
    itemMinute,
    passesTimeFilter,
    shouldBypassOldSnapshot: passesTimeFilter,
  };
}

function matchesMailFilters(text, senderFilters, subjectFilters) {
  const lower = (text || '').toLowerCase();
  const senderMatch = senderFilters.some(filter => lower.includes(filter.toLowerCase()));
  const subjectMatch = subjectFilters.some(filter => lower.includes(filter.toLowerCase()));
  return senderMatch || subjectMatch;
}

function looksLikeChatGptVerificationMail(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return false;
  return /chatgpt/.test(normalized) && /(?:验证码|代码|code)/.test(normalized);
}

function extractVerificationCode(text, strictChatGPTCodeOnly = false) {
  if (strictChatGPTCodeOnly) {
    const strictMatch = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
    return strictMatch ? strictMatch[1] : null;
  }

  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchChatGPT = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
  if (matchChatGPT) return matchChatGPT[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function extractEmails(text) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return [...new Set(matches.map(item => item.toLowerCase()))];
}

function emailMatchesTarget(candidate, targetEmail) {
  const normalizedCandidate = String(candidate || '').trim().toLowerCase();
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  return Boolean(normalizedCandidate && normalizedTarget && normalizedCandidate === normalizedTarget);
}

function getTargetEmailMatchState(text, targetEmail) {
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return { matches: true, hasExplicitEmail: false };
  }

  const normalizedText = String(text || '').toLowerCase();
  if (normalizedText.includes(normalizedTarget)) {
    return { matches: true, hasExplicitEmail: true };
  }

  const atIndex = normalizedTarget.indexOf('@');
  if (atIndex > 0) {
    const encodedTarget = `${normalizedTarget.slice(0, atIndex)}=${normalizedTarget.slice(atIndex + 1)}`;
    if (normalizedText.includes(encodedTarget)) {
      return { matches: true, hasExplicitEmail: true };
    }
  }

  const emails = extractEmails(text);
  if (!emails.length) {
    return { matches: false, hasExplicitEmail: false };
  }

  return {
    matches: emails.some(email => emailMatchesTarget(email, normalizedTarget)),
    hasExplicitEmail: true,
  };
}

function parseMailItemTimestamp(item) {
  const timeText = getMailItemTimeText(item);
  if (!timeText) return null;

  const now = new Date();
  const date = new Date(now);
  let match = null;

  if (/刚刚/.test(timeText)) {
    return now.getTime();
  }

  match = timeText.match(/(\d+)\s*分(?:钟)?前/);
  if (match) {
    return now.getTime() - Number(match[1]) * 60 * 1000;
  }

  match = timeText.match(/(\d+)\s*秒前/);
  if (match) {
    return now.getTime() - Number(match[1]) * 1000;
  }

  match = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date.getTime();
  }

  match = timeText.match(/今天\s*(\d{1,2}):(\d{2})/);
  if (match) {
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date.getTime();
  }

  match = timeText.match(/昨天\s*(\d{1,2}):(\d{2})/);
  if (match) {
    date.setDate(date.getDate() - 1);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date.getTime();
  }

  match = timeText.match(/(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (match) {
    date.setMonth(Number(match[1]) - 1, Number(match[2]));
    date.setHours(Number(match[3]), Number(match[4]), 0, 0);
    return date.getTime();
  }

  match = timeText.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0
    ).getTime();
  }

  return null;
}

async function sleepRandom(minMs, maxMs = minMs) {
  const duration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await sleep(duration);
}

async function waitForMailItems(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = findMailItems();
    if (items.length > 0) {
      return items;
    }
    await sleep(250);
  }
  return findMailItems();
}

async function ensureInboxListReady(step) {
  let items = findMailItems();
  if (items.length > 0) {
    return items;
  }

  if (!/#\/mailList(?:[/?#]|$)/i.test(location.href || '')) {
    log(`步骤 ${step}：当前停留在邮件详情页，正在回到收件箱列表...`, 'info');
    try {
      location.hash = '#/mailList';
    } catch {}
    await sleepRandom(900, 1400);
    items = await waitForMailItems(5000);
    if (items.length > 0) {
      return items;
    }
  }

  const inboxLink = document.querySelector(
    'a[href*="mailList"], [class*="inbox"], [class*="Inbox"], [title*="收件箱"]'
  );
  if (inboxLink) {
    simulateClick(inboxLink);
    await sleepRandom(700, 1200);
    items = await waitForMailItems(5000);
    if (items.length > 0) {
      return items;
    }
  }

  return findMailItems();
}

async function refreshInbox() {
  const refreshBtn = document.querySelector(
    '[class*="refresh"], [title*="刷新"], [aria-label*="刷新"], [class*="Refresh"]'
  );
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleepRandom(700, 1200);
    return;
  }

  const inboxLink = document.querySelector(
    'a[href*="mailList"], [class*="inbox"], [class*="Inbox"], [title*="收件箱"]'
  );
  if (inboxLink) {
    simulateClick(inboxLink);
    await sleepRandom(700, 1200);
  }
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    filterAfterTimestamp = 0,
    excludeCodes = [],
    strictChatGPTCodeOnly = false,
    targetEmail = '',
  } = payload;
  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));
  const filterAfterMinute = normalizeMinuteTimestamp(Number(filterAfterTimestamp) || 0);

  log(`步骤 ${step}：开始轮询 2925 邮箱（最多 ${maxAttempts} 次）`);
  if (filterAfterMinute) {
    log(`步骤 ${step}：仅尝试 ${new Date(filterAfterMinute).toLocaleString('zh-CN', { hour12: false })} 及之后时间的邮件。`);
  }

  let initialItems = await ensureInboxListReady(step);

  if (initialItems.length === 0) {
    await refreshInbox();
    await sleep(2000);
    initialItems = await ensureInboxListReady(step);
  }

  if (initialItems.length === 0) {
    throw new Error('2925 邮箱列表未加载完成，请确认当前已打开收件箱。');
  }

  const existingMailIds = getCurrentMailIds(initialItems);
  log(`步骤 ${step}：邮件列表已加载，共 ${initialItems.length} 封邮件`);
  log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 封旧邮件快照`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 2925 邮箱，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshInbox();
      await sleepRandom(900, 1500);
    }

    let items = await ensureInboxListReady(step);
    if (items.length > 0) {
      const useFallback = attempt > FALLBACK_AFTER;

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const itemId = getMailItemId(item, index);
        const itemTimestamp = parseMailItemTimestamp(item);
        const {
          passesTimeFilter,
          shouldBypassOldSnapshot,
        } = resolveMailTimeWindowState(itemTimestamp, filterAfterMinute);

        if (!passesTimeFilter) {
          continue;
        }

        if (!useFallback && !shouldBypassOldSnapshot && existingMailIds.has(itemId)) {
          continue;
        }

        const text = getMailItemText(item);
        const code = extractVerificationCode(text, strictChatGPTCodeOnly);
        const matchesKnownMailFilters = matchesMailFilters(text, senderFilters, subjectFilters);
        const matchesChatGptVerificationPreview = Boolean(code) && looksLikeChatGptVerificationMail(text);
        if (!matchesKnownMailFilters && !matchesChatGptVerificationPreview) {
          continue;
        }

        const previewTargetState = getTargetEmailMatchState(text, targetEmail);
        const previewMatchesTarget = previewTargetState.matches;
        const previewHasExplicitEmail = previewTargetState.hasExplicitEmail;
        if (targetEmail && previewHasExplicitEmail && !previewMatchesTarget) {
          continue;
        }

        const previewMailKey = code ? buildSeenMailKey({ itemId, itemTimestamp, text, code }) : '';
        const previewAllowsCode = !targetEmail || previewMatchesTarget || !previewHasExplicitEmail;
        if (code && previewAllowsCode) {
          if (excludedCodeSet.has(code)) {
            log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
            continue;
          }
          if (seenMailKeys.has(previewMailKey)) {
            log(`步骤 ${step}：跳过已处理过的邮件验证码：${code}`, 'info');
            continue;
          }
          seenMailKeys.add(previewMailKey);
          persistSeenMailKeys();
          const source = useFallback && existingMailIds.has(itemId) ? '回退匹配邮件' : '新邮件';
          const timeLabel = itemTimestamp ? `，时间：${new Date(itemTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
          log(`步骤 ${step}：已找到验证码：${code}（来源：${source}${timeLabel}）`, 'ok');
          await sleep(1000);
          return { ok: true, code, emailTimestamp: Date.now() };
        }

        simulateClick(item);
        await sleepRandom(1200, 2200);
        const openedText = document.body?.textContent || '';
        const openedTargetState = getTargetEmailMatchState(openedText, targetEmail);
        if (targetEmail && openedTargetState.hasExplicitEmail && !openedTargetState.matches) {
          items = await ensureInboxListReady(step);
          continue;
        }

        const bodyCode = extractVerificationCode(openedText, strictChatGPTCodeOnly);
        if (bodyCode) {
          const bodyMailKey = buildSeenMailKey({ itemId, itemTimestamp, text: openedText || text, code: bodyCode });
          if (excludedCodeSet.has(bodyCode)) {
            log(`步骤 ${step}：跳过排除的验证码：${bodyCode}`, 'info');
            items = await ensureInboxListReady(step);
            continue;
          }
          if (seenMailKeys.has(bodyMailKey)) {
            log(`步骤 ${step}：跳过已处理过的邮件验证码：${bodyCode}`, 'info');
            items = await ensureInboxListReady(step);
            continue;
          }
          seenMailKeys.add(bodyMailKey);
          persistSeenMailKeys();
          const source = useFallback && existingMailIds.has(itemId) ? '回退匹配邮件正文' : '新邮件正文';
          const timeLabel = itemTimestamp ? `，时间：${new Date(itemTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
          log(`步骤 ${step}：已在邮件正文中找到验证码：${bodyCode}（来源：${source}${timeLabel}）`, 'ok');
          await sleep(1000);
          return { ok: true, code: bodyCode, emailTimestamp: Date.now() };
        }

        items = await ensureInboxListReady(step);
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`步骤 ${step}：连续 ${FALLBACK_AFTER} 次未发现新邮件，开始回退到首封匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepRandom(intervalMs, intervalMs + 1200);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 2925 邮箱中找到新的匹配邮件。请手动检查收件箱。`
  );
}

}
