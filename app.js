const STORAGE_KEY = "bangla10-srs";
const STORAGE_VERSION = 1;
const INTERVAL_DAYS = { 1: 1, 2: 2, 3: 5, 4: 14, 5: 30 };
const MAX_QUICKFIRE_TIME = 8;
const PRAYER_CHUNK_STATUSES = ["new", "practicing", "memorised"];
const SERVER_SYNC_ENDPOINT = "/api/progress";
const SERVER_SYNC_DEBOUNCE_MS = 700;

const appEl = document.getElementById("app");
const clockEl = document.getElementById("clockLabel");

const appState = {
  data: {
    phrases: [],
    drills: [],
    categories: [],
    prayerRecitations: [],
    wuduSteps: [],
    commonIslamicPhrases: []
  },
  store: null,
  session: null,
  sync: {
    enabled: true,
    canWrite: false,
    bootstrapped: false,
    inFlight: false,
    queued: false,
    pendingWhileDisabled: false,
    pendingTimerId: null,
    revision: 0,
    lastSyncedAt: null,
    lastError: null
  },
  ui: {
    expandedPhraseId: null,
    phraseSearch: "",
    categorySearch: "",
    drillSteps: {},
    selectedQuickView: null,
    prayerExpandedChunkId: null,
    prayerShadow: null,
    prayerShadowTimerId: null,
    prayerFlow: null,
    prayerFlowAudio: null,
    prayerFlowAudioResolver: null,
    prayerTest: null
  }
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(dateValue) {
  const d = typeof dateValue === "string" ? new Date(`${dateValue}T09:00:00`) : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function formatShortDate(dateValue) {
  const d = typeof dateValue === "string" ? new Date(`${dateValue}T09:00:00`) : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T09:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffCalendarDays(a, b) {
  const one = new Date(`${a}T00:00:00`);
  const two = new Date(`${b}T00:00:00`);
  return Math.round((two - one) / 86400000);
}

function nowGreeting() {
  const h = new Date().getHours();
  if (h < 12) {
    return { bangla: "শুভ সকাল", phonetic: "shuvo shokal", english: "Good morning" };
  }
  if (h < 17) {
    return { bangla: "শুভ বিকেল", phonetic: "shuvo bikel", english: "Good afternoon" };
  }
  return { bangla: "শুভ সন্ধ্যা", phonetic: "shuvo shondha", english: "Good evening" };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffled(arr) {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function nowISO() {
  return new Date().toISOString();
}

function buildOptionSet(correct, primaryValues, fallbackValues = []) {
  const options = uniqueValues([...primaryValues, ...fallbackValues]).filter((value) => value !== correct);
  return shuffled([correct, ...options.slice(0, 3)]);
}

function createDefaultStore() {
  return {
    version: STORAGE_VERSION,
    meta: {
      revision: 0,
      lastModifiedAt: null,
      lastSyncedAt: null,
      dirty: false
    },
    phrases: {},
    stats: {
      totalSessions: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastSessionDate: null,
      totalMinutes: 0,
      phrasesLearned: 0,
      totalCorrect: 0,
      totalIncorrect: 0
    },
    sessions: {},
    settings: {
      dailyGoal: 10,
      newPhrasesPerSession: 3,
      maxReviewsPerSession: 12
    },
    prayer: {
      recitations: {},
      lastPracticeDate: null,
      totalPracticeSessions: 0
    }
  };
}

function normalizeStore(input = {}) {
  const fallback = createDefaultStore();
  const parsed = input && typeof input === "object" ? input : {};
  const parsedPrayer = parsed.prayer && typeof parsed.prayer === "object" ? parsed.prayer : {};
  const parsedMeta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};

  return {
    ...fallback,
    ...parsed,
    version: STORAGE_VERSION,
    meta: {
      ...fallback.meta,
      ...parsedMeta,
      revision: Number(parsedMeta.revision) || 0,
      dirty: !!parsedMeta.dirty
    },
    stats: {
      ...fallback.stats,
      ...(parsed.stats || {})
    },
    sessions: {
      ...(parsed.sessions || {})
    },
    settings: {
      ...fallback.settings,
      ...(parsed.settings || {})
    },
    phrases: {
      ...(parsed.phrases || {})
    },
    prayer: {
      ...fallback.prayer,
      ...parsedPrayer,
      recitations: {
        ...((parsedPrayer && parsedPrayer.recitations) || {})
      }
    }
  };
}

function loadStore() {
  const fallback = createDefaultStore();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    return normalizeStore(parsed);
  } catch {
    return fallback;
  }
}

function hasMeaningfulProgress(store) {
  if (!store) return false;
  if ((store.stats?.totalSessions || 0) > 0) return true;
  if ((store.stats?.phrasesLearned || 0) > 0) return true;
  if (Object.keys(store.phrases || {}).length > 0) return true;
  if (Object.keys(store.sessions || {}).length > 0) return true;
  if ((store.prayer?.totalPracticeSessions || 0) > 0) return true;
  if (Object.keys((store.prayer && store.prayer.recitations) || {}).length > 0) return true;
  return false;
}

function localStoreFreshness(store) {
  const fromMeta = Date.parse(store?.meta?.lastModifiedAt || "");
  if (Number.isFinite(fromMeta)) return fromMeta;
  const fromSession = Date.parse(store?.stats?.lastSessionDate ? `${store.stats.lastSessionDate}T23:59:59.000Z` : "");
  if (Number.isFinite(fromSession)) return fromSession;
  return 0;
}

function writeStoreToLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState.store));
}

function saveStore({ sync = true } = {}) {
  if (!appState.store) return;
  appState.store.meta = {
    ...(appState.store.meta || {}),
    revision: Number(appState.store.meta?.revision) || 0,
    lastSyncedAt: appState.store.meta?.lastSyncedAt || null,
    lastModifiedAt: nowISO(),
    dirty: true
  };
  writeStoreToLocal();
  if (sync) scheduleServerSync();
}

function scheduleServerSync({ immediate = false } = {}) {
  if (!appState.sync.enabled) return;
  if (!appState.sync.canWrite) {
    appState.sync.pendingWhileDisabled = true;
    return;
  }

  if (appState.sync.pendingTimerId) {
    clearTimeout(appState.sync.pendingTimerId);
    appState.sync.pendingTimerId = null;
  }

  if (immediate) {
    void performServerSync();
    return;
  }

  appState.sync.pendingTimerId = setTimeout(() => {
    appState.sync.pendingTimerId = null;
    void performServerSync();
  }, SERVER_SYNC_DEBOUNCE_MS);
}

async function performServerSync() {
  if (!appState.sync.enabled || !appState.sync.canWrite) return;
  if (!appState.store?.meta?.dirty) return;

  if (appState.sync.inFlight) {
    appState.sync.queued = true;
    return;
  }

  appState.sync.inFlight = true;
  appState.sync.lastError = null;

  const stateSnapshot = JSON.parse(JSON.stringify(appState.store));
  const snapshotLastModified = stateSnapshot?.meta?.lastModifiedAt || null;

  try {
    const response = await fetch(SERVER_SYNC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        state: stateSnapshot,
        clientRevision: Number(appState.sync.revision) || 0
      })
    });

    if (!response.ok) {
      throw new Error(`Sync failed (${response.status})`);
    }

    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(payload?.error || "Sync failed");
    }

    const nextRevision = Number(payload.revision) || Number(appState.sync.revision) || 0;
    const syncedAt = payload.updatedAt || nowISO();

    appState.sync.revision = nextRevision;
    appState.sync.lastSyncedAt = syncedAt;

    const hasNewerLocalChanges =
      (appState.store?.meta?.lastModifiedAt || null) !== snapshotLastModified;
    const currentLastModified = appState.store?.meta?.lastModifiedAt || snapshotLastModified || syncedAt;

    appState.store.meta = {
      ...(appState.store.meta || {}),
      revision: nextRevision,
      lastModifiedAt: currentLastModified,
      lastSyncedAt: syncedAt,
      dirty: hasNewerLocalChanges
    };

    writeStoreToLocal();
    if (hasNewerLocalChanges) {
      scheduleServerSync({ immediate: true });
    }
  } catch (error) {
    appState.sync.lastError = error instanceof Error ? error.message : "Sync failed";
    if (appState.store?.meta) {
      appState.store.meta.dirty = true;
      writeStoreToLocal();
    }
  } finally {
    appState.sync.inFlight = false;
    if (appState.sync.queued) {
      appState.sync.queued = false;
      scheduleServerSync({ immediate: true });
    }
  }
}

async function bootstrapServerSync() {
  if (!appState.sync.enabled) return;

  try {
    const response = await fetch(SERVER_SYNC_ENDPOINT, {
      method: "GET",
      cache: "no-store"
    });

    if (response.status === 404 || response.status === 503) {
      appState.sync.enabled = false;
      appState.sync.canWrite = false;
      appState.sync.bootstrapped = true;
      return;
    }

    if (!response.ok) {
      throw new Error(`Bootstrap failed (${response.status})`);
    }

    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(payload?.error || "Bootstrap failed");
    }

    const remoteRevision = Number(payload.revision) || 0;
    const remoteUpdatedAt = payload.updatedAt || null;
    const remoteState = payload.state ? normalizeStore(payload.state) : null;

    appState.sync.canWrite = true;
    appState.sync.bootstrapped = true;
    appState.sync.revision = remoteRevision;
    appState.sync.lastSyncedAt = remoteUpdatedAt;

    if (remoteState) {
      const localFreshness = localStoreFreshness(appState.store);
      const remoteFreshness =
        Date.parse(remoteUpdatedAt || "") || localStoreFreshness(remoteState);
      const localRevision = Number(appState.store?.meta?.revision) || 0;

      const shouldUseRemote =
        !appState.store?.meta?.dirty &&
        (remoteFreshness > localFreshness ||
          (remoteFreshness === localFreshness && remoteRevision > localRevision));

      if (shouldUseRemote) {
        appState.store = normalizeStore(remoteState);
        appState.store.meta = {
          ...(appState.store.meta || {}),
          revision: remoteRevision,
          lastModifiedAt: appState.store.meta?.lastModifiedAt || remoteUpdatedAt || nowISO(),
          lastSyncedAt: remoteUpdatedAt || nowISO(),
          dirty: false
        };
        writeStoreToLocal();
        renderRoute();
      } else {
        appState.store.meta = {
          ...(appState.store.meta || {}),
          revision: Math.max(localRevision, remoteRevision),
          lastSyncedAt: remoteUpdatedAt || appState.store.meta?.lastSyncedAt || null,
          dirty: !!appState.store.meta?.dirty
        };
        writeStoreToLocal();
        if (appState.store.meta.dirty) {
          scheduleServerSync({ immediate: true });
        }
      }
    } else if (hasMeaningfulProgress(appState.store)) {
      scheduleServerSync({ immediate: true });
    }

    if (appState.sync.pendingWhileDisabled) {
      appState.sync.pendingWhileDisabled = false;
      scheduleServerSync({ immediate: true });
    }
  } catch (error) {
    appState.sync.canWrite = true;
    appState.sync.bootstrapped = true;
    appState.sync.lastError = error instanceof Error ? error.message : "Bootstrap failed";
  }
}

function getPhraseById(id) {
  return appState.data.phrases.find((phrase) => phrase.id === id) || null;
}

function getDrillById(id) {
  return appState.data.drills.find((drill) => drill.id === id) || null;
}

function getPrayerRecitationById(id) {
  return appState.data.prayerRecitations.find((recitation) => recitation.id === id) || null;
}

function getPrayerAudioUrl(chunk) {
  if (!chunk) return "";
  const direct = chunk.audioUrl || chunk.audioFile || "";
  if (!direct) return "";
  if (direct.startsWith("http://") || direct.startsWith("https://")) return direct;
  if (direct.startsWith("./")) return direct;
  return `./${direct}`;
}

function ensurePrayerRecitationState(recitationId, chunkIds = []) {
  if (!appState.store.prayer) {
    appState.store.prayer = {
      recitations: {},
      lastPracticeDate: null,
      totalPracticeSessions: 0
    };
  }
  if (!appState.store.prayer.recitations[recitationId]) {
    appState.store.prayer.recitations[recitationId] = {
      chunks: {},
      fullRecitationStatus: "new",
      lastFullAttempt: null
    };
  }

  const recitationState = appState.store.prayer.recitations[recitationId];
  for (const chunkId of chunkIds) {
    if (!recitationState.chunks[chunkId]) {
      recitationState.chunks[chunkId] = {
        status: "new",
        lastPracticed: null
      };
    }
  }
  return recitationState;
}

function prayerRecitationProgress(recitation) {
  const chunkIds = recitation.chunks.map((chunk) => chunk.id);
  const state = ensurePrayerRecitationState(recitation.id, chunkIds);
  let memorised = 0;
  let practicing = 0;
  for (const chunkId of chunkIds) {
    const status = state.chunks[chunkId]?.status || "new";
    if (status === "memorised") memorised += 1;
    else if (status === "practicing") practicing += 1;
  }
  const total = chunkIds.length;
  const status = memorised === total ? "memorised" : memorised > 0 || practicing > 0 ? "practicing" : "new";
  return {
    status,
    total,
    memorised,
    practicing
  };
}

function overallPrayerProgress() {
  const rows = appState.data.prayerRecitations.map((recitation) => {
    return {
      recitation,
      progress: prayerRecitationProgress(recitation)
    };
  });
  const memorisedCount = rows.filter((row) => row.progress.status === "memorised").length;
  const practicingCount = rows.filter((row) => row.progress.status === "practicing").length;
  return {
    rows,
    memorisedCount,
    practicingCount,
    total: rows.length
  };
}

function nextPrayerStatus(current) {
  const index = PRAYER_CHUNK_STATUSES.indexOf(current);
  if (index < 0) return "new";
  return PRAYER_CHUNK_STATUSES[(index + 1) % PRAYER_CHUNK_STATUSES.length];
}

function ensurePhraseState(phraseId, persist = false) {
  if (!appState.store.phrases[phraseId]) {
    appState.store.phrases[phraseId] = {
      box: 1,
      lastReviewed: null,
      nextReview: null,
      timesCorrect: 0,
      timesIncorrect: 0,
      dateAdded: todayISO()
    };
    if (persist) saveStore();
  }
  return appState.store.phrases[phraseId];
}

function isDue(phraseState, today = todayISO()) {
  if (!phraseState) return false;
  if (!phraseState.nextReview) return true;
  return phraseState.nextReview <= today;
}

function countLearnedPhraseIds() {
  return Object.values(appState.store.phrases).filter((state) => state.timesCorrect > 0).length;
}

function categoryStats() {
  const byCategory = new Map();
  for (const category of appState.data.categories) {
    byCategory.set(category.id, {
      ...category,
      starterCount: 0,
      learnedCount: 0,
      masteryCount: 0
    });
  }

  for (const phrase of appState.data.phrases) {
    const item = byCategory.get(phrase.category);
    if (!item) continue;
    item.starterCount += 1;
    const state = appState.store.phrases[phrase.id];
    if (state?.timesCorrect > 0) item.learnedCount += 1;
    if (state?.box >= 5) item.masteryCount += 1;
  }

  return [...byCategory.values()].sort((a, b) => a.order - b.order);
}

function buildSessionPlan({ extraPractice = false } = {}) {
  const today = todayISO();
  const maxReviews = appState.store.settings.maxReviewsPerSession;
  const minInteractions = 8;
  const maxInteractions = 12;
  const newPerSession = appState.store.settings.newPhrasesPerSession;

  const allPhrases = appState.data.phrases;

  const knownPhrases = allPhrases.filter((phrase) => !!appState.store.phrases[phrase.id]);
  const learnedPhrases = knownPhrases.filter((phrase) => (appState.store.phrases[phrase.id]?.timesCorrect || 0) > 0);

  if (extraPractice) {
    const dueLearned = learnedPhrases
      .filter((phrase) => isDue(appState.store.phrases[phrase.id], today))
      .sort((a, b) => {
        const sa = appState.store.phrases[a.id];
        const sb = appState.store.phrases[b.id];
        if (sa.box !== sb.box) return sa.box - sb.box;
        return (sa.lastReviewed || "") < (sb.lastReviewed || "") ? -1 : 1;
      });

    const selected = dueLearned.slice(0, maxReviews);
    const usedIds = new Set(selected.map((phrase) => phrase.id));
    const fillerPool = learnedPhrases
      .filter((phrase) => !usedIds.has(phrase.id))
      .sort((a, b) => {
        const sa = appState.store.phrases[a.id];
        const sb = appState.store.phrases[b.id];
        return (sa.nextReview || "9999-12-31") < (sb.nextReview || "9999-12-31") ? -1 : 1;
      });

    const targetCount = Math.min(maxReviews, Math.max(minInteractions, selected.length));
    while (selected.length < targetCount && fillerPool.length) {
      selected.push(fillerPool.shift());
    }

    const items = selected.map((phrase) => ({ phraseId: phrase.id, type: "review" }));
    return {
      date: today,
      items,
      reviewCount: items.length,
      newCount: 0,
      estimatedMinutes: Math.max(8, Math.min(12, Math.round((items.length * 0.9 + 2) * 10) / 10))
    };
  }

  const dueReviews = knownPhrases
    .filter((phrase) => isDue(appState.store.phrases[phrase.id], today))
    .sort((a, b) => {
      const sa = appState.store.phrases[a.id];
      const sb = appState.store.phrases[b.id];
      if (sa.box !== sb.box) return sa.box - sb.box;
      return (sa.lastReviewed || "") < (sb.lastReviewed || "") ? -1 : 1;
    });

  const reviewSelection = dueReviews.slice(0, maxReviews);
  const newPool = allPhrases.filter((phrase) => !appState.store.phrases[phrase.id]);
  const targetInteractions = Math.min(maxInteractions, Math.max(minInteractions, reviewSelection.length + newPerSession));
  const newNeeded = Math.min(newPerSession, Math.max(0, targetInteractions - reviewSelection.length), newPool.length);
  const newSelection = newPool.slice(0, newNeeded);

  const extraPool = knownPhrases
    .filter((phrase) => !reviewSelection.find((selected) => selected.id === phrase.id))
    .sort((a, b) => {
      const sa = appState.store.phrases[a.id];
      const sb = appState.store.phrases[b.id];
      return (sa.nextReview || "9999-12-31") < (sb.nextReview || "9999-12-31") ? -1 : 1;
    });

  const fallback = [];
  while (reviewSelection.length + newSelection.length + fallback.length < minInteractions && extraPool.length) {
    fallback.push(extraPool.shift());
  }

  const reviewItems = reviewSelection.map((phrase) => ({ phraseId: phrase.id, type: "review" }));
  const newItems = newSelection.map((phrase) => ({ phraseId: phrase.id, type: "new" }));
  const fallbackItems = fallback.map((phrase) => ({ phraseId: phrase.id, type: "review" }));

  const interleaved = [];
  const reviewsQueue = [...reviewItems, ...fallbackItems];
  const newQueue = [...newItems];

  while (reviewsQueue.length || newQueue.length) {
    if (reviewsQueue.length) interleaved.push(reviewsQueue.shift());
    if (reviewsQueue.length) interleaved.push(reviewsQueue.shift());
    if (newQueue.length) interleaved.push(newQueue.shift());
  }

  const items = interleaved.slice(0, maxReviews);

  return {
    date: today,
    items,
    reviewCount: items.filter((item) => item.type === "review").length,
    newCount: items.filter((item) => item.type === "new").length,
    estimatedMinutes: Math.max(8, Math.min(12, Math.round((items.length * 0.9 + 2) * 10) / 10))
  };
}

function createTimer() {
  const now = Date.now();
  return {
    paused: false,
    accumulatedMs: 0,
    lastResumeAt: now
  };
}

function pauseTimer(timer) {
  if (!timer || timer.paused) return;
  timer.accumulatedMs += Date.now() - timer.lastResumeAt;
  timer.paused = true;
}

function resumeTimer(timer) {
  if (!timer || !timer.paused) return;
  timer.lastResumeAt = Date.now();
  timer.paused = false;
}

function timerElapsedMs(timer) {
  if (!timer) return 0;
  if (timer.paused) return timer.accumulatedMs;
  return timer.accumulatedMs + (Date.now() - timer.lastResumeAt);
}

function startSession(extraPractice = false) {
  clearQuickfireTimer();
  const plan = buildSessionPlan({ extraPractice });
  if (!plan.items.length) {
    if (extraPractice) {
      alert("No learned phrases yet for extra practice. Finish a daily round first.");
    } else {
      alert("No phrases available right now.");
    }
    window.location.hash = "#/";
    return;
  }

  for (const item of plan.items) {
    if (item.type === "new") ensurePhraseState(item.phraseId, false);
  }
  saveStore();

  const sessionItems = plan.items.map((item) => {
    const phraseState = appState.store.phrases[item.phraseId];
    let direction = "en-to-bn";
    if (extraPractice) {
      direction = Math.random() < 0.5 ? "bn-to-en" : "en-to-bn";
    } else if (item.type === "review" && (phraseState?.box || 1) >= 3 && Math.random() < 0.4) {
      direction = "bn-to-en";
    }
    return { ...item, direction };
  });

  const categoryFrequency = new Map();
  for (const item of sessionItems) {
    const phrase = getPhraseById(item.phraseId);
    if (!phrase) continue;
    categoryFrequency.set(phrase.category, (categoryFrequency.get(phrase.category) || 0) + 1);
  }
  const primaryCategory = [...categoryFrequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "greetings";

  const matchingDrills = appState.data.drills.filter((drill) => drill.category === primaryCategory);
  const fallbackDrill = appState.data.drills[0] || null;
  const selectedDrill = pick(matchingDrills.length ? matchingDrills : [fallbackDrill].filter(Boolean));

  const learnedIds = Object.entries(appState.store.phrases)
    .filter(([, state]) => (state?.timesCorrect || 0) > 0)
    .map(([id]) => id);
  const questionIds = [...new Set(sessionItems.map((item) => item.phraseId))];
  let pool = extraPractice
    ? [...learnedIds]
    : [...questionIds, ...learnedIds.filter((id) => !questionIds.includes(id))];
  if (!pool.length) {
    pool = [...questionIds];
  }

  const learnedPhrases = learnedIds.map((id) => getPhraseById(id)).filter(Boolean);

  const questions = [];
  for (const phraseId of shuffled(pool).slice(0, 8)) {
    const phrase = getPhraseById(phraseId);
    if (!phrase) continue;
    const phraseState = appState.store.phrases[phrase.id];
    const reverseChance = extraPractice ? 0.55 : (phraseState?.box || 1) >= 3 ? 0.35 : 0.15;
    const isBanglaToEnglish = Math.random() < reverseChance;

    if (isBanglaToEnglish) {
      const primaryEnglish = (extraPractice ? learnedPhrases : appState.data.phrases)
        .filter((candidate) => candidate.id !== phrase.id)
        .map((candidate) => candidate.english);
      const fallbackEnglish = appState.data.phrases
        .filter((candidate) => candidate.id !== phrase.id)
        .map((candidate) => candidate.english);
      questions.push({
        phraseId: phrase.id,
        direction: "bn-to-en",
        instruction: "Translate into English",
        prompt: phrase.bangla,
        promptSecondary: phrase.phonetic,
        correct: phrase.english,
        options: buildOptionSet(phrase.english, primaryEnglish, fallbackEnglish)
      });
      continue;
    }

    questions.push({
      phraseId: phrase.id,
      direction: "en-to-bn",
      instruction: "Translate into phonetic Bangla",
      prompt: phrase.english,
      promptSecondary: "",
      correct: phrase.phonetic,
      options: buildOptionSet(
        phrase.phonetic,
        (extraPractice ? learnedPhrases : appState.data.phrases)
          .filter((candidate) => candidate.id !== phrase.id)
          .map((candidate) => candidate.phonetic),
        appState.data.phrases
          .filter((candidate) => candidate.id !== phrase.id)
          .map((candidate) => candidate.phonetic)
      )
    });
  }

  appState.session = {
    plan: {
      ...plan,
      items: sessionItems
    },
    phase: "cards",
    cardIndex: 0,
    cardFlipped: false,
    ratings: [],
    drillId: selectedDrill?.id || null,
    drillStep: 0,
    quickfire: {
      questions,
      index: 0,
      selected: null,
      locked: false,
      remaining: MAX_QUICKFIRE_TIME,
      timerId: null,
      correct: 0,
      incorrect: 0
    },
    timer: createTimer(),
    isExtraPractice: extraPractice,
    completeStats: null
  };

  const wasOnSession = getRoute().page === "session";
  window.location.hash = "#/session";
  if (wasOnSession) {
    renderRoute();
  }
}

function clearQuickfireTimer() {
  if (!appState.session?.quickfire?.timerId) return;
  clearInterval(appState.session.quickfire.timerId);
  appState.session.quickfire.timerId = null;
}

function updateQuickfireTimerUi() {
  const remainingEl = document.getElementById("quickfireRemaining");
  const fillEl = document.getElementById("quickfireFill");
  if (!remainingEl || !fillEl || !appState.session) return;
  remainingEl.textContent = `${appState.session.quickfire.remaining}s`;
  fillEl.style.width = `${(appState.session.quickfire.remaining / MAX_QUICKFIRE_TIME) * 100}%`;
}

function moveToNextQuickfireQuestion() {
  if (!appState.session) return;
  appState.session.quickfire.index += 1;
  appState.session.quickfire.selected = null;
  appState.session.quickfire.locked = false;

  if (appState.session.quickfire.index >= appState.session.quickfire.questions.length) {
    appState.session.phase = "complete";
    finalizeSession();
    renderRoute();
    return;
  }

  appState.session.quickfire.remaining = MAX_QUICKFIRE_TIME;
  renderRoute();
  startQuickfireTimer();
}

function startQuickfireTimer() {
  if (!appState.session || appState.session.phase !== "quickfire") return;
  clearQuickfireTimer();
  appState.session.quickfire.remaining = MAX_QUICKFIRE_TIME;
  updateQuickfireTimerUi();

  appState.session.quickfire.timerId = setInterval(() => {
    if (!appState.session || appState.session.phase !== "quickfire") {
      clearQuickfireTimer();
      return;
    }

    if (document.hidden) return;

    appState.session.quickfire.remaining -= 1;
    updateQuickfireTimerUi();

    if (appState.session.quickfire.remaining <= 0) {
      clearQuickfireTimer();
      appState.session.quickfire.locked = true;
      appState.session.quickfire.selected = null;
      appState.session.quickfire.incorrect += 1;
      setTimeout(() => moveToNextQuickfireQuestion(), 550);
    }
  }, 1000);
}

function answerQuickfire(index) {
  if (!appState.session || appState.session.phase !== "quickfire") return;
  if (appState.session.quickfire.locked) return;

  const question = appState.session.quickfire.questions[appState.session.quickfire.index];
  if (!question) return;

  clearQuickfireTimer();
  appState.session.quickfire.locked = true;
  appState.session.quickfire.selected = index;

  if (question.options[index] === question.correct) {
    appState.session.quickfire.correct += 1;
  } else {
    appState.session.quickfire.incorrect += 1;
  }

  renderRoute();
  setTimeout(() => moveToNextQuickfireQuestion(), 650);
}

function applyRating(phraseId, rating) {
  const phraseState = ensurePhraseState(phraseId);
  const today = todayISO();

  let nextBox = phraseState.box;
  let interval = INTERVAL_DAYS[phraseState.box] || 1;

  if (rating === "again") {
    nextBox = 1;
    interval = INTERVAL_DAYS[1];
    phraseState.timesIncorrect += 1;
    appState.store.stats.totalIncorrect += 1;
  } else if (rating === "hard") {
    nextBox = phraseState.box;
    interval = Math.max(1, Math.floor((INTERVAL_DAYS[nextBox] || 1) / 2));
    phraseState.timesIncorrect += 1;
    appState.store.stats.totalIncorrect += 1;
  } else if (rating === "good") {
    nextBox = Math.min(5, phraseState.box + 1);
    interval = INTERVAL_DAYS[nextBox] || INTERVAL_DAYS[5];
    phraseState.timesCorrect += 1;
    appState.store.stats.totalCorrect += 1;
  } else if (rating === "easy") {
    nextBox = Math.min(5, phraseState.box + 2);
    interval = INTERVAL_DAYS[nextBox] || INTERVAL_DAYS[5];
    phraseState.timesCorrect += 1;
    appState.store.stats.totalCorrect += 1;
  }

  phraseState.box = nextBox;
  phraseState.lastReviewed = today;
  phraseState.nextReview = addDays(today, interval);

  appState.session.ratings.push({
    phraseId,
    rating,
    success: rating === "good" || rating === "easy"
  });

  appState.store.stats.phrasesLearned = countLearnedPhraseIds();
  saveStore();
}

function finalizeSession() {
  if (!appState.session || appState.session.completeStats) return;

  clearQuickfireTimer();
  pauseTimer(appState.session.timer);

  const today = todayISO();
  const elapsedSec = Math.max(1, Math.round(timerElapsedMs(appState.session.timer) / 1000));
  const elapsedMin = Math.max(1, Math.round(elapsedSec / 60));
  const reviewed = appState.session.plan.items.length;
  const newLearned = appState.session.plan.newCount;
  const ratingSuccessCount = appState.session.ratings.filter((r) => r.success).length;
  const ratingTotalCount = appState.session.ratings.length;
  const quickCorrect = appState.session.quickfire.correct;
  const quickTotal = appState.session.quickfire.questions.length;

  const accuracy = ratingTotalCount ? Math.round((ratingSuccessCount / ratingTotalCount) * 100) : 0;

  const alreadyCompletedToday = !!appState.store.sessions[today]?.completed;

  if (!alreadyCompletedToday && !appState.session.isExtraPractice) {
    const previousDate = appState.store.stats.lastSessionDate;

    appState.store.stats.totalSessions += 1;
    appState.store.stats.totalMinutes += elapsedMin;
    appState.store.stats.lastSessionDate = today;

    if (!previousDate) {
      appState.store.stats.currentStreak = 1;
    } else {
      const daysGap = diffCalendarDays(previousDate, today);
      if (daysGap === 0) {
        appState.store.stats.currentStreak = Math.max(1, appState.store.stats.currentStreak);
      } else if (daysGap === 1) {
        appState.store.stats.currentStreak += 1;
      } else {
        appState.store.stats.currentStreak = 1;
      }
    }

    appState.store.stats.longestStreak = Math.max(appState.store.stats.longestStreak, appState.store.stats.currentStreak);
  }

  const previousSession = appState.store.sessions[today] || {};
  appState.store.sessions[today] = {
    ...previousSession,
    completed: true,
    completedAt: new Date().toISOString(),
    elapsedSec: (previousSession.elapsedSec || 0) + elapsedSec,
    reviewed: reviewed,
    newLearned,
    accuracy,
    quickfireScore: quickTotal ? Math.round((quickCorrect / quickTotal) * 100) : 0,
    quickfireCorrect: quickCorrect,
    quickfireTotal: quickTotal,
    extraPracticeCount: (previousSession.extraPracticeCount || 0) + (appState.session.isExtraPractice ? 1 : 0)
  };

  appState.store.stats.phrasesLearned = countLearnedPhraseIds();
  saveStore();

  appState.session.completeStats = {
    elapsedMin,
    reviewed,
    newLearned,
    accuracy,
    quickCorrect,
    quickTotal
  };
}

function getWeeklyTracker() {
  const today = new Date();
  const day = today.getDay();
  const mondayShift = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayShift);

  const labels = ["M", "T", "W", "T", "F", "S", "S"];

  return labels.map((label, idx) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + idx);
    const iso = d.toISOString().slice(0, 10);
    const session = appState.store.sessions[iso];
    return {
      label,
      date: iso,
      done: !!session?.completed,
      minutes: session ? Math.round((session.elapsedSec || 0) / 60) : 0
    };
  });
}

function getRoute() {
  const hash = window.location.hash || "#/";
  const cleaned = hash.replace(/^#/, "") || "/";
  const parts = cleaned.split("/").filter(Boolean);

  if (!parts.length) return { page: "home" };

  if (parts[0] === "session") return { page: "session" };
  if (parts[0] === "progress") return { page: "progress" };

  if (parts[0] === "phrases") {
    if (parts[1]) return { page: "phrases-category", categoryId: parts[1] };
    return { page: "phrases" };
  }

  if (parts[0] === "drills") {
    if (parts[1]) return { page: "drill-detail", drillId: parts[1] };
    return { page: "drills" };
  }

  if (parts[0] === "salah") {
    if (parts[1] === "learn" && parts[2]) return { page: "salah-learn", recitationId: parts[2] };
    if (parts[1] === "map") return { page: "salah-map" };
    if (parts[1] === "wudu") return { page: "salah-wudu" };
    if (parts[1] === "phrases") return { page: "salah-phrases" };
    return { page: "salah-home" };
  }

  return { page: "home" };
}

function setActiveNav(routePage) {
  const navItems = [...document.querySelectorAll(".nav-item")];
  const navPage =
    routePage === "home" || routePage === "session"
      ? "#/"
      : routePage.startsWith("phrases")
        ? "#/phrases"
        : routePage.startsWith("drill") || routePage === "drills"
          ? "#/drills"
          : routePage.startsWith("salah")
            ? "#/salah"
            : "#/progress";

  navItems.forEach((item) => {
    const active = item.dataset.route === navPage;
    item.classList.toggle("is-active", active);
  });
}

function playAudioForPhrase(phrase) {
  if (!phrase) return;

  if (phrase.audio) {
    const audio = new Audio(phrase.audio);
    audio.play().catch(() => {
      // fallback below
    });
    return;
  }

  if ("speechSynthesis" in window) {
    const utterance = new SpeechSynthesisUtterance(phrase.bangla);
    utterance.lang = "bn-BD";
    utterance.rate = 0.82;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }
}

function milestoneInfo(learned) {
  const milestones = [10, 25, 50, 100, 200, 500];
  const next = milestones.find((value) => value > learned) || milestones[milestones.length - 1];
  return {
    next,
    remaining: Math.max(0, next - learned)
  };
}

function renderHome() {
  const greeting = nowGreeting();
  const tracker = getWeeklyTracker();
  const today = todayISO();
  const completed = !!appState.store.sessions[today]?.completed;
  const categoryRows = categoryStats();

  const planPreview = buildSessionPlan({ extraPractice: completed });

  const totalLearned = appState.store.stats.phrasesLearned;

  appEl.innerHTML = `
    <section class="fade-in">
      <header class="page-intro">
        <p class="page-kicker">${escapeHtml(formatDisplayDate(today))}</p>
        <h1 class="page-title">${escapeHtml(greeting.phonetic)}</h1>
        <p class="page-subtitle">${escapeHtml(greeting.english)} · ${escapeHtml(greeting.bangla)}</p>
      </header>

      <article class="surface streak-card stack">
        <div class="row-between">
          <div>
            <p class="metric-value" style="color: var(--green);">${appState.store.stats.currentStreak} days</p>
            <p class="metric-label">current streak</p>
          </div>
          <span class="chip green">${totalLearned} phrases learned</span>
        </div>

        <div class="week-grid">
          ${tracker
            .map(
              (day) => `
              <div class="week-cell">
                <div class="week-dot ${day.done ? "is-done" : ""}">${day.done ? "✓" : ""}</div>
                <div class="week-label ${day.done ? "is-done" : ""}">${day.label}</div>
              </div>
            `
            )
            .join("")}
        </div>
      </article>

      <button class="btn cta-session" id="startSessionBtn" type="button" style="margin-top: 14px; width: 100%;">
        <span class="watermark">১০</span>
        <p class="page-kicker" style="color: rgba(245, 242, 237, 0.68); margin-bottom: 8px;">Today's session</p>
        <p style="margin: 0; font-family: 'Newsreader', serif; font-size: 24px; font-style: italic;">${completed ? "Session complete ✓" : `${planPreview.reviewCount} reviews · ${planPreview.newCount} new`}</p>
        <p style="margin: 6px 0 0; font-size: 12px; color: rgba(245, 242, 237, 0.72);">~${planPreview.estimatedMinutes} minutes · ${completed ? "Tap for extra practice" : "Daily spaced repetition"}</p>
      </button>

      <section class="surface stack category-list" style="margin-top: 14px;">
        <div class="row-between">
          <p class="page-kicker" style="margin: 0;">Category progress</p>
          <a href="#/phrases" class="chip soft">Browse all</a>
        </div>

        ${categoryRows
          .slice(0, 6)
          .map((category) => {
            const percent = category.starterCount ? Math.round((category.learnedCount / category.starterCount) * 100) : 0;
            return `
              <a class="category-row" href="#/phrases/${escapeHtml(category.id)}">
                <div class="category-top">
                  <div>
                    <p class="category-title">${escapeHtml(category.emoji)} ${escapeHtml(category.label)}</p>
                    <p class="category-meta">${category.learnedCount} of ${category.starterCount || category.totalTarget} starter phrases learned</p>
                  </div>
                  <span class="mono" style="font-size: 12px; color: var(--text-muted);">${percent}%</span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" style="width: ${percent}%;"></div>
                </div>
              </a>
            `;
          })
          .join("")}
      </section>
    </section>
  `;

  document.getElementById("startSessionBtn")?.addEventListener("click", () => {
    startSession(completed);
  });
}

function currentSessionPhrase() {
  if (!appState.session) return null;
  const item = appState.session.plan.items[appState.session.cardIndex];
  if (!item) return null;
  return getPhraseById(item.phraseId);
}

function renderSessionCards() {
  const phrase = currentSessionPhrase();
  if (!phrase) {
    appState.session.phase = "drill";
    renderRoute();
    return;
  }

  const item = appState.session.plan.items[appState.session.cardIndex];
  const isBanglaToEnglish = item.direction === "bn-to-en";
  const progress = appState.session.plan.items.length
    ? Math.round(((appState.session.cardIndex + 1) / appState.session.plan.items.length) * 100)
    : 0;

  appEl.innerHTML = `
    <section class="fade-in stack">
      <div class="row-between">
        <div>
          <p class="page-kicker" style="margin: 0;">Flashcard review</p>
        </div>
        <span class="mono" style="font-size: 12px; color: var(--text-muted);">${appState.session.cardIndex + 1}/${appState.session.plan.items.length}</span>
      </div>

      <div class="progress-track" style="height: 5px; margin-top: -2px;">
        <div class="progress-fill" style="width: ${progress}%;"></div>
      </div>

      <article class="card-shell ${appState.session.cardFlipped ? "is-flipped" : ""}" id="flashCard">
        <div>
          <p class="card-category">${escapeHtml(item.type)} · ${escapeHtml(phrase.category)} · ${isBanglaToEnglish ? "Bangla → English" : "English → Bangla"}</p>
          ${
            appState.session.cardFlipped
              ? `
                ${
                  isBanglaToEnglish
                    ? `
                      <p class="card-main">${escapeHtml(phrase.english)}</p>
                      <p class="card-helper">${escapeHtml(phrase.bangla)} · ${escapeHtml(phrase.phonetic)}</p>
                    `
                    : `
                      <p class="card-main" style="font-style: normal; font-size: 38px;">${escapeHtml(phrase.bangla)}</p>
                      <p class="card-phonetic">${escapeHtml(phrase.phonetic)}</p>
                      <p class="card-helper">${escapeHtml(phrase.english)}</p>
                    `
                }
                <button id="audioBtn" class="btn btn-ghost" style="margin-top: 12px; color: rgba(255,255,255,0.76); border-color: rgba(255,255,255,0.24);">Play audio</button>
              `
              : `
                ${
                  isBanglaToEnglish
                    ? `
                      <p class="card-main" style="font-style: normal; font-size: 38px;">${escapeHtml(phrase.bangla)}</p>
                      <p class="card-phonetic">${escapeHtml(phrase.phonetic)}</p>
                      <p class="card-helper">say the English meaning, then tap to reveal</p>
                    `
                    : `
                      <p class="card-main">${escapeHtml(phrase.english)}</p>
                      <p class="card-helper">say it in Bangla, then tap to reveal</p>
                    `
                }
              `
          }
        </div>
      </article>

      ${
        appState.session.cardFlipped
          ? `
            <div class="rating-grid">
              <button class="btn btn-danger" data-rating="again" type="button">Again</button>
              <button class="btn btn-ghost" data-rating="hard" type="button">Hard</button>
              <button class="btn btn-soft" data-rating="good" type="button">Good</button>
              <button class="btn btn-secondary" data-rating="easy" type="button">Easy</button>
            </div>
          `
          : ""
      }

      <aside class="tip-box">
        <p class="tip-title">Cultural note</p>
        <p class="tip-text">${escapeHtml(phrase.notes || phrase.context || "Use respectful apni form with elders and in-laws.")}</p>
      </aside>

      <div class="row-between" style="margin-top: 4px;">
        <button id="exitSessionBtn" type="button" class="btn btn-ghost">Back</button>
        <span class="mono" style="font-size: 12px; color: var(--text-muted);">${progress}% complete</span>
      </div>
    </section>
  `;

  document.getElementById("flashCard")?.addEventListener("click", () => {
    appState.session.cardFlipped = !appState.session.cardFlipped;
    renderRoute();
  });

  document.querySelectorAll("[data-rating]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const rating = event.currentTarget.dataset.rating;
      applyRating(phrase.id, rating);
      appState.session.cardFlipped = false;
      appState.session.cardIndex += 1;
      if (appState.session.cardIndex >= appState.session.plan.items.length) {
        appState.session.phase = "drill";
        appState.session.drillStep = 0;
      }
      renderRoute();
    });
  });

  document.getElementById("audioBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    playAudioForPhrase(phrase);
  });

  document.getElementById("exitSessionBtn")?.addEventListener("click", () => {
    window.location.hash = "#/";
  });
}

function renderSessionDrill() {
  const drill = getDrillById(appState.session.drillId) || appState.data.drills[0];
  if (!drill) {
    appState.session.phase = "quickfire";
    renderRoute();
    return;
  }

  const step = appState.session.drillStep;
  const visibleLines = drill.lines.slice(0, step + 1);
  const isDone = step >= drill.lines.length - 1;

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Conversation drill</p>
        <h1 class="page-title" style="font-size: 28px;">${escapeHtml(drill.title)}</h1>
        <p class="page-subtitle">${escapeHtml(drill.description)}</p>
      </header>

      <article class="surface stack conversation">
        ${visibleLines
          .map((line) => {
            const isYou = line.speaker === "you";
            return `
              <div class="bubble-wrap ${isYou ? "you" : "them"}">
                <div class="speaker-label">${escapeHtml(line.speakerLabel || (isYou ? "You" : "They"))}</div>
                <div class="bubble">
                  <p class="bubble-bangla">${escapeHtml(line.bangla)}</p>
                  <p class="bubble-phonetic">${escapeHtml(line.phonetic)}</p>
                  <p class="bubble-english">${escapeHtml(line.english)}</p>
                </div>
              </div>
            `;
          })
          .join("")}
      </article>

      <aside class="tip-box">
        <p class="tip-title">Cultural note</p>
        <p class="tip-text">${escapeHtml(drill.culturalNote || "Keep tone warm and respectful.")}</p>
      </aside>

      <div class="row-between">
        <button id="drillBackBtn" type="button" class="btn btn-ghost">Back</button>
        <button id="drillNextBtn" type="button" class="btn btn-primary">${isDone ? "Continue to quick fire" : "Next line"}</button>
      </div>
    </section>
  `;

  document.getElementById("drillBackBtn")?.addEventListener("click", () => {
    appState.session.phase = "cards";
    appState.session.cardIndex = Math.max(0, appState.session.plan.items.length - 1);
    appState.session.cardFlipped = true;
    renderRoute();
  });

  document.getElementById("drillNextBtn")?.addEventListener("click", () => {
    if (isDone) {
      appState.session.phase = "quickfire";
      appState.session.quickfire.index = 0;
      appState.session.quickfire.selected = null;
      appState.session.quickfire.locked = false;
      appState.session.quickfire.remaining = MAX_QUICKFIRE_TIME;
      renderRoute();
      startQuickfireTimer();
      return;
    }

    appState.session.drillStep += 1;
    renderRoute();
  });
}

function renderSessionQuickfire() {
  const quick = appState.session.quickfire;
  const question = quick.questions[quick.index];

  if (!question) {
    appState.session.phase = "complete";
    finalizeSession();
    renderRoute();
    return;
  }

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="row-between">
        <div>
          <p class="page-kicker" style="margin: 0;">Quick fire</p>
        </div>
        <span class="mono" style="font-size: 12px; color: var(--text-muted);">${quick.index + 1}/${quick.questions.length}</span>
      </header>

      <article class="quickfire-shell stack">
        <div class="row-between">
          <span class="chip soft">Streak test</span>
          <span class="mono" id="quickfireRemaining">${quick.remaining}s</span>
        </div>
        <div class="timer-track">
          <div class="timer-fill" id="quickfireFill" style="width: ${(quick.remaining / MAX_QUICKFIRE_TIME) * 100}%;"></div>
        </div>

        <p class="page-kicker" style="margin-bottom: 0;">${escapeHtml(question.instruction || "Translate")}</p>
        <p class="card-main" style="font-size: 27px;">${escapeHtml(question.prompt)}</p>
        ${
          question.promptSecondary
            ? `<p class="page-subtitle" style="margin-top: 2px;">${escapeHtml(question.promptSecondary)}</p>`
            : ""
        }

        <div class="options-grid">
          ${question.options
            .map((option, index) => {
              const isSelected = quick.selected === index;
              const isCorrect = option === question.correct;
              let className = "option-btn";
              if (quick.locked && isCorrect) className += " is-correct";
              if (quick.locked && isSelected && !isCorrect) className += " is-wrong";

              return `<button type="button" class="${className}" data-option="${index}">${escapeHtml(option)}</button>`;
            })
            .join("")}
        </div>

        <div class="row-between">
          <span class="mono" style="font-size: 12px; color: var(--text-muted);">Score: ${quick.correct}/${quick.questions.length}</span>
          <span class="mono" style="font-size: 12px; color: var(--text-muted);">Wrong: ${quick.incorrect}</span>
        </div>
      </article>
    </section>
  `;

  document.querySelectorAll("[data-option]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const idx = Number(event.currentTarget.dataset.option);
      answerQuickfire(idx);
    });
  });

  updateQuickfireTimerUi();
}

function renderSessionComplete() {
  const stats = appState.session.completeStats;
  if (!stats) {
    finalizeSession();
  }

  const summary = appState.session.completeStats;

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro" style="margin-bottom: 6px; text-align: center;">
        <p class="page-kicker">Session complete</p>
        <h1 class="page-title" style="font-size: 30px;">khub bhalo</h1>
        <p class="page-subtitle">Great consistency beats intensity. See you tomorrow.</p>
      </header>

      <article class="surface stack" style="text-align: center;">
        <div class="kpi-grid">
          <div class="kpi-card">
            <p class="value">${summary.reviewed}</p>
            <p class="label">Reviewed</p>
          </div>
          <div class="kpi-card">
            <p class="value">${summary.newLearned}</p>
            <p class="label">New</p>
          </div>
          <div class="kpi-card">
            <p class="value">${summary.accuracy}%</p>
            <p class="label">Accuracy</p>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card">
            <p class="value">${summary.quickCorrect}/${summary.quickTotal}</p>
            <p class="label">Quick fire</p>
          </div>
          <div class="kpi-card">
            <p class="value">${summary.elapsedMin}m</p>
            <p class="label">Session time</p>
          </div>
          <div class="kpi-card">
            <p class="value">${appState.store.stats.currentStreak}</p>
            <p class="label">Streak</p>
          </div>
        </div>
      </article>

      <div class="row-between">
        <button id="sessionAgainBtn" class="btn btn-soft" type="button">Extra practice</button>
        <button id="sessionHomeBtn" class="btn btn-primary" type="button">Back home</button>
      </div>
    </section>
  `;

  document.getElementById("sessionHomeBtn")?.addEventListener("click", () => {
    appState.session = null;
    window.location.hash = "#/";
  });

  document.getElementById("sessionAgainBtn")?.addEventListener("click", () => {
    appState.session = null;
    startSession(true);
  });
}

function renderSession() {
  if (!appState.session) {
    startSession(false);
    if (!appState.session) {
      window.location.hash = "#/";
      return;
    }
  }

  resumeTimer(appState.session.timer);

  if (appState.session.phase === "cards") {
    renderSessionCards();
    return;
  }

  if (appState.session.phase === "drill") {
    renderSessionDrill();
    return;
  }

  if (appState.session.phase === "quickfire") {
    renderSessionQuickfire();
    if (!appState.session.quickfire.timerId && !appState.session.quickfire.locked) {
      startQuickfireTimer();
    }
    return;
  }

  renderSessionComplete();
}

function renderPhrasesList(phrases, { showCategoryLabel = true } = {}) {
  if (!phrases.length) {
    return `<div class="empty">No phrases found for this search.</div>`;
  }

  return phrases
    .map((phrase) => {
      const expanded = appState.ui.expandedPhraseId === phrase.id;
      const pState = appState.store.phrases[phrase.id];
      const status = pState
        ? `Box ${pState.box} · ${pState.nextReview ? `Next: ${formatShortDate(pState.nextReview)}` : "Due now"}`
        : "New phrase";

      return `
        <article class="phrase-row">
          <button class="btn btn-ghost phrase-expand" data-phrase-id="${escapeHtml(phrase.id)}" style="width:100%; text-align:left; padding: 10px 12px;">
            <div class="phrase-top">
              <div>
                <p class="phrase-title" style="font-family:'Newsreader',serif; font-size: 24px; font-style: italic; margin-bottom:2px; color: var(--green);">${escapeHtml(phrase.phonetic)}</p>
                <p class="phrase-meta" style="font-size: 18px; color: var(--text);">${escapeHtml(phrase.bangla)}</p>
                <p class="phrase-meta">${escapeHtml(phrase.english)}${showCategoryLabel ? ` · ${escapeHtml(phrase.category)}` : ""}</p>
              </div>
              <span class="mono" style="font-size:11px; color: var(--text-muted);">${escapeHtml(status)}</span>
            </div>
          </button>
          ${
            expanded
              ? `
                <div class="expand-content">
                  <p style="margin:0 0 8px;"><strong>Literal:</strong> ${escapeHtml(phrase.literal || "—")}</p>
                  <p style="margin:0 0 8px;"><strong>Notes:</strong> ${escapeHtml(phrase.notes || "—")}</p>
                  <p style="margin:0;"><strong>Context:</strong> ${escapeHtml(phrase.context || "—")}</p>
                </div>
              `
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function bindPhraseExpand() {
  document.querySelectorAll(".phrase-expand").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.phraseId;
      appState.ui.expandedPhraseId = appState.ui.expandedPhraseId === id ? null : id;
      renderRoute();
    });
  });
}

function renderPhrases() {
  const categories = categoryStats();
  const term = appState.ui.phraseSearch.trim().toLowerCase();

  const filteredPhrases = appState.data.phrases.filter((phrase) => {
    if (!term) return true;
    return [phrase.english, phrase.phonetic, phrase.bangla, phrase.category].join(" ").toLowerCase().includes(term);
  });

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Phrase bank</p>
        <h1 class="page-title" style="font-size: 28px;">Browse by category</h1>
        <p class="page-subtitle">Phonetic first, script second, meaning always visible.</p>
      </header>

      <input id="phraseSearchInput" class="search" placeholder="Search phrase, phonetic, or English..." value="${escapeHtml(appState.ui.phraseSearch)}" />

      <section class="surface category-list stack">
        ${categories
          .map((cat) => {
            const percent = cat.starterCount ? Math.round((cat.learnedCount / cat.starterCount) * 100) : 0;
            return `
              <a class="category-row" href="#/phrases/${escapeHtml(cat.id)}">
                <div class="category-top">
                  <div>
                    <p class="category-title">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)}</p>
                    <p class="category-meta">${cat.learnedCount}/${cat.starterCount || cat.totalTarget} starter phrases learned</p>
                  </div>
                  <span class="mono" style="font-size:12px; color: var(--text-muted);">${percent}%</span>
                </div>
                <div class="progress-track"><div class="progress-fill" style="width:${percent}%;"></div></div>
              </a>
            `;
          })
          .join("")}
      </section>

      <section class="surface stack">
        <div class="row-between">
          <p class="page-kicker" style="margin:0;">All starter phrases</p>
          <span class="mono" style="font-size: 12px; color: var(--text-muted);">${filteredPhrases.length}</span>
        </div>
        ${renderPhrasesList(filteredPhrases)}
      </section>
    </section>
  `;

  document.getElementById("phraseSearchInput")?.addEventListener("input", (event) => {
    appState.ui.phraseSearch = event.target.value;
    renderRoute();
  });

  bindPhraseExpand();
}

function renderPhrasesCategory(categoryId) {
  const category = appState.data.categories.find((item) => item.id === categoryId);
  const phrases = appState.data.phrases.filter((phrase) => phrase.category === categoryId);
  const term = appState.ui.categorySearch.trim().toLowerCase();
  const filtered = phrases.filter((phrase) => {
    if (!term) return true;
    return [phrase.english, phrase.phonetic, phrase.bangla].join(" ").toLowerCase().includes(term);
  });

  if (!category) {
    window.location.hash = "#/phrases";
    return;
  }

  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToPhrases" class="btn btn-ghost" style="width: fit-content;">← Back to categories</button>

      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">${escapeHtml(category.emoji)} ${escapeHtml(category.label)}</p>
        <h1 class="page-title" style="font-size: 28px;">${escapeHtml(category.description)}</h1>
        <p class="page-subtitle">${filtered.length} of ${phrases.length} phrases shown</p>
      </header>

      <input id="categorySearchInput" class="search" placeholder="Search in this category..." value="${escapeHtml(appState.ui.categorySearch)}" />

      <section class="surface stack">
        ${renderPhrasesList(filtered, { showCategoryLabel: false })}
      </section>
    </section>
  `;

  document.getElementById("backToPhrases")?.addEventListener("click", () => {
    appState.ui.categorySearch = "";
    window.location.hash = "#/phrases";
  });

  document.getElementById("categorySearchInput")?.addEventListener("input", (event) => {
    appState.ui.categorySearch = event.target.value;
    renderRoute();
  });

  bindPhraseExpand();
}

function renderDrills() {
  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Conversation drills</p>
        <h1 class="page-title" style="font-size: 28px;">Practice real moments</h1>
        <p class="page-subtitle">Scenario-based lines for family visits, calls, and mealtime conversation.</p>
      </header>

      <section class="surface stack">
        ${appState.data.drills
          .map((drill) => {
            return `
              <a class="drill-row" href="#/drills/${escapeHtml(drill.id)}">
                <div class="drill-top">
                  <div>
                    <p class="drill-title">${escapeHtml(drill.title)}</p>
                    <p class="drill-meta">${escapeHtml(drill.description)}</p>
                  </div>
                  <span class="chip ${drill.difficulty >= 2 ? "soft" : "dark"}" style="min-width: 84px;">Level ${drill.difficulty}</span>
                </div>
              </a>
            `;
          })
          .join("")}
      </section>
    </section>
  `;
}

function renderDrillDetail(drillId) {
  const drill = getDrillById(drillId);
  if (!drill) {
    window.location.hash = "#/drills";
    return;
  }

  if (appState.ui.drillSteps[drillId] == null) appState.ui.drillSteps[drillId] = 0;
  const step = appState.ui.drillSteps[drillId];
  const visibleLines = drill.lines.slice(0, step + 1);
  const isDone = step >= drill.lines.length - 1;

  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToDrills" class="btn btn-ghost" style="width: fit-content;">← Back to drills</button>

      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">${escapeHtml(drill.category)} · level ${drill.difficulty}</p>
        <h1 class="page-title" style="font-size: 28px;">${escapeHtml(drill.title)}</h1>
        <p class="page-subtitle">${escapeHtml(drill.description)}</p>
      </header>

      <section class="surface conversation">
        ${visibleLines
          .map((line) => {
            const isYou = line.speaker === "you";
            return `
              <div class="bubble-wrap ${isYou ? "you" : "them"}">
                <div class="speaker-label">${escapeHtml(line.speakerLabel || (isYou ? "You" : "They"))}</div>
                <div class="bubble">
                  <p class="bubble-bangla">${escapeHtml(line.bangla)}</p>
                  <p class="bubble-phonetic">${escapeHtml(line.phonetic)}</p>
                  <p class="bubble-english">${escapeHtml(line.english)}</p>
                </div>
              </div>
            `;
          })
          .join("")}
      </section>

      <aside class="tip-box">
        <p class="tip-title">Cultural note</p>
        <p class="tip-text">${escapeHtml(drill.culturalNote || "Keep tone polite and warm.")}</p>
      </aside>

      <div class="row-between">
        <button id="drillReplayBtn" type="button" class="btn btn-soft">Restart</button>
        <button id="drillAdvanceBtn" type="button" class="btn btn-primary">${isDone ? "Done" : "Next line"}</button>
      </div>
    </section>
  `;

  document.getElementById("backToDrills")?.addEventListener("click", () => {
    window.location.hash = "#/drills";
  });

  document.getElementById("drillReplayBtn")?.addEventListener("click", () => {
    appState.ui.drillSteps[drillId] = 0;
    renderRoute();
  });

  document.getElementById("drillAdvanceBtn")?.addEventListener("click", () => {
    if (isDone) {
      window.location.hash = "#/drills";
      return;
    }

    appState.ui.drillSteps[drillId] += 1;
    renderRoute();
  });
}

function renderProgress() {
  const learned = appState.store.stats.phrasesLearned;
  const total = appState.data.phrases.length;
  const percent = total ? Math.round((learned / total) * 100) : 0;

  const totalAttempts = appState.store.stats.totalCorrect + appState.store.stats.totalIncorrect;
  const recallRate = totalAttempts ? Math.round((appState.store.stats.totalCorrect / totalAttempts) * 100) : 0;

  const weekly = getWeeklyTracker();
  const weeklyMinutes = weekly.reduce((sum, day) => sum + day.minutes, 0);
  const categories = categoryStats();
  const milestone = milestoneInfo(learned);

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Your progress</p>
        <h1 class="page-title" style="font-size: 28px;">Growing every day</h1>
        <p class="page-subtitle">Consistency over perfection.</p>
      </header>

      <article class="hero-progress">
        <span class="ghost">${learned}</span>
        <div class="row-between" style="align-items: flex-end;">
          <div>
            <p class="metric-value" style="font-size: 58px; margin: 0;">${learned}</p>
            <p class="metric-label" style="color: rgba(245,242,237,0.7);">phrases learned</p>
          </div>
          <div style="text-align:right;">
            <p class="metric-value" style="font-size: 28px; color: var(--green-muted); margin: 0;">${total}</p>
            <p class="metric-label" style="color: rgba(245,242,237,0.55);">starter total</p>
          </div>
        </div>
        <div class="progress-track" style="margin-top: 14px; background: rgba(245,242,237,0.12);">
          <div class="progress-fill" style="width: ${percent}%; background: linear-gradient(90deg, var(--green), var(--green-muted));"></div>
        </div>
      </article>

      <div class="kpi-grid">
        <article class="kpi-card"><p class="value">${appState.store.stats.currentStreak}</p><p class="label">Current streak</p></article>
        <article class="kpi-card"><p class="value">${recallRate}%</p><p class="label">Recall rate</p></article>
        <article class="kpi-card"><p class="value">${weeklyMinutes}m</p><p class="label">This week</p></article>
      </div>

      <section class="surface stack category-list">
        <p class="page-kicker" style="margin:0;">By category</p>
        ${categories
          .map((cat) => {
            const catPct = cat.starterCount ? Math.round((cat.learnedCount / cat.starterCount) * 100) : 0;
            return `
              <div class="category-row">
                <div class="category-top">
                  <div>
                    <p class="category-title">${escapeHtml(cat.emoji)} ${escapeHtml(cat.label)}</p>
                    <p class="category-meta">${cat.learnedCount}/${cat.starterCount || cat.totalTarget} learned</p>
                  </div>
                  <span class="mono" style="font-size:12px; color: var(--text-muted);">${catPct}%</span>
                </div>
                <div class="progress-track"><div class="progress-fill" style="width:${catPct}%;"></div></div>
              </div>
            `;
          })
          .join("")}
      </section>

      <article class="surface" style="background: var(--red-light); border-color: rgba(217,59,43,0.14); text-align:center;">
        <p style="margin:0; font-size: 24px;">🇧🇩</p>
        <p class="page-title" style="margin-top: 2px; font-size: 22px;">Next milestone: ${milestone.next} phrases</p>
        <p class="page-subtitle" style="margin-top: 4px;">${milestone.remaining} to go · enough for stronger everyday small talk</p>
      </article>

      <section class="surface stack">
        <p class="page-kicker" style="margin:0;">Backup</p>
        <p class="page-subtitle" style="margin-top:0;">Export your progress JSON or import a previous backup.</p>
        <div class="row-between">
          <button id="exportBackupBtn" class="btn btn-soft" type="button">Export backup</button>
          <label class="btn btn-ghost" for="importBackupInput" style="display:inline-flex; align-items:center; justify-content:center;">Import backup</label>
          <input id="importBackupInput" type="file" accept="application/json" style="display:none;" />
        </div>
      </section>
    </section>
  `;

  document.getElementById("exportBackupBtn")?.addEventListener("click", () => {
    const payload = JSON.stringify(appState.store, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bangla10-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("importBackupInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.stats || !parsed.phrases) {
        throw new Error("Invalid backup file");
      }
      const baseline = loadStore();
      appState.store = {
        ...baseline,
        ...parsed,
        version: STORAGE_VERSION,
        meta: {
          ...(baseline.meta || {}),
          ...(parsed.meta || {}),
          revision: Number(parsed.meta?.revision) || 0,
          lastSyncedAt: parsed.meta?.lastSyncedAt || null,
          dirty: false
        },
        stats: {
          ...baseline.stats,
          ...(parsed.stats || {})
        },
        settings: {
          ...baseline.settings,
          ...(parsed.settings || {})
        },
        sessions: {
          ...(parsed.sessions || {})
        },
        phrases: {
          ...(parsed.phrases || {})
        },
        prayer: {
          ...baseline.prayer,
          ...(parsed.prayer || {}),
          recitations: {
            ...((parsed.prayer && parsed.prayer.recitations) || {})
          }
        }
      };
      saveStore();
      alert("Backup imported successfully.");
      renderRoute();
    } catch {
      alert("Could not import this backup file.");
    }
  });
}

function clearPrayerShadowTimer() {
  if (!appState.ui.prayerShadowTimerId) return;
  clearInterval(appState.ui.prayerShadowTimerId);
  appState.ui.prayerShadowTimerId = null;
}

function clearPrayerFlowAudio() {
  if (appState.ui.prayerFlowAudio) {
    appState.ui.prayerFlowAudio.pause();
    appState.ui.prayerFlowAudio.currentTime = 0;
    appState.ui.prayerFlowAudio = null;
  }
  if (appState.ui.prayerFlowAudioResolver) {
    const resolver = appState.ui.prayerFlowAudioResolver;
    appState.ui.prayerFlowAudioResolver = null;
    resolver(false);
  }
}

function touchPrayerActivity() {
  if (!appState.store.prayer) {
    appState.store.prayer = {
      recitations: {},
      lastPracticeDate: null,
      totalPracticeSessions: 0
    };
  }
  const today = todayISO();
  if (appState.store.prayer.lastPracticeDate !== today) {
    appState.store.prayer.totalPracticeSessions += 1;
  }
  appState.store.prayer.lastPracticeDate = today;
}

function recalcPrayerRecitationStatus(recitation) {
  const state = ensurePrayerRecitationState(
    recitation.id,
    recitation.chunks.map((chunk) => chunk.id)
  );
  const statuses = recitation.chunks.map((chunk) => state.chunks[chunk.id]?.status || "new");
  if (statuses.every((status) => status === "memorised")) {
    state.fullRecitationStatus = "memorised";
  } else if (statuses.some((status) => status === "practicing" || status === "memorised")) {
    state.fullRecitationStatus = "practicing";
  } else {
    state.fullRecitationStatus = "new";
  }
  return state.fullRecitationStatus;
}

function setPrayerRecitationFullStatus(recitationId, status) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const state = ensurePrayerRecitationState(
    recitation.id,
    recitation.chunks.map((chunk) => chunk.id)
  );
  state.fullRecitationStatus = status;
  state.lastFullAttempt = todayISO();

  if (status === "memorised") {
    for (const chunk of recitation.chunks) {
      state.chunks[chunk.id] = {
        status: "memorised",
        lastPracticed: todayISO()
      };
    }
  } else if (status === "new") {
    for (const chunk of recitation.chunks) {
      state.chunks[chunk.id] = {
        status: "new",
        lastPracticed: state.chunks[chunk.id]?.lastPracticed || null
      };
    }
  } else if (status === "practicing") {
    const hasPractice = recitation.chunks.some((chunk) => {
      const chunkStatus = state.chunks[chunk.id]?.status || "new";
      return chunkStatus === "practicing" || chunkStatus === "memorised";
    });
    if (!hasPractice && recitation.chunks[0]) {
      state.chunks[recitation.chunks[0].id] = {
        status: "practicing",
        lastPracticed: todayISO()
      };
    }
  }

  touchPrayerActivity();
  saveStore();
}

function updatePrayerChunkStatus(recitationId, chunkId, status) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const recitationState = ensurePrayerRecitationState(
    recitationId,
    recitation.chunks.map((chunk) => chunk.id)
  );
  recitationState.chunks[chunkId] = {
    status,
    lastPracticed: todayISO()
  };
  recalcPrayerRecitationStatus(recitation);
  touchPrayerActivity();
  saveStore();
}

function cyclePrayerChunkStatus(recitationId, chunkId) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const recitationState = ensurePrayerRecitationState(
    recitationId,
    recitation.chunks.map((chunk) => chunk.id)
  );
  const current = recitationState.chunks[chunkId]?.status || "new";
  updatePrayerChunkStatus(recitationId, chunkId, nextPrayerStatus(current));
}

function trackPrayerChunkPracticed(recitationId, chunkId, save = true) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const recitationState = ensurePrayerRecitationState(
    recitationId,
    recitation.chunks.map((chunk) => chunk.id)
  );
  const existing = recitationState.chunks[chunkId] || { status: "new", lastPracticed: null };
  recitationState.chunks[chunkId] = {
    ...existing,
    lastPracticed: todayISO()
  };
  touchPrayerActivity();
  if (save) saveStore();
}

function playPrayerChunkAudio(chunk, { rate = 1, trackFlowAudio = false } = {}) {
  const url = getPrayerAudioUrl(chunk);
  if (url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.playbackRate = rate;

      const finish = (result) => {
        audio.onended = null;
        audio.onerror = null;
        if (trackFlowAudio && appState.ui.prayerFlowAudio === audio) {
          appState.ui.prayerFlowAudio = null;
          appState.ui.prayerFlowAudioResolver = null;
        }
        resolve(result);
      };

      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);

      if (trackFlowAudio) {
        clearPrayerFlowAudio();
        appState.ui.prayerFlowAudio = audio;
        appState.ui.prayerFlowAudioResolver = finish;
      }

      audio.play().catch(() => finish(false));
    });
  }

  if ("speechSynthesis" in window) {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(chunk.arabic || chunk.transliteration || "");
      utterance.lang = "ar";
      utterance.rate = Math.max(0.7, Math.min(1.2, rate));
      utterance.onend = () => resolve(true);
      utterance.onerror = () => resolve(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  return Promise.resolve(false);
}

function chooseTodayPrayerTarget() {
  const ordered = [...appState.data.prayerRecitations].sort((a, b) => a.order - b.order);
  const rows = ordered.map((recitation) => ({ recitation, progress: prayerRecitationProgress(recitation) }));
  const targetRow = rows.find((row) => row.progress.status !== "memorised") || rows[0] || null;
  if (!targetRow) return null;
  const recitationState = ensurePrayerRecitationState(
    targetRow.recitation.id,
    targetRow.recitation.chunks.map((chunk) => chunk.id)
  );
  const nextChunk =
    targetRow.recitation.chunks.find(
      (chunk) => (recitationState.chunks[chunk.id]?.status || "new") !== "memorised"
    ) || targetRow.recitation.chunks[0];

  return {
    recitation: targetRow.recitation,
    progress: targetRow.progress,
    nextChunk
  };
}

async function startPrayerShadow(recitationId, chunkId) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const chunk = recitation.chunks.find((item) => item.id === chunkId);
  if (!chunk) return;

  clearPrayerShadowTimer();
  appState.ui.prayerShadow = {
    recitationId,
    chunkId,
    stage: "playing",
    countdown: 0
  };
  renderRoute();
  await playPrayerChunkAudio(chunk, { rate: 1 });
  trackPrayerChunkPracticed(recitationId, chunkId, true);

  if (!appState.ui.prayerShadow || appState.ui.prayerShadow.chunkId !== chunkId) return;
  appState.ui.prayerShadow = {
    recitationId,
    chunkId,
    stage: "repeat",
    countdown: 3
  };
  renderRoute();
  appState.ui.prayerShadowTimerId = setInterval(() => {
    if (!appState.ui.prayerShadow) {
      clearPrayerShadowTimer();
      return;
    }
    appState.ui.prayerShadow.countdown -= 1;
    if (appState.ui.prayerShadow.countdown <= 0) {
      clearPrayerShadowTimer();
      appState.ui.prayerShadow = null;
    }
    renderRoute();
  }, 1000);
}

function stopPrayerFlow({ rerender = true } = {}) {
  if (appState.ui.prayerFlow) {
    appState.ui.prayerFlow.isPlaying = false;
  }
  clearPrayerFlowAudio();
  appState.ui.prayerFlow = null;
  if (rerender) renderRoute();
}

async function startPrayerFlow(recitationId) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) return;
  const chosenSpeed =
    appState.ui.prayerFlow?.recitationId === recitationId ? appState.ui.prayerFlow.speed || 1 : 1;

  stopPrayerFlow({ rerender: false });
  appState.ui.prayerFlow = {
    recitationId,
    currentIndex: -1,
    isPlaying: true,
    speed: chosenSpeed
  };
  renderRoute();

  for (let index = 0; index < recitation.chunks.length; index += 1) {
    if (!appState.ui.prayerFlow?.isPlaying || appState.ui.prayerFlow.recitationId !== recitationId) return;
    appState.ui.prayerFlow.currentIndex = index;
    renderRoute();
    await playPrayerChunkAudio(recitation.chunks[index], {
      rate: appState.ui.prayerFlow.speed || 1,
      trackFlowAudio: true
    });
    trackPrayerChunkPracticed(recitationId, recitation.chunks[index].id, false);
  }

  if (appState.ui.prayerFlow?.recitationId === recitationId) {
    appState.ui.prayerFlow.isPlaying = false;
    appState.ui.prayerFlow.currentIndex = -1;
  }
  touchPrayerActivity();
  saveStore();
  renderRoute();
}

function startPrayerTest(recitationId) {
  appState.ui.prayerTest = {
    recitationId,
    index: 0,
    revealed: false,
    results: [],
    completed: false
  };
  renderRoute();
}

function advancePrayerTest(recitation, gotIt) {
  if (!appState.ui.prayerTest || appState.ui.prayerTest.recitationId !== recitation.id) return;
  const currentChunk = recitation.chunks[appState.ui.prayerTest.index];
  if (!currentChunk) return;
  appState.ui.prayerTest.results.push({
    chunkId: currentChunk.id,
    gotIt
  });
  trackPrayerChunkPracticed(recitation.id, currentChunk.id, false);

  appState.ui.prayerTest.index += 1;
  appState.ui.prayerTest.revealed = false;
  if (appState.ui.prayerTest.index >= recitation.chunks.length) {
    appState.ui.prayerTest.completed = true;
    const hitRate = appState.ui.prayerTest.results.filter((row) => row.gotIt).length / appState.ui.prayerTest.results.length;
    if (hitRate >= 0.85) {
      setPrayerRecitationFullStatus(recitation.id, "memorised");
    } else if (hitRate >= 0.4) {
      setPrayerRecitationFullStatus(recitation.id, "practicing");
    } else {
      setPrayerRecitationFullStatus(recitation.id, "new");
    }
  } else {
    touchPrayerActivity();
    saveStore();
  }
  renderRoute();
}

function renderSalahHome() {
  const progress = overallPrayerProgress();
  const rows = [...progress.rows].sort((a, b) => a.recitation.order - b.recitation.order);
  const todayTarget = chooseTodayPrayerTarget();
  const agenda = todayTarget
    ? `${todayTarget.progress.status === "new" ? "Learn" : "Review"} ${todayTarget.recitation.name}`
    : "Open any recitation to begin";
  const agendaSub = todayTarget?.nextChunk ? `${todayTarget.nextChunk.transliteration}` : "5-8 min";

  appEl.innerHTML = `
    <section class="fade-in stack">
      <header class="page-intro">
        <p class="page-kicker">Salah</p>
        <h1 class="page-title">Learn the words of prayer</h1>
        <p class="page-subtitle">Audio-first, respectful, and practical.</p>
      </header>

      <section class="surface stack">
        <div class="row-between">
          <p class="page-kicker" style="margin:0;">Prayer progress</p>
          <span class="mono" style="font-size:12px; color: var(--text-muted);">${progress.memorisedCount}/${progress.total} memorised</span>
        </div>
        <div class="salah-list">
          ${rows
            .map((row) => {
              const dotClass = row.progress.status;
              return `
                <a class="salah-row" href="#/salah/learn/${escapeHtml(row.recitation.id)}">
                  <span class="status-dot ${dotClass}"></span>
                  <div class="salah-row-main">
                    <p class="salah-row-title">${escapeHtml(row.recitation.name)}</p>
                    <p class="salah-row-meta">${row.progress.memorised}/${row.progress.total} chunks memorised</p>
                  </div>
                  <span class="mono" style="font-size:11px; color: var(--text-light);">#${row.recitation.order}</span>
                </a>
              `;
            })
            .join("")}
        </div>
      </section>

      <button id="salahStartTodayBtn" class="btn cta-session" type="button" style="width: 100%;">
        <span class="watermark">☾</span>
        <p class="page-kicker" style="color: rgba(245, 242, 237, 0.68); margin-bottom: 8px;">Today's practice</p>
        <p style="margin: 0; font-family: 'Newsreader', serif; font-size: 24px; font-style: italic;">${escapeHtml(agenda)}</p>
        <p style="margin: 6px 0 0; font-size: 12px; color: rgba(245, 242, 237, 0.72);">${escapeHtml(agendaSub)} · ~5-8 min</p>
      </button>

      <section class="surface stack">
        <p class="page-kicker" style="margin:0;">Quick reference</p>
        <a class="category-row" href="#/salah/map"><p class="category-title">Prayer map</p><p class="category-meta">Full 2-raka'ah flow</p></a>
        <a class="category-row" href="#/salah/wudu"><p class="category-title">Wudu guide</p><p class="category-meta">Step-by-step ablution</p></a>
        <a class="category-row" href="#/salah/phrases"><p class="category-title">Islamic phrases</p><p class="category-meta">Everyday family phrases</p></a>
      </section>
    </section>
  `;

  document.getElementById("salahStartTodayBtn")?.addEventListener("click", () => {
    if (!todayTarget) return;
    window.location.hash = `#/salah/learn/${todayTarget.recitation.id}`;
  });
}

function renderSalahLearn(recitationId) {
  const recitation = getPrayerRecitationById(recitationId);
  if (!recitation) {
    window.location.hash = "#/salah";
    return;
  }

  const chunkIds = recitation.chunks.map((chunk) => chunk.id);
  const state = ensurePrayerRecitationState(recitation.id, chunkIds);
  recalcPrayerRecitationStatus(recitation);

  const flow = appState.ui.prayerFlow?.recitationId === recitation.id ? appState.ui.prayerFlow : null;
  const test = appState.ui.prayerTest?.recitationId === recitation.id ? appState.ui.prayerTest : null;

  const testMarkup = (() => {
    if (!test) {
      return `
        <div class="test-box">
          <p class="page-kicker" style="margin:0;">Test yourself</p>
          <p class="page-subtitle" style="margin-top:4px;">Hide text, recall, then reveal and self-check.</p>
          <button id="startPrayerTestBtn" class="btn btn-primary" type="button" style="margin-top:8px;">Start test</button>
        </div>
      `;
    }

    if (test.completed) {
      const hits = test.results.filter((row) => row.gotIt).length;
      return `
        <div class="test-box">
          <p class="page-kicker" style="margin:0;">Test complete</p>
          <p class="page-title" style="font-size:24px; margin-top:4px;">${hits}/${test.results.length} correct</p>
          <p class="page-subtitle" style="margin-top:4px;">Set your overall status below, then continue practicing flow.</p>
          <button id="restartPrayerTestBtn" class="btn btn-soft" type="button" style="margin-top:8px;">Run test again</button>
        </div>
      `;
    }

    const activeChunk = recitation.chunks[test.index];
    const hiddenBlock = !test.revealed
      ? `
          <p class="page-subtitle" style="margin: 4px 0 0;">Chunk ${test.index + 1} of ${recitation.chunks.length}</p>
          <p class="page-kicker" style="margin: 10px 0 0;">Recall now, then reveal</p>
          <div class="test-actions">
            <button type="button" class="btn btn-ghost" id="testPlayBtn">Play audio</button>
            <button type="button" class="btn btn-primary" id="testRevealBtn">Reveal chunk</button>
          </div>
        `
      : `
          <p class="chunk-transliteration" style="margin-top:8px;">${escapeHtml(activeChunk.transliteration)}</p>
          <p class="arabic-text" dir="rtl">${escapeHtml(activeChunk.arabic)}</p>
          <p class="chunk-translation">${escapeHtml(activeChunk.translation)}</p>
          <div class="test-actions">
            <button type="button" class="btn btn-danger" id="testMissedBtn">Missed it</button>
            <button type="button" class="btn btn-secondary" id="testGotItBtn">Got it</button>
          </div>
        `;

    return `
      <div class="test-box">
        <p class="page-kicker" style="margin:0;">Test yourself</p>
        ${hiddenBlock}
      </div>
    `;
  })();

  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToSalahBtn" class="btn btn-ghost" style="width: fit-content;">← Back to Salah</button>

      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">${escapeHtml(recitation.category)} · #${recitation.order}</p>
        <h1 class="page-title" style="font-size: 28px;">${escapeHtml(recitation.name)}</h1>
        <p class="page-subtitle">${escapeHtml(recitation.usedDuring || "Prayer recitation")}</p>
      </header>

      <section class="surface stack">
        <p class="page-kicker" style="margin:0;">Flow mode</p>
        <div class="row-between">
          <button id="prayerFlowToggleBtn" class="btn ${flow?.isPlaying ? "btn-danger" : "btn-primary"}" type="button">${flow?.isPlaying ? "Stop flow" : "Play full recitation"}</button>
          <div class="row-between" style="gap: 6px;">
            <button class="btn btn-ghost prayer-speed-btn" type="button" data-speed="0.75">0.75x</button>
            <button class="btn btn-ghost prayer-speed-btn" type="button" data-speed="1">1x</button>
            <button class="btn btn-ghost prayer-speed-btn" type="button" data-speed="1.25">1.25x</button>
          </div>
        </div>
      </section>

      <section class="surface stack">
        <div class="row-between">
          <p class="page-kicker" style="margin:0;">Chunks</p>
          <span class="chip ${state.fullRecitationStatus === "memorised" ? "green" : state.fullRecitationStatus === "practicing" ? "soft" : "dark"}">${state.fullRecitationStatus}</span>
        </div>
        ${recitation.chunks
          .map((chunk, index) => {
            const expanded = appState.ui.prayerExpandedChunkId === chunk.id;
            const cState = state.chunks[chunk.id] || { status: "new", lastPracticed: null };
            const flowActive = flow?.isPlaying && flow.currentIndex === index;
            const shadowActive =
              appState.ui.prayerShadow?.recitationId === recitation.id && appState.ui.prayerShadow?.chunkId === chunk.id;

            return `
              <article class="chunk-card ${flowActive ? "surface" : ""}" style="${flowActive ? "border-color: rgba(0,106,78,0.35);" : ""}">
                <button class="chunk-head btn btn-ghost" data-chunk-toggle="${escapeHtml(chunk.id)}" type="button" style="width:100%; text-align:left; padding: 8px 10px;">
                  <div>
                    <p class="chunk-transliteration" style="font-size: 22px;">${escapeHtml(chunk.transliteration)}</p>
                    <p class="page-subtitle" style="margin-top:2px;">Chunk ${index + 1}${chunk.ayahNumber ? ` · Ayah ${chunk.ayahNumber}` : ""}</p>
                  </div>
                  <span class="status-dot ${cState.status}"></span>
                </button>

                ${
                  expanded
                    ? `
                      <div style="padding: 0 2px 2px;">
                        <p class="arabic-text" dir="rtl">${escapeHtml(chunk.arabic)}</p>
                        <p class="chunk-translation">${escapeHtml(chunk.translation)}</p>
                        ${
                          chunk.notes
                            ? `<p class="page-subtitle" style="margin-top:6px;">${escapeHtml(chunk.notes)}</p>`
                            : ""
                        }
                        <div class="chunk-actions">
                          <button type="button" class="btn btn-ghost" data-chunk-play="${escapeHtml(chunk.id)}">Play audio</button>
                          <button type="button" class="btn btn-soft" data-chunk-shadow="${escapeHtml(chunk.id)}">Shadow</button>
                        </div>
                        <button type="button" class="btn btn-secondary chunk-status-btn" data-chunk-status="${escapeHtml(chunk.id)}" style="margin-top:8px;">Status: ${cState.status}</button>
                        ${
                          shadowActive
                            ? `<div class="shadow-prompt">${
                                appState.ui.prayerShadow.stage === "playing"
                                  ? "Playing... listen closely"
                                  : `Your turn... ${appState.ui.prayerShadow.countdown}s`
                              }</div>`
                            : ""
                        }
                      </div>
                    `
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </section>

      ${testMarkup}

      <section class="surface stack">
        <p class="page-kicker" style="margin:0;">Self-rate full recitation</p>
        <div class="row-between" style="gap:8px;">
          <button type="button" class="btn btn-ghost" data-full-rate="new">Not yet</button>
          <button type="button" class="btn btn-soft" data-full-rate="practicing">Almost</button>
          <button type="button" class="btn btn-secondary" data-full-rate="memorised">Got it</button>
        </div>
      </section>
    </section>
  `;

  document.getElementById("backToSalahBtn")?.addEventListener("click", () => {
    window.location.hash = "#/salah";
  });

  document.getElementById("prayerFlowToggleBtn")?.addEventListener("click", () => {
    if (appState.ui.prayerFlow?.isPlaying && appState.ui.prayerFlow.recitationId === recitation.id) {
      stopPrayerFlow();
      return;
    }
    startPrayerFlow(recitation.id);
  });

  document.querySelectorAll(".prayer-speed-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const speed = Number(button.dataset.speed);
      if (!Number.isFinite(speed)) return;
      if (!appState.ui.prayerFlow || appState.ui.prayerFlow.recitationId !== recitation.id) {
        appState.ui.prayerFlow = {
          recitationId: recitation.id,
          currentIndex: -1,
          isPlaying: false,
          speed
        };
      } else {
        appState.ui.prayerFlow.speed = speed;
      }
      renderRoute();
    });
  });

  document.querySelectorAll("[data-chunk-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.chunkToggle;
      appState.ui.prayerExpandedChunkId = appState.ui.prayerExpandedChunkId === id ? null : id;
      renderRoute();
    });
  });

  document.querySelectorAll("[data-chunk-play]").forEach((button) => {
    button.addEventListener("click", () => {
      const chunkId = button.dataset.chunkPlay;
      const chunk = recitation.chunks.find((item) => item.id === chunkId);
      if (!chunk) return;
      playPrayerChunkAudio(chunk, { rate: 1 });
      trackPrayerChunkPracticed(recitation.id, chunk.id, true);
    });
  });

  document.querySelectorAll("[data-chunk-shadow]").forEach((button) => {
    button.addEventListener("click", () => {
      const chunkId = button.dataset.chunkShadow;
      startPrayerShadow(recitation.id, chunkId);
    });
  });

  document.querySelectorAll("[data-chunk-status]").forEach((button) => {
    button.addEventListener("click", () => {
      const chunkId = button.dataset.chunkStatus;
      cyclePrayerChunkStatus(recitation.id, chunkId);
      renderRoute();
    });
  });

  document.querySelectorAll("[data-full-rate]").forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.fullRate;
      if (!status) return;
      setPrayerRecitationFullStatus(recitation.id, status);
      renderRoute();
    });
  });

  document.getElementById("startPrayerTestBtn")?.addEventListener("click", () => {
    startPrayerTest(recitation.id);
  });

  document.getElementById("restartPrayerTestBtn")?.addEventListener("click", () => {
    startPrayerTest(recitation.id);
  });

  document.getElementById("testPlayBtn")?.addEventListener("click", () => {
    if (!test || test.completed) return;
    const chunk = recitation.chunks[test.index];
    if (!chunk) return;
    playPrayerChunkAudio(chunk, { rate: 1 });
  });

  document.getElementById("testRevealBtn")?.addEventListener("click", () => {
    if (!appState.ui.prayerTest || appState.ui.prayerTest.recitationId !== recitation.id) return;
    appState.ui.prayerTest.revealed = true;
    renderRoute();
  });

  document.getElementById("testMissedBtn")?.addEventListener("click", () => {
    advancePrayerTest(recitation, false);
  });

  document.getElementById("testGotItBtn")?.addEventListener("click", () => {
    advancePrayerTest(recitation, true);
  });
}

function renderSalahMap() {
  const getFirstChunk = (recitationId) => getPrayerRecitationById(recitationId)?.chunks?.[0] || null;
  const steps = [
    { position: "Standing (Qiyam)", recitationId: "takbir", text: "Takbir: Allahu Akbar" },
    { position: "Standing (Qiyam)", recitationId: "thana", text: "Thana (opening praise)" },
    { position: "Standing (Qiyam)", recitationId: "taawwuz", text: "Ta'awwuz (seeking refuge)" },
    { position: "Standing (Qiyam)", recitationId: "al-fatihah", text: "Surah Al-Fatihah + Ameen" },
    { position: "Standing (Qiyam)", recitationId: "al-ikhlas", text: "Surah Al-Ikhlas (first two raka'ahs)" },
    { position: "Bowing (Ruku)", recitationId: "ruku", text: "Subhana rabbiyal-'azeem x3" },
    { position: "Standing (briefly)", recitationId: "rising-from-ruku", text: "Sami'Allahu liman hamidah / Rabbana wa lakal-hamd" },
    { position: "Prostration (Sujud)", recitationId: "sujud", text: "Subhana rabbiyal-a'la x3" },
    { position: "Sitting", recitationId: "between-sujud", text: "Rabbighfirli x2" },
    { position: "Final Sitting", recitationId: "tashahhud", text: "Tashahhud" },
    { position: "Final Sitting", recitationId: "durood", text: "Durood Ibrahim" },
    { position: "Ending", recitationId: "tasleem", text: "Tasleem: right then left" }
  ];

  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToSalahFromMap" class="btn btn-ghost" style="width: fit-content;">← Back to Salah</button>
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Prayer map</p>
        <h1 class="page-title" style="font-size: 28px;">2-raka'ah flow reference</h1>
        <p class="page-subtitle">Tap any step to hear the recitation cue.</p>
      </header>

      <section class="surface prayer-map">
        ${steps
          .map((step, index) => {
            const chunk = getFirstChunk(step.recitationId);
            return `
              <article class="prayer-step">
                <p class="prayer-step-title">${escapeHtml(step.position)}</p>
                <p class="prayer-step-text">${escapeHtml(step.text)}</p>
                <div class="row-between" style="margin-top:8px;">
                  <button type="button" class="btn btn-ghost" data-map-play="${escapeHtml(step.recitationId)}">Play cue</button>
                  <a href="#/salah/learn/${escapeHtml(step.recitationId)}" class="btn btn-soft" style="display:inline-flex; align-items:center; justify-content:center;">Open</a>
                </div>
                ${chunk ? `<p class="page-subtitle" style="margin-top:8px;">${escapeHtml(chunk.transliteration)}</p>` : ""}
              </article>
              ${index < steps.length - 1 ? `<p class="mono" style="text-align:center; color:var(--text-light); margin:0;">↓</p>` : ""}
            `;
          })
          .join("")}
      </section>
    </section>
  `;

  document.getElementById("backToSalahFromMap")?.addEventListener("click", () => {
    window.location.hash = "#/salah";
  });

  document.querySelectorAll("[data-map-play]").forEach((button) => {
    button.addEventListener("click", () => {
      const recitationId = button.dataset.mapPlay;
      const chunk = getFirstChunk(recitationId);
      if (!chunk) return;
      playPrayerChunkAudio(chunk, { rate: 1 });
    });
  });
}

function renderSalahWudu() {
  const steps = [...appState.data.wuduSteps].sort((a, b) => a.order - b.order);
  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToSalahFromWudu" class="btn btn-ghost" style="width: fit-content;">← Back to Salah</button>
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Wudu</p>
        <h1 class="page-title" style="font-size: 28px;">Step-by-step ablution</h1>
        <p class="page-subtitle">Reference guide before prayer.</p>
      </header>

      <section class="surface stack">
        ${steps
          .map((step) => {
            return `
              <article class="wudu-step">
                <p class="wudu-step-title">${step.order}. ${escapeHtml(step.name)} ${step.nameArabic ? `· <span class="mono">${escapeHtml(step.nameArabic)}</span>` : ""}</p>
                <p class="wudu-step-note">${escapeHtml(step.instruction)}</p>
                ${step.times ? `<p class="page-subtitle" style="margin-top:6px;">Repeat ${step.times} time${step.times > 1 ? "s" : ""}</p>` : ""}
              </article>
            `;
          })
          .join("")}
      </section>
    </section>
  `;

  document.getElementById("backToSalahFromWudu")?.addEventListener("click", () => {
    window.location.hash = "#/salah";
  });
}

function renderSalahPhrases() {
  appEl.innerHTML = `
    <section class="fade-in stack">
      <button type="button" id="backToSalahFromPhrases" class="btn btn-ghost" style="width: fit-content;">← Back to Salah</button>
      <header class="page-intro" style="margin-bottom: 6px;">
        <p class="page-kicker">Islamic phrases</p>
        <h1 class="page-title" style="font-size: 28px;">Everyday family phrases</h1>
        <p class="page-subtitle">Quick reference with pronunciation support.</p>
      </header>

      <section class="surface stack">
        ${appState.data.commonIslamicPhrases
          .map((phrase) => {
            return `
              <article class="chunk-card">
                <p class="chunk-transliteration">${escapeHtml(phrase.transliteration)}</p>
                <p class="arabic-text" dir="rtl">${escapeHtml(phrase.arabic)}</p>
                <p class="chunk-translation">${escapeHtml(phrase.translation)}</p>
                <p class="page-subtitle" style="margin-top:6px;">When: ${escapeHtml(phrase.whenToUse || "General use")}</p>
                <button type="button" class="btn btn-ghost" data-common-play="${escapeHtml(phrase.id)}" style="margin-top:8px;">Play</button>
              </article>
            `;
          })
          .join("")}
      </section>
    </section>
  `;

  document.getElementById("backToSalahFromPhrases")?.addEventListener("click", () => {
    window.location.hash = "#/salah";
  });

  document.querySelectorAll("[data-common-play]").forEach((button) => {
    button.addEventListener("click", () => {
      const phrase = appState.data.commonIslamicPhrases.find((row) => row.id === button.dataset.commonPlay);
      if (!phrase) return;
      playPrayerChunkAudio(
        {
          arabic: phrase.arabic,
          transliteration: phrase.transliteration,
          audioFile: phrase.audioFile || ""
        },
        { rate: 1 }
      );
    });
  });
}

function renderRoute() {
  const route = getRoute();
  setActiveNav(route.page);
  const onSalahRoute = route.page.startsWith("salah");

  if (!appState.session || route.page !== "session") {
    clearQuickfireTimer();
  }

  if (appState.session && route.page !== "session") {
    pauseTimer(appState.session.timer);
  }

  if (route.page !== "salah-learn") {
    clearPrayerShadowTimer();
    appState.ui.prayerShadow = null;
    if (appState.ui.prayerFlow?.isPlaying) {
      appState.ui.prayerFlow.isPlaying = false;
    }
    clearPrayerFlowAudio();
    appState.ui.prayerFlow = null;
  }

  if (!onSalahRoute) {
    appState.ui.prayerTest = null;
    appState.ui.prayerFlow = null;
  }

  if (route.page === "home") {
    renderHome();
    return;
  }

  if (route.page === "session") {
    renderSession();
    return;
  }

  if (route.page === "phrases") {
    renderPhrases();
    return;
  }

  if (route.page === "phrases-category") {
    renderPhrasesCategory(route.categoryId);
    return;
  }

  if (route.page === "drills") {
    renderDrills();
    return;
  }

  if (route.page === "drill-detail") {
    renderDrillDetail(route.drillId);
    return;
  }

  if (route.page === "progress") {
    renderProgress();
    return;
  }

  if (route.page === "salah-home") {
    renderSalahHome();
    return;
  }

  if (route.page === "salah-learn") {
    renderSalahLearn(route.recitationId);
    return;
  }

  if (route.page === "salah-map") {
    renderSalahMap();
    return;
  }

  if (route.page === "salah-wudu") {
    renderSalahWudu();
    return;
  }

  if (route.page === "salah-phrases") {
    renderSalahPhrases();
    return;
  }

  renderHome();
}

function updateClock() {
  const now = new Date();
  if (!clockEl) return;
  clockEl.textContent = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

async function loadData() {
  const [phrases, drills, categories, prayerPayload, wuduPayload] = await Promise.all([
    fetch("./data/phrases.json").then((r) => r.json()),
    fetch("./data/drills.json").then((r) => r.json()),
    fetch("./data/categories.json").then((r) => r.json()),
    fetch("./data/prayer.json").then((r) => r.json()),
    fetch("./data/wudu.json").then((r) => r.json())
  ]);

  appState.data = {
    phrases,
    drills,
    categories,
    prayerRecitations: [...(prayerPayload.recitations || [])].sort((a, b) => a.order - b.order),
    wuduSteps: [...(wuduPayload.steps || [])].sort((a, b) => a.order - b.order),
    commonIslamicPhrases: prayerPayload.commonPhrases || []
  };
}

async function init() {
  appState.store = loadStore();
  appState.sync.revision = Number(appState.store?.meta?.revision) || 0;
  appState.sync.lastSyncedAt = appState.store?.meta?.lastSyncedAt || null;
  updateClock();
  setInterval(updateClock, 30000);

  await loadData();

  if (!window.location.hash) {
    window.location.hash = "#/";
  }

  renderRoute();
  void bootstrapServerSync();

  window.addEventListener("hashchange", () => {
    appState.ui.expandedPhraseId = null;
    appState.ui.prayerExpandedChunkId = null;
    renderRoute();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (appState.session) {
        pauseTimer(appState.session.timer);
      }
      if (appState.ui.prayerFlow?.isPlaying) {
        stopPrayerFlow({ rerender: false });
      }
    } else if (appState.session && getRoute().page === "session") {
      resumeTimer(appState.session.timer);
    }
  });
}

init().catch((error) => {
  console.error("Failed to initialize app", error);
  appEl.innerHTML = `<div class="empty">Could not load Bangla 10 data. Please refresh.</div>`;
});
