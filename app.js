const DAY_MS = 24 * 60 * 60 * 1000;

const _s = (typeof window !== "undefined" && window.GANTT_SETTINGS) || {};

const model = {
  tasks: [],
  byId: new Map(),
  topoOrder: [],
  gantt: null,
  collapsedGroups: new Set(),
  columnWidths: Object.assign(
    { id: 64, task: 240, assignee: 140, startDate: 74, endDate: 74, progress: 52 },
    _s.columnWidths
  ),
  sidebarWidth: null
};

const SVG_NS = "http://www.w3.org/2000/svg";
const GANTT_HEADER_HEIGHT = (Number.isFinite(Number(_s.ganttHeaderHeight)) ? Number(_s.ganttHeaderHeight) : 60);
const GANTT_ROW_HEIGHT    = (Number.isFinite(Number(_s.ganttRowHeight))    ? Number(_s.ganttRowHeight)    : 36);
const SIDEBAR_EXPANDED_WIDTH  = (Number.isFinite(Number(_s.sidebarExpandedWidth))  ? Number(_s.sidebarExpandedWidth)  : 540);
const SIDEBAR_COLLAPSED_WIDTH = (Number.isFinite(Number(_s.sidebarCollapsedWidth)) ? Number(_s.sidebarCollapsedWidth) : 56);
const MIN_GANTT_COLUMN_WIDTH = 18;
const MAX_GANTT_COLUMN_WIDTH = 220;
const GANTT_COLUMN_WIDTH_STEP = 2;
const DEFAULT_GANTT_COLUMN_WIDTH_BY_MODE = Object.assign(
  { Day: 38, Week: 140, Month: 120 },
  _s.columnWidthByMode
);


const ganttContainer = document.getElementById("gantt");
const jsonOutput = document.getElementById("task-json");
const runtimeNotice = document.getElementById("runtime-notice");
const runtimeMessage = document.getElementById("runtime-message");
const localDataFileInput = document.getElementById("local-data-file");
const createEmptyChartButton = document.getElementById("create-empty-chart");
const runtimeNoticeCloseButton = document.getElementById("runtime-notice-close");
const zoomControls = document.querySelector('.zoom-controls');
const dependencyToggle = document.getElementById("dependency-toggle");
const downloadJsonButton = document.getElementById("download-json");
const loadJsonButton = document.getElementById("load-json");
const addTaskButton = document.getElementById("add-task");
const refreshDataButton = document.getElementById("refresh-data");
const resetLayoutButton = document.getElementById("reset-layout");
const columnWidthMinusButton = document.getElementById("column-width-minus");
const columnWidthPlusButton = document.getElementById("column-width-plus");
const columnWidthValue = document.getElementById("column-width-value");
const rowHeightMinusButton = document.getElementById("row-height-minus");
const rowHeightPlusButton = document.getElementById("row-height-plus");
const rowHeightValue = document.getElementById("row-height-value");
const appTitleInput = document.getElementById("app-title");

const taskModal = document.getElementById("task-modal");
const tmTitle = document.getElementById("tm-title");
const tmId = document.getElementById("tm-id");
const tmGroup = document.getElementById("tm-group");
const tmAssignee = document.getElementById("tm-assignee");
const tmProgress = document.getElementById("tm-progress");
const tmStart = document.getElementById("tm-start");
const tmEnd = document.getElementById("tm-end");
const tmDuration = document.getElementById("tm-duration");
const tmMilestone = document.getElementById("tm-milestone");
const tmDeps = document.getElementById("tm-deps");
const tmBlocking = document.getElementById("tm-blocking");
const tmDescription = document.getElementById("tm-description");
const tmSaveButton = document.getElementById("tm-save");
const tmDeleteButton = document.getElementById("tm-delete");
let modalTaskId = null;

function getSettingsScriptElement() {
  return document.getElementById("gantt-settings-script");
}
let currentViewMode = 'Day';
let ganttColumnWidthByMode = { ...DEFAULT_GANTT_COLUMN_WIDTH_BY_MODE };
let dependencyDisplayMode = "hover";
let hoveredTaskId = null;
let selectedTaskId = null;
let activeEditMode = null;
let interactionTrackingReady = false;
let localFileLoaderReady = false;
let dependencyControlsReady = false;
let columnWidthControlsReady = false;
let rowHeightControlsReady = false;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 80;
const ROW_HEIGHT_STEP = 2;
let currentRowHeight = (() => {
  try {
    const stored = Number(localStorage.getItem("ganttRowHeight"));
    if (Number.isFinite(stored) && stored >= MIN_ROW_HEIGHT && stored <= MAX_ROW_HEIGHT) return stored;
  } catch (e) { /* ignore */ }
  return GANTT_ROW_HEIGHT;
})();
{
  const _bh = Math.max(8, currentRowHeight - 12);
  const _pad = Math.round((currentRowHeight - _bh) / 2);
  document.documentElement.style.setProperty('--gantt-row-height', (_bh + _pad) + 'px');
  // Grid rows start at Frappe internal header_height + padding/2.
  document.documentElement.style.setProperty('--gantt-sidebar-header-h', (GANTT_HEADER_HEIGHT - 10 + _pad / 2) + 'px');
}
let dependencyHoverReady = false;
let stickyTimelineCleanup = null;
let taskSidebarCleanup = null;
let customTodayLineCleanup = null;
let milestoneLinesCleanup = null;
let hasUnsavedEdits = false;

function setUnsavedEdits(value) {
  hasUnsavedEdits = value;
  if (refreshDataButton && refreshDataButton.dataset.ready === "true") {
    refreshDataButton.disabled = !value;
  }
}
let taskSidebarCollapsed = false;
let hasAutoCenteredOnToday = false;
let sidebarResizeCleanup = null;


async function bootstrap() {
  loadColumnWidths();
  loadSidebarWidth();
  loadGanttColumnWidth();
  setupTitleBar();
  setupLocalFileLoader();
  setupLoadButton();
  setupLoadDataDialog();
  setupRefreshButton();

  if (getConfiguredDataUrl()) {
    window.addEventListener("beforeunload", (e) => {
      if (hasUnsavedEdits) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  const dataUrl = getConfiguredDataUrl();

  if (dataUrl) {
    // When a remote URL is configured, always fetch it first so the hosted
    // page is always up-to-date. Fall back to cache only if the fetch fails
    // (e.g. offline).
    try {
      const raw = await loadTaskJsonFromUrl(dataUrl);
      initializeApp(raw);
      return;
    } catch (remoteError) {
      const cached = loadCachedTaskData();
      if (cached) {
        try {
          initializeApp(cached);
          return;
        } catch (cacheError) {
          // fall through to picker
        }
      }
    }
  } else {
    // No remote URL: prefer the local working copy so edits survive a reload
    // (file:// workflow).
    const cached = loadCachedTaskData();
    if (cached) {
      try {
        initializeApp(cached);
        return;
      } catch (cacheError) {
        // fall through to local data.json / picker
      }
    }

    try {
      const raw = await loadTaskJson();
      initializeApp(raw);
      return;
    } catch (error) {
      // fall through to picker
    }
  }

  const message = [
    dataUrl
      ? "Could not load task data from the configured URL."
      : "Could not load ./data.json automatically.",
    "Set dataUrl in settings.js, or choose a file with the picker below."
  ].join("\n");
  showRuntimeNotice(message);
  if (jsonOutput) {
    jsonOutput.textContent = message;
  }
}

function initializeApp(raw) {
  currentViewMode = "Month";
  hasAutoCenteredOnToday = false;
  hasUnsavedEdits = false;
  if (refreshDataButton && refreshDataButton.dataset.ready === "true") {
    refreshDataButton.disabled = true;
  }
  model.tasks = normalizeTasks(raw);
  model.topoOrder = topologicalSort(model.tasks);
  scheduleInitialDates(model.tasks, model.topoOrder);
  reindex();
  setupInteractionTracking();
  renderChart();
  renderJson();
  setupZoomControls();
  setupColumnWidthControls();
  setupRowHeightControls();
  setupDependencyControls();
  setupDownloadButton();
  setupLoadButton();
  setupRefreshButton();
  setupResetLayoutButton();
  setupDependencyHoverTracking();
  setupTaskModal();
  setupAddTaskButton();
  hideRuntimeNotice();
}

function centerChartOnToday(attempt = 0) {
  const svg = ganttContainer.querySelector("svg.gantt");
  if (!svg) {
    return;
  }

  const xInSvg = resolveTodayLineX(svg);
  if (!Number.isFinite(xInSvg)) {
    return;
  }

  const styles = getComputedStyle(ganttContainer);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const targetScrollLeft = paddingLeft + xInSvg - (ganttContainer.clientWidth / 2);
  const maxScrollLeft = Math.max(0, ganttContainer.scrollWidth - ganttContainer.clientWidth);

  if (maxScrollLeft === 0 && ganttContainer.scrollWidth <= ganttContainer.clientWidth + 1 && attempt < 3) {
    requestAnimationFrame(() => centerChartOnToday(attempt + 1));
    return;
  }

  ganttContainer.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));
}

async function loadTaskJson() {
  try {
    const response = await fetch("./data.json", { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      const parsed = parseTaskPayload(text);
      cacheTaskData(text);
      return parsed;
    }

    throw new Error(`Request failed with status ${response.status}`);
  } catch (error) {
    throw new Error(`Unable to load tasks from data.json: ${error.message}`);
  }
}

function getConfiguredDataUrl() {
  const settings = window.GANTT_SETTINGS;
  if (!settings || typeof settings.dataUrl !== "string") {
    return "";
  }
  return settings.dataUrl.trim();
}

function getConfiguredTitle() {
  const settings = window.GANTT_SETTINGS;
  if (!settings || typeof settings.title !== "string") {
    return "";
  }
  return settings.title.trim();
}

async function reloadSettingsScript() {
  const settingsScript = getSettingsScriptElement();
  if (!settingsScript || !settingsScript.parentNode) {
    return;
  }

  const baseSrc = settingsScript.getAttribute("src") || "./settings.js";
  const cacheBust = `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}t=${Date.now()}`;

  await new Promise((resolve, reject) => {
    const reloaded = document.createElement("script");
    reloaded.id = settingsScript.id;
    reloaded.src = cacheBust;

    reloaded.addEventListener("load", () => {
      settingsScript.remove();
      resolve();
    }, { once: true });

    reloaded.addEventListener("error", () => {
      reloaded.remove();
      reject(new Error(`Unable to reload settings from ${baseSrc}`));
    }, { once: true });

    settingsScript.parentNode.insertBefore(reloaded, settingsScript.nextSibling);
  });
}

async function loadTaskJsonFromUrl(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      const parsed = parseTaskPayload(text);
      cacheTaskData(text);
      return parsed;
    }

    throw new Error(`Request failed with status ${response.status}`);
  } catch (error) {
    throw new Error(`Unable to load tasks from ${url}: ${error.message}`);
  }
}

function cacheTaskData(text) {
  try {
    localStorage.setItem("ganttDataCache", text);
  } catch (error) {
    // localStorage not available
  }
}

function setupTitleBar(forceFromSettings = false) {
  if (!appTitleInput) {
    return;
  }

  const defaultTitle = getConfiguredTitle()
    || appTitleInput.value
    || "Project Timeline";

  if (forceFromSettings) {
    appTitleInput.value = defaultTitle;
    document.title = defaultTitle;
    return;
  }

  if (appTitleInput.dataset.ready === "true") {
    return;
  }

  appTitleInput.value = defaultTitle;
  try {
    const stored = localStorage.getItem("ganttTitle");
    if (stored !== null) {
      appTitleInput.value = stored;
    }
  } catch (error) {
    // localStorage not available, keep default
  }

  const persist = () => {
    const value = appTitleInput.value.trim() || defaultTitle;
    appTitleInput.value = value;
    document.title = value;
    try {
      localStorage.setItem("ganttTitle", value);
    } catch (error) {
      // localStorage not available
    }
  };

  document.title = appTitleInput.value.trim() || defaultTitle;
  appTitleInput.addEventListener("change", persist);
  appTitleInput.addEventListener("blur", persist);
  appTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      appTitleInput.blur();
    }
  });

  appTitleInput.dataset.ready = "true";
}

function loadCachedTaskData() {
  try {
    const stored = localStorage.getItem("ganttDataCache");
    if (!stored) {
      return null;
    }
    return parseTaskPayload(stored);
  } catch (error) {
    return null;
  }
}

function setupLocalFileLoader() {
  if (localFileLoaderReady || !localDataFileInput) {
    return;
  }

  localDataFileInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const raw = parseTaskPayload(text);
      cacheTaskData(text);
      initializeApp(raw);
      localDataFileInput.value = "";
    } catch (error) {
      showRuntimeNotice([
        "Could not read the selected task file.",
        error.message,
        "Choose the data.json file from this folder or run a local server instead."
      ].join("\n"));
      console.error(error);
    }
  });

  localFileLoaderReady = true;
}

function showRuntimeNotice(message) {
  if (runtimeMessage) {
    runtimeMessage.textContent = message;
  }

  if (runtimeNotice) {
    runtimeNotice.hidden = false;
  }
}

function hideRuntimeNotice() {
  if (runtimeNotice) {
    runtimeNotice.hidden = true;
  }
}

function parseTaskPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Task payload is empty.");
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (jsonError) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("Task payload is empty.");
    }

    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (lineError) {
        throw new Error(`Invalid JSON record on line ${index + 1}: ${lineError.message}`);
      }
    });
  }
}

function normalizeTasks(rawTasks) {
  return rawTasks.map((task) => {
    const sourceId = task.ID ?? task.id;
    const id = String(sourceId);
    const startMs = normalizeTimestamp(task.start ?? task.startMs);
    const endMs = normalizeTimestamp(task.end ?? task.endMs);
    const durationDays = resolveDurationDays(task, startMs, endMs);

    return {
      id,
      sourceId,
      name: task.Title ?? task.name ?? id,
      description: task.Description ?? null,
      assignee: task.Assignee ?? null,
      durationDays,
      dependencies: normalizeIdList(task["Blocked by"] ?? task.dependencies),
      blocking: normalizeIdList(task.Blocking),
      progress: normalizeProgress(task.progress),
      group: task.group ?? null,
      milestone: task.milestone === true || task.milestone === "true",
      dependents: [],
      startMs,
      endMs
    };
  });
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const timestamp = Number(value);
  if (Number.isFinite(timestamp)) {
    return floorToDay(new Date(timestamp)).getTime();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return floorToDay(parsed).getTime();
  }

  return 0;
}

function resolveDurationDays(task, startMs, endMs) {
  const explicitDays = Number(task.time);
  if (Number.isFinite(explicitDays) && explicitDays > 0) {
    return Math.max(1, Math.round(explicitDays));
  }

  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    return Math.max(1, Math.round((endMs - startMs) / DAY_MS));
  }

  if (task.duration !== undefined) {
    return parseDurationDays(task.duration);
  }

  return 1;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry !== null && entry !== undefined && entry !== "")
    .map((entry) => String(entry));
}

function normalizeProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) {
    return 0;
  }

  return Math.max(0, Math.min(100, progress));
}

function parseDurationDays(text) {
  const value = String(text || "").trim().toLowerCase();
  const match = value.match(/^(\d+)\s*(day|days|week|weeks)$/);
  if (!match) {
    throw new Error(`Unsupported duration format: ${text}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  return unit.startsWith("week") ? amount * 7 : amount;
}

function topologicalSort(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map();
  const children = new Map();

  for (const task of tasks) {
    indegree.set(task.id, 0);
    children.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`Task ${task.id} has missing dependency ${dep}`);
      }
      indegree.set(task.id, indegree.get(task.id) + 1);
      children.get(dep).push(task.id);
    }
  }

  const queue = [];
  for (const [id, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const ordered = [];
  while (queue.length > 0) {
    const id = queue.shift();
    ordered.push(id);
    for (const childId of children.get(id)) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) {
        queue.push(childId);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error("Circular dependency found in task graph");
  }

  return ordered;
}

function scheduleInitialDates(tasks, topoOrder) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const explicitStarts = tasks
    .map((task) => task.startMs)
    .filter((startMs) => Number.isFinite(startMs) && startMs > 0);
  const baseStartMs = explicitStarts.length > 0
    ? Math.min(...explicitStarts)
    : floorToDay(new Date()).getTime();

  for (const id of topoOrder) {
    const task = byId.get(id);
    const hasExplicitDates = Number.isFinite(task.startMs)
      && Number.isFinite(task.endMs)
      && task.endMs > task.startMs;

    if (hasExplicitDates) {
      task.durationDays = Math.max(1, Math.round((task.endMs - task.startMs) / DAY_MS));
      continue;
    }

    const earliestStart = task.dependencies.length
      ? Math.max(...task.dependencies.map((depId) => byId.get(depId).endMs))
      : baseStartMs;

    task.startMs = earliestStart;
    task.endMs = earliestStart + task.durationDays * DAY_MS;
  }
}

function reindex() {
  model.byId = new Map(model.tasks.map((task) => [task.id, task]));
  for (const task of model.tasks) {
    task.dependents = [];
  }
  for (const task of model.tasks) {
    for (const depId of task.dependencies) {
      model.byId.get(depId).dependents.push(task.id);
    }
  }
}

function buildGroups() {
  const groups = new Map();
  for (const task of model.tasks) {
    if (!task.group) continue;
    if (!groups.has(task.group)) {
      groups.set(task.group, { tasks: [], startMs: Infinity, endMs: -Infinity });
    }
    const g = groups.get(task.group);
    g.tasks.push(task);
    if (task.startMs < g.startMs) g.startMs = task.startMs;
    if (task.endMs > g.endMs) g.endMs = task.endMs;
  }
  return groups;
}

function buildVisibleTasks() {
  const groups = buildGroups();
  const orderedGroupNames = [];
  const seenGroups = new Set();
  for (const task of model.tasks) {
    if (task.group && !seenGroups.has(task.group)) {
      seenGroups.add(task.group);
      orderedGroupNames.push(task.group);
    }
  }

  const result = [];
  for (const groupName of orderedGroupNames) {
    const group = groups.get(groupName);
    const collapsed = model.collapsedGroups.has(groupName);
    result.push({
      id: `__group__${groupName}`,
      name: (collapsed ? "▶ " : "▼ ") + groupName,
      startMs: group.startMs,
      endMs: group.endMs,
      progress: 0,
      dependencies: [],
      blocking: [],
      dependents: [],
      isGroupHeader: true,
      groupName
    });
    if (!collapsed) {
      result.push(...group.tasks.slice().sort((a, b) => a.startMs - b.startMs));
    }
  }
  for (const task of model.tasks) {
    if (!task.group) result.push(task);
  }
  return result;
}

function generateNewTaskId() {
  let maxNum = 0;
  let hasNumeric = false;
  for (const t of model.tasks) {
    const n = Number(t.sourceId);
    if (Number.isFinite(n) && String(n) === String(t.sourceId)) {
      hasNumeric = true;
      if (n > maxNum) maxNum = n;
    }
  }
  if (hasNumeric) {
    return maxNum + 1;
  }
  const existing = new Set(model.tasks.map((t) => String(t.id)));
  let i = 1;
  while (existing.has(`task-${i}`)) i++;
  return `task-${i}`;
}

function addTaskToGroup(groupName) {
  const group = buildGroups().get(groupName);
  const startMs = group && Number.isFinite(group.startMs) && group.startMs !== Infinity
    ? group.startMs
    : floorToDay(new Date()).getTime();
  const durationDays = 7;
  const sourceId = generateNewTaskId();
  const id = String(sourceId);

  model.tasks.push({
    id,
    sourceId,
    name: "New task",
    description: null,
    assignee: null,
    durationDays,
    dependencies: [],
    blocking: [],
    progress: 0,
    group: groupName,
    milestone: false,
    dependents: [],
    startMs,
    endMs: startMs + durationDays * DAY_MS
  });

  // Make sure the group is expanded so the new task is visible.
  model.collapsedGroups.delete(groupName);

  reindex();
  renderChart();
  renderJson();
  markUnsavedEdits();
}

function addNewTask() {
  const startMs = floorToDay(new Date()).getTime();
  const durationDays = 7;
  const sourceId = generateNewTaskId();
  const id = String(sourceId);

  model.tasks.push({
    id,
    sourceId,
    name: "New task",
    description: null,
    assignee: null,
    durationDays,
    dependencies: [],
    blocking: [],
    progress: 0,
    group: null,
    milestone: false,
    dependents: [],
    startMs,
    endMs: startMs + durationDays * DAY_MS
  });

  reindex();
  renderChart();
  renderJson();
  markUnsavedEdits();
  openTaskModal(id);
}

function setupAddTaskButton() {
  if (!addTaskButton || addTaskButton.dataset.ready === "true") {
    return;
  }
  addTaskButton.addEventListener("click", () => {
    const settingsDrawer = document.querySelector(".settings-drawer");
    if (settingsDrawer) settingsDrawer.open = false;
    addNewTask();
  });
  addTaskButton.dataset.ready = "true";
}

function floorToDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateToMs(date) {
  return floorToDay(date).getTime();
}

function msToDateString(ms) {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toChartTask(task) {
  return {
    id: task.id,
    name: task.name,
    start: msToDateString(task.startMs),
    end: msToDateString(task.endMs),
    progress: task.progress,
    dependencies: task.dependencies.join(",")
  };
}

function getTaskSidebarWidth() {
  if (taskSidebarCollapsed) {
    return SIDEBAR_COLLAPSED_WIDTH;
  }

  if (Number.isFinite(model.sidebarWidth) && model.sidebarWidth > 0) {
    return model.sidebarWidth;
  }

  return getAutoSidebarExpandedWidth();
}

function getAutoSidebarExpandedWidth() {
  const w = model.columnWidths;
  const columnsTotal = w.id + w.task + w.assignee + w.startDate + w.endDate + w.progress;
  const horizontalPadding = 62; // matches header/row left + right padding used for grid content
  const borderAllowance = 6;
  return Math.max(SIDEBAR_EXPANDED_WIDTH, columnsTotal + horizontalPadding + borderAllowance);
}

function loadColumnWidths() {
  try {
    const stored = localStorage.getItem('ganttColumnWidths');
    if (stored) {
      const parsed = JSON.parse(stored);
      model.columnWidths = { ...model.columnWidths, ...parsed };
    }
  } catch (e) {
    // localStorage not available, use defaults
  }
}

function saveColumnWidths() {
  try {
    localStorage.setItem('ganttColumnWidths', JSON.stringify(model.columnWidths));
  } catch (e) {
    // localStorage not available
  }
}

function loadSidebarWidth() {
  try {
    const stored = localStorage.getItem('ganttSidebarWidth');
    if (!stored) {
      return;
    }
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed >= 220 && parsed <= 1600) {
      model.sidebarWidth = parsed;
    }
  } catch (e) {
    // localStorage not available, use defaults
  }
}

function saveSidebarWidth() {
  try {
    if (Number.isFinite(model.sidebarWidth) && model.sidebarWidth > 0) {
      localStorage.setItem('ganttSidebarWidth', String(Math.round(model.sidebarWidth)));
    }
  } catch (e) {
    // localStorage not available
  }
}

function getColumnGridTemplate() {
  const w = model.columnWidths;
  return `${w.id}px ${w.task}px ${w.assignee}px ${w.startDate}px ${w.endDate}px ${w.progress}px`;
}

function applyChartInsets() {
  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  if (!chartPanel) {
    return;
  }

  chartPanel.style.setProperty("--task-sidebar-width", `${getTaskSidebarWidth()}px`);
}

function formatSidebarDate(ms) {
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}

function renderGroupHeaderSidebarRow(task) {
  const arrow = model.collapsedGroups.has(task.groupName) ? "▶" : "▼";
  if (taskSidebarCollapsed) {
    return [
      `<div class="task-sidebar-row task-sidebar-row--group task-sidebar-row--collapsed" data-group="${task.groupName}" title="${task.groupName}">`,
      `<div class="task-sidebar-cell">${arrow}</div>`,
      `</div>`
    ].join("");
  }
  return [
    `<div class="task-sidebar-row task-sidebar-row--group" data-group="${task.groupName}" style="grid-template-columns: ${getColumnGridTemplate()}">`,
    `<div class="task-sidebar-cell task-sidebar-cell--id">${arrow}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--task task-sidebar-cell--group-name">${task.groupName}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--assignee"></div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date">${formatSidebarDate(task.startMs)}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date">${formatSidebarDate(task.endMs)}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--progress"><button class="group-add-task" type="button" title="Add task to ${task.groupName}" aria-label="Add task to ${task.groupName}" data-add-group="${task.groupName}">+</button></div>`,
    `</div>`
  ].join("");
}

function renderTaskSidebarRow(task) {
  if (task.isGroupHeader) {
    return renderGroupHeaderSidebarRow(task);
  }
  if (taskSidebarCollapsed) {
    return [
      `<div class="task-sidebar-row task-sidebar-row--collapsed" title="${task.name}">`,
      `<div class="task-sidebar-cell task-sidebar-cell--id">${task.id}</div>`,
      `</div>`
    ].join("");
  }

  return [
    `<div class="task-sidebar-row" data-task-id="${task.id}" style="grid-template-columns: ${getColumnGridTemplate()}">`,
    `<div class="task-sidebar-cell task-sidebar-cell--id">${task.id}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--task" title="${task.name}"><input class="task-sidebar-input" data-field="name" type="text" value="${task.name}"></div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--assignee" title="${task.assignee || "Unassigned"}"><input class="task-sidebar-input" data-field="assignee" type="text" value="${task.assignee || ""}" placeholder="Unassigned"></div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date"><input class="task-sidebar-input" data-field="startMs" type="date" value="${msToDateString(task.startMs)}"></div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date"><input class="task-sidebar-input" data-field="endMs" type="date" value="${msToDateString(task.endMs)}"></div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--progress"><input class="task-sidebar-input" data-field="progress" type="number" min="0" max="100" step="1" value="${task.progress}"></div>`,
    `</div>`
  ].join("");
}

function createTaskSidebar() {
  if (taskSidebarCleanup) {
    taskSidebarCleanup();
  }

  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  if (!chartPanel) {
    return;
  }

  const styles = getComputedStyle(ganttContainer);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const panelRect = chartPanel.getBoundingClientRect();
  const ganttRect = ganttContainer.getBoundingClientRect();
  const baseLeft = ganttRect.left - panelRect.left;
  const baseTop = ganttRect.top - panelRect.top + paddingTop;
  const sidebarHeight = Math.max(180, ganttContainer.clientHeight - paddingTop);

  const sidebar = document.createElement("aside");
  sidebar.className = `task-sidebar${taskSidebarCollapsed ? " is-collapsed" : ""}`;
  sidebar.style.width = `${getTaskSidebarWidth()}px`;
  sidebar.style.height = `${sidebarHeight}px`;
  sidebar.setAttribute("aria-label", "Task details sidebar");
  // Offset the sidebar up by its top border so its inner content (header + rows)
  // shares the chart's coordinate system and rows align with the chart grid rows.
  // (Actual border width is read after the element is in the DOM.)
  let sidebarTop = baseTop;

  const columns = taskSidebarCollapsed
    ? `<div class="task-sidebar-columns task-sidebar-columns--collapsed"><span>ID</span></div>`
    : [
        `<div class="task-sidebar-columns" style="grid-template-columns: ${getColumnGridTemplate()}">`,
        `<span>ID</span>`,
        `<span>Task</span>`,
        `<span>Owner</span>`,
        `<span>Start</span>`,
        `<span>End</span>`,
        `<span>%</span>`,
        `</div>`
      ].join("");

  sidebar.innerHTML = [
    `<div class="task-sidebar-header">`,
    columns,
    `<button class="task-sidebar-toggle" type="button" aria-expanded="${String(!taskSidebarCollapsed)}" aria-label="${taskSidebarCollapsed ? "Expand" : "Collapse"} task sidebar">${taskSidebarCollapsed ? "»" : "«"}</button>`,
    `</div>`,
    `<div class="task-sidebar-body">`,
    `<div class="task-sidebar-rows">${buildVisibleTasks().map(renderTaskSidebarRow).join("")}</div>`,
    `</div>`
  ].join("");

  chartPanel.appendChild(sidebar);

  // Now that the sidebar is in the DOM, account for its top border so the inner
  // content coordinate system matches the chart grid.
  const sidebarBorderTop = parseFloat(getComputedStyle(sidebar).borderTopWidth) || 0;
  sidebarTop = baseTop - sidebarBorderTop;

  let boundaryResizer = null;
  if (!taskSidebarCollapsed) {
    boundaryResizer = document.createElement("div");
    boundaryResizer.className = "task-sidebar-boundary-resizer";
    boundaryResizer.setAttribute("title", "Resize sidebar");
    sidebar.appendChild(boundaryResizer);
  }

  const rows = sidebar.querySelector(".task-sidebar-rows");
  const toggle = sidebar.querySelector(".task-sidebar-toggle");
  const columnsHeader = sidebar.querySelector(".task-sidebar-columns");
  const syncSidebar = () => {
    sidebar.style.transform = `translate(${baseLeft}px, ${sidebarTop}px)`;
    if (rows) {
      rows.style.transform = `translateY(${-ganttContainer.scrollTop}px)`;
    }
  };

  ganttContainer.addEventListener("scroll", syncSidebar, { passive: true });
  toggle?.addEventListener("click", () => {
    taskSidebarCollapsed = !taskSidebarCollapsed;
    renderChart();
  });

  sidebar.addEventListener("click", (e) => {
    const addBtn = e.target.closest(".group-add-task[data-add-group]");
    if (addBtn) {
      e.stopPropagation();
      addTaskToGroup(addBtn.dataset.addGroup);
      return;
    }

    const groupRow = e.target.closest(".task-sidebar-row--group[data-group]");
    if (!groupRow) return;
    const groupName = groupRow.dataset.group;
    if (model.collapsedGroups.has(groupName)) {
      model.collapsedGroups.delete(groupName);
    } else {
      model.collapsedGroups.add(groupName);
    }
    renderChart();
  });

  sidebar.addEventListener("change", (e) => {
    const input = e.target.closest(".task-sidebar-input");
    if (!input) {
      return;
    }

    const row = input.closest(".task-sidebar-row[data-task-id]");
    if (!row) {
      return;
    }

    const taskId = row.dataset.taskId;
    if (!taskId || taskId.startsWith("__group__")) {
      return;
    }

    const task = model.byId.get(taskId);
    if (!task) {
      return;
    }

    const field = input.dataset.field;
    if (!field) {
      return;
    }

    if (field === "name") {
      task.name = String(input.value || task.id).trim() || task.id;
      renderChart();
      renderJson();
      markUnsavedEdits();
      return;
    }

    if (field === "assignee") {
      const assignee = String(input.value || "").trim();
      task.assignee = assignee || null;
      renderChart();
      renderJson();
      markUnsavedEdits();
      return;
    }

    if (field === "progress") {
      task.progress = normalizeProgress(input.value);
      renderChart();
      renderJson();
      markUnsavedEdits();
      return;
    }

    if (field === "startMs" || field === "endMs") {
      const valueMs = normalizeTimestamp(input.value);
      if (!Number.isFinite(valueMs) || valueMs <= 0) {
        renderChart();
        return;
      }

      const nextStart = field === "startMs" ? valueMs : task.startMs;
      const nextEnd = field === "endMs" ? valueMs : task.endMs;

      handleDateChange(task.id, nextStart, nextEnd);
    }
  });

  // Setup column resize handlers
  if (columnsHeader && !taskSidebarCollapsed) {
    const columnPairs = [
      ["id", "task"],
      ["task", "assignee"],
      ["assignee", "startDate"],
      ["startDate", "endDate"],
      ["endDate", "progress"]
    ];

    const updateResizerPositions = () => {
      const w = model.columnWidths;
      const positions = {
        "id-task": w.id,
        "task-assignee": w.id + w.task,
        "assignee-startDate": w.id + w.task + w.assignee,
        "startDate-endDate": w.id + w.task + w.assignee + w.startDate,
        "endDate-progress": w.id + w.task + w.assignee + w.startDate + w.endDate
      };
      for (const [pair, pos] of Object.entries(positions)) {
        const resizer = columnsHeader.querySelector(`[data-column="${pair}"]`);
        if (resizer) {
          resizer.style.left = `${pos}px`;
        }
      }
    };

    // Create resizers as overlays
    for (const [leftCol, rightCol] of columnPairs) {
      const resizer = document.createElement("div");
      resizer.className = "column-resizer";
      resizer.setAttribute("data-column", `${leftCol}-${rightCol}`);
      columnsHeader.appendChild(resizer);

      resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startLeftWidth = model.columnWidths[leftCol];
        const startRightWidth = model.columnWidths[rightCol];

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          const newLeftWidth = Math.max(40, startLeftWidth + deltaX);
          const newRightWidth = Math.max(40, startRightWidth - deltaX);

          model.columnWidths[leftCol] = newLeftWidth;
          model.columnWidths[rightCol] = newRightWidth;
          saveColumnWidths();

          const gridTemplate = getColumnGridTemplate();

          // Update header columns
          columnsHeader.style.gridTemplateColumns = gridTemplate;

          // Update all task rows in the sidebar
          const allRows = sidebar.querySelectorAll(".task-sidebar-row");
          for (const row of allRows) {
            row.style.gridTemplateColumns = gridTemplate;
          }

          updateResizerPositions();

          if (!Number.isFinite(model.sidebarWidth)) {
            const autoWidth = getAutoSidebarExpandedWidth();
            sidebar.style.width = `${autoWidth}px`;
            applyChartInsets();
            syncSidebar();
          }
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          resizer.style.opacity = "";
        };

        resizer.style.opacity = "1";
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      resizer.addEventListener("mouseenter", () => {
        resizer.style.opacity = "0.8";
      });

      resizer.addEventListener("mouseleave", () => {
        resizer.style.opacity = "";
      });
    }

    updateResizerPositions();
  }

  if (boundaryResizer) {
    boundaryResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = getTaskSidebarWidth();

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const minWidth = 220;
        const maxWidth = Math.max(500, window.innerWidth - 140);
        const nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        model.sidebarWidth = nextWidth;
        saveSidebarWidth();
        sidebar.style.width = `${nextWidth}px`;
        applyChartInsets();
        syncSidebar();
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        renderChart();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  syncSidebar();

  const onSidebarWheel = (e) => {
    ganttContainer.scrollTop += e.deltaY;
    ganttContainer.scrollLeft += e.deltaX;
    e.preventDefault();
  };
  sidebar.addEventListener("wheel", onSidebarWheel, { passive: false });

  taskSidebarCleanup = () => {
    ganttContainer.removeEventListener("scroll", syncSidebar);
    sidebar.removeEventListener("wheel", onSidebarWheel);
    sidebar.remove();
    taskSidebarCleanup = null;
  };
}

function createStickyTimelineHeader() {
  if (stickyTimelineCleanup) {
    stickyTimelineCleanup();
  }

  const wrapper = ganttContainer.querySelector(".gantt-container");
  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  const svg = wrapper && wrapper.querySelector("svg.gantt");
  const grid = svg && svg.querySelector("g.grid");
  const dateGroup = svg && svg.querySelector("g.date");
  const gridHeader = grid && grid.querySelector(".grid-header");

  if (!wrapper || !chartPanel || !svg || !grid || !dateGroup || !gridHeader) {
    return;
  }

  const width = Number(svg.getAttribute("width")) || svg.clientWidth;
  // Use the first grid-row's Y (where row backgrounds start) so the sticky timeline
  // bottom aligns with the sidebar header bottom and the chart's grid rows.
  const firstGridRow = grid.querySelector(".grid-row");
  const headerHeight = (firstGridRow ? Number(firstGridRow.getAttribute("y")) : 0)
    || Number(gridHeader.getAttribute("height"))
    || GANTT_HEADER_HEIGHT;
  if (!width || !headerHeight) {
    return;
  }

  const styles = getComputedStyle(ganttContainer);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const panelRect = chartPanel.getBoundingClientRect();
  const ganttRect = ganttContainer.getBoundingClientRect();
  const baseLeft = ganttRect.left - panelRect.left + paddingLeft;
  const baseTop = ganttRect.top - panelRect.top + paddingTop;

  const stickyHost = document.createElement("div");
  stickyHost.classList.add("gantt-sticky-header");
  stickyHost.setAttribute("aria-hidden", "true");
  stickyHost.style.width = `${width}px`;
  stickyHost.style.height = `${headerHeight}px`;

  const stickySvg = document.createElementNS(SVG_NS, "svg");
  stickySvg.classList.add("gantt");
  stickySvg.setAttribute("width", String(width));
  stickySvg.setAttribute("height", String(headerHeight));
  stickySvg.setAttribute("viewBox", `0 0 ${width} ${headerHeight}`);
  stickySvg.style.overflow = "hidden";

  const stickyGrid = document.createElementNS(SVG_NS, "g");
  stickyGrid.classList.add("sticky-grid");

  for (const node of grid.querySelectorAll(".grid-header, .tick, .today-highlight")) {
    stickyGrid.appendChild(node.cloneNode(true));
  }

  stickySvg.appendChild(stickyGrid);
  stickySvg.appendChild(dateGroup.cloneNode(true));
  stickyHost.appendChild(stickySvg);
  chartPanel.appendChild(stickyHost);

  dateGroup.style.visibility = "hidden";

  const syncPosition = () => {
    stickyHost.style.transform = `translate(${baseLeft - ganttContainer.scrollLeft}px, ${baseTop}px)`;
  };

  ganttContainer.addEventListener("scroll", syncPosition, { passive: true });
  syncPosition();

  stickyTimelineCleanup = () => {
    ganttContainer.removeEventListener("scroll", syncPosition);
    stickyHost.remove();
    stickyTimelineCleanup = null;
  };
}

function resolveTodayLineX(svg) {
  const nativeToday = svg.querySelector(".today-highlight");
  if (nativeToday) {
    const x1 = Number(nativeToday.getAttribute("x1"));
    const x2 = Number(nativeToday.getAttribute("x2"));
    if (Number.isFinite(x1) && Number.isFinite(x2)) {
      return (x1 + x2) / 2;
    }
  }

  // Derive an exact date->x transform from rendered task bars.
  // This stays accurate across Day/Week/Month because it uses the live chart geometry.
  const points = [];
  for (const wrapper of svg.querySelectorAll(".bar-wrapper[data-id]")) {
    const id = wrapper.getAttribute("data-id");
    const bar = wrapper.querySelector("rect.bar");
    const x = bar ? Number(bar.getAttribute("x")) : NaN;
    const task = id ? model.byId.get(String(id)) : null;
    if (!task || !Number.isFinite(task.startMs) || !Number.isFinite(x)) {
      continue;
    }
    points.push({ ms: task.startMs, x });
  }

  if (points.length >= 2) {
    let sumMs = 0;
    let sumX = 0;
    for (const point of points) {
      sumMs += point.ms;
      sumX += point.x;
    }

    const meanMs = sumMs / points.length;
    const meanX = sumX / points.length;
    let num = 0;
    let den = 0;
    for (const point of points) {
      const dMs = point.ms - meanMs;
      num += dMs * (point.x - meanX);
      den += dMs * dMs;
    }

    if (den > 0 && Number.isFinite(num)) {
      const slope = num / den;
      const intercept = meanX - slope * meanMs;
      const todayMs = floorToDay(new Date()).getTime();
      const projectedX = slope * todayMs + intercept;
      if (Number.isFinite(projectedX)) {
        return projectedX;
      }
    }
  }

  const today = floorToDay(new Date());
  const currentYear = String(today.getFullYear());
  const currentMonthName = new Intl.DateTimeFormat("en", { month: "long" }).format(today);
  const dayOfMonth = today.getDate();

  if (currentViewMode === "Month") {
    const yearLabels = Array.from(svg.querySelectorAll(".upper-text")).map((label) => ({
      year: (label.textContent || "").trim(),
      x: Number(label.getAttribute("x"))
    })).filter((entry) => Number.isFinite(entry.x));

    const monthLabels = Array.from(svg.querySelectorAll(".lower-text")).map((label, index) => ({
      index,
      month: (label.textContent || "").trim(),
      x: Number(label.getAttribute("x"))
    })).filter((entry) => Number.isFinite(entry.x));

    const monthMatches = monthLabels.filter((entry) => entry.month === currentMonthName);
    let activeMonth = null;

    for (const match of monthMatches) {
      const nearestYear = yearLabels
        .map((yearEntry) => ({ year: yearEntry.year, distance: Math.abs(yearEntry.x - match.x) }))
        .sort((a, b) => a.distance - b.distance)[0];

      if (nearestYear && nearestYear.year === currentYear) {
        activeMonth = match;
        break;
      }
    }

    if (activeMonth) {
      const nextMonth = monthLabels.find((entry) => entry.index > activeMonth.index);
      const prevMonth = [...monthLabels].reverse().find((entry) => entry.index < activeMonth.index);
      const monthSpan = nextMonth
        ? (nextMonth.x - activeMonth.x)
        : (prevMonth ? (activeMonth.x - prevMonth.x) : 120);
      const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      const ratio = (dayOfMonth - 1) / Math.max(1, daysInMonth);
      return activeMonth.x + monthSpan * ratio;
    }
  }

  const minStart = Math.min(...model.tasks.map((task) => task.startMs));
  const maxEnd = Math.max(...model.tasks.map((task) => task.endMs));
  const rangeMs = Math.max(1, maxEnd - minStart);
  const clampedToday = Math.max(minStart, Math.min(today.getTime(), maxEnd));
  const ratio = (clampedToday - minStart) / rangeMs;
  const svgWidth = Number(svg.getAttribute("width")) || svg.clientWidth;
  return ratio * svgWidth;
}

function createCustomTodayLine() {
  if (customTodayLineCleanup) {
    customTodayLineCleanup();
  }

  if (currentViewMode === "Day") {
    return;
  }

  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  const svg = ganttContainer.querySelector("svg.gantt");
  if (!chartPanel || !svg) {
    return;
  }

  const xInSvg = resolveTodayLineX(svg);
  if (!Number.isFinite(xInSvg)) {
    return;
  }

  const styles = getComputedStyle(ganttContainer);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const panelRect = chartPanel.getBoundingClientRect();
  const ganttRect = ganttContainer.getBoundingClientRect();
  const baseLeft = ganttRect.left - panelRect.left + paddingLeft;
  const baseTop = ganttRect.top - panelRect.top + paddingTop;

  const marker = document.createElement("div");
  marker.className = "gantt-custom-today";
  const svgHeight = Number(svg.getAttribute("height")) || ganttContainer.scrollHeight;
  marker.style.height = `${Math.max(80, svgHeight - GANTT_HEADER_HEIGHT)}px`;
  chartPanel.appendChild(marker);

  const syncMarker = () => {
    const x = baseLeft - ganttContainer.scrollLeft + xInSvg;
    marker.style.transform = `translate(${x}px, ${baseTop + GANTT_HEADER_HEIGHT}px)`;
  };

  ganttContainer.addEventListener("scroll", syncMarker, { passive: true });
  syncMarker();

  customTodayLineCleanup = () => {
    ganttContainer.removeEventListener("scroll", syncMarker);
    marker.remove();
    customTodayLineCleanup = null;
  };
}

function createMilestoneLines() {
  if (milestoneLinesCleanup) {
    milestoneLinesCleanup();
  }

  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  const svg = ganttContainer.querySelector("svg.gantt");
  if (!chartPanel || !svg) {
    return;
  }

  // Build the same date→x linear model used by resolveTodayLineX.
  const points = [];
  for (const wrapper of svg.querySelectorAll(".bar-wrapper[data-id]")) {
    const id = wrapper.getAttribute("data-id");
    const bar = wrapper.querySelector("rect.bar");
    const x = bar ? Number(bar.getAttribute("x")) : NaN;
    const task = id ? model.byId.get(String(id)) : null;
    if (!task || !Number.isFinite(task.startMs) || !Number.isFinite(x)) {
      continue;
    }
    points.push({ ms: task.startMs, x });
  }

  if (points.length < 2) {
    return;
  }

  let sumMs = 0, sumX = 0;
  for (const p of points) { sumMs += p.ms; sumX += p.x; }
  const meanMs = sumMs / points.length;
  const meanX = sumX / points.length;
  let num = 0, den = 0;
  for (const p of points) {
    const dMs = p.ms - meanMs;
    num += dMs * (p.x - meanX);
    den += dMs * dMs;
  }
  if (den === 0) return;
  const slope = num / den;
  const intercept = meanX - slope * meanMs;

  const milestones = model.tasks.filter((t) => t.milestone);
  if (milestones.length === 0) return;

  const styles = getComputedStyle(ganttContainer);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const panelRect = chartPanel.getBoundingClientRect();
  const ganttRect = ganttContainer.getBoundingClientRect();
  const baseLeft = ganttRect.left - panelRect.left + paddingLeft;
  const baseTop = ganttRect.top - panelRect.top + paddingTop;
  const svgHeight = Number(svg.getAttribute("height")) || ganttContainer.scrollHeight;
  const lineHeight = Math.max(80, svgHeight - GANTT_HEADER_HEIGHT);

  const markers = milestones.map((task) => {
    const xInSvg = slope * task.endMs + intercept;
    const line = document.createElement("div");
    line.className = "gantt-milestone-line";
    line.title = task.name;
    line.style.height = `${lineHeight}px`;
    chartPanel.appendChild(line);

    // Mark the bar wrapper in the SVG for CSS styling.
    const barWrapper = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (barWrapper) {
      barWrapper.classList.add("is-milestone");
    }

    return { line, xInSvg };
  });

  const syncAll = () => {
    for (const { line, xInSvg } of markers) {
      const x = baseLeft - ganttContainer.scrollLeft + xInSvg;
      line.style.transform = `translate(${x}px, ${baseTop + GANTT_HEADER_HEIGHT}px)`;
    }
  };

  ganttContainer.addEventListener("scroll", syncAll, { passive: true });
  syncAll();

  milestoneLinesCleanup = () => {
    ganttContainer.removeEventListener("scroll", syncAll);
    for (const { line } of markers) line.remove();
    milestoneLinesCleanup = null;
  };
}

function renderChart(forceCenterToday = false) {
  if (stickyTimelineCleanup) {
    stickyTimelineCleanup();
  }

  if (taskSidebarCleanup) {
    taskSidebarCleanup();
  }

  if (customTodayLineCleanup) {
    customTodayLineCleanup();
  }

  if (milestoneLinesCleanup) {
    milestoneLinesCleanup();
  }

  applyChartInsets();

  // Save scroll position
  const scrollLeft = ganttContainer.scrollLeft;
  const scrollTop = ganttContainer.scrollTop;
  ganttContainer.innerHTML = "";
  const visibleTasks = buildVisibleTasks();
  const isEmptyChart = visibleTasks.length === 0;
  const todayMs = floorToDay(new Date()).getTime();
  const chartTasks = isEmptyChart
    ? [{
        id: "__placeholder__",
        name: "",
        start: msToDateString(todayMs),
        end: msToDateString(todayMs + 7 * DAY_MS),
        progress: 0
      }]
    : visibleTasks.map(toChartTask);
  model.gantt = new Gantt("#gantt", chartTasks, {
    view_mode: currentViewMode,
    bar_height: Math.max(8, currentRowHeight - 12),
    padding: Math.round((currentRowHeight - Math.max(8, currentRowHeight - 12)) / 2),
    column_width: getActiveGanttColumnWidth(),
    date_format: "YYYY-MM-DD",
    custom_popup_html: () => "<div></div>",
    on_date_change: (task, start, end) => {
      if (task.id.startsWith("__group__") || task.id === "__placeholder__") return;
      handleDateChange(task.id, dateToMs(start), dateToMs(end));
    }
  });

  // An empty chart still needs a valid Frappe render; hide the placeholder row.
  if (isEmptyChart && model.gantt.$svg) {
    const placeholder = model.gantt.$svg.querySelector('.bar-wrapper[data-id="__placeholder__"]');
    if (placeholder) placeholder.style.display = "none";
  }

  // Frappe 0.6.1 resets column_width from view_mode defaults internally.
  applyCustomGanttColumnWidth();

  // Sync sidebar row height and header offset with actual Frappe layout.
  {
    const firstGridRow = model.gantt.$svg && model.gantt.$svg.querySelector('.grid-row');
    const ganttRowH = firstGridRow ? Number(firstGridRow.getAttribute('height')) : null;
    // Use the grid-row start Y (row backgrounds) so sidebar rows align with chart rows.
    // Bars are inset within each row by padding/2, which is correct.
    const ganttRowsY = firstGridRow ? Number(firstGridRow.getAttribute('y')) : null;
    if (ganttRowH) document.documentElement.style.setProperty('--gantt-row-height', ganttRowH + 'px');
    if (ganttRowsY !== null) document.documentElement.style.setProperty('--gantt-sidebar-header-h', ganttRowsY + 'px');

    // Frappe 0.6.1 draws the .grid-header background rect as header_height + 10,
    // which extends past where the first bar starts (header_height + padding).
    // Shrink it to the grid-row start Y so the first bar never sits behind it.
    if (ganttRowsY !== null) {
      const gridHeaderRect = model.gantt.$svg.querySelector('.grid-header');
      if (gridHeaderRect) {
        gridHeaderRect.setAttribute('height', String(ganttRowsY));
      }
    }
  }

  // Restore scroll position after render
  ganttContainer.scrollLeft = scrollLeft;
  ganttContainer.scrollTop = scrollTop;
  if (forceCenterToday || !hasAutoCenteredOnToday) {
    centerChartOnToday();
    hasAutoCenteredOnToday = true;
  }
  createTaskSidebar();
  createStickyTimelineHeader();
  createCustomTodayLine();
  createMilestoneLines();
  updateDependencyVisibility();
  updateZoomActive();
  setupBarClick();
  renderEmptyState(isEmptyChart);
}

function renderEmptyState(isEmptyChart) {
  const chartPanel = ganttContainer.closest(".chart-panel") || ganttContainer.parentElement;
  if (!chartPanel) return;

  const existing = chartPanel.querySelector(".gantt-empty-state");
  if (existing) existing.remove();

  if (!isEmptyChart) return;

  const overlay = document.createElement("div");
  overlay.className = "gantt-empty-state";

  const message = document.createElement("p");
  message.className = "gantt-empty-state-message";
  message.textContent = "This chart is empty.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gantt-empty-state-add";
  button.textContent = "Add your first task";
  button.addEventListener("click", () => addNewTask());

  overlay.append(message, button);
  chartPanel.appendChild(overlay);
}

function setupBarClick() {
  const svg = model.gantt && model.gantt.$svg;
  if (!svg) return;

  let downX = 0;
  let downY = 0;
  let moved = false;

  svg.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".bar-wrapper")) return;
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
  });

  svg.addEventListener("mousemove", (e) => {
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) {
      moved = true;
    }
  });

  svg.addEventListener("click", (e) => {
    const wrapper = e.target.closest(".bar-wrapper");
    if (!wrapper || moved) return;
    const id = wrapper.getAttribute("data-id");
    if (!id || id.startsWith("__group__")) return;
    openTaskModal(id);
  });
}

function openTaskModal(id) {
  const task = model.byId.get(id);
  if (!task || !taskModal) return;

  modalTaskId = id;
  tmTitle.value = task.name || "";
  tmId.value = task.sourceId || task.id;
  tmGroup.value = task.group || "";
  tmAssignee.value = task.assignee || "";
  tmProgress.value = task.progress != null ? task.progress : 0;
  tmStart.value = Number.isFinite(task.startMs) ? msToDateString(task.startMs) : "";
  tmEnd.value = Number.isFinite(task.endMs) ? msToDateString(task.endMs) : "";
  tmDuration.value = task.durationDays != null ? task.durationDays : "";
  tmMilestone.checked = task.milestone === true;
  tmDeps.value = (task.dependencies || []).join(", ");
  tmBlocking.value = (task.blocking || []).join(", ");
  tmDescription.value = task.description || "";

  taskModal.hidden = false;
  requestAnimationFrame(() => tmTitle.focus());
}

function closeTaskModal() {
  if (!taskModal) return;
  taskModal.hidden = true;
  modalTaskId = null;
}

function saveTaskModal() {
  if (!modalTaskId) return;
  const task = model.byId.get(modalTaskId);
  if (!task) {
    closeTaskModal();
    return;
  }

  task.name = (tmTitle.value || "").trim() || task.id;
  task.group = (tmGroup.value || "").trim() || null;
  task.assignee = (tmAssignee.value || "").trim() || null;
  task.description = (tmDescription.value || "").trim() || null;
  task.progress = normalizeProgress(tmProgress.value);
  task.milestone = tmMilestone.checked === true;

  // Dates + duration. End date wins if it changed; otherwise use duration.
  const startMs = normalizeTimestamp(tmStart.value);
  const origEndMs = task.endMs;
  let endMs = normalizeTimestamp(tmEnd.value);
  const durVal = Number(tmDuration.value);
  if (Number.isFinite(startMs) && startMs > 0) {
    const endChanged = Number.isFinite(endMs) && endMs > 0 && endMs !== origEndMs;
    if (!endChanged && Number.isFinite(durVal) && durVal >= 1) {
      endMs = startMs + Math.round(durVal) * DAY_MS;
    }
    if (!Number.isFinite(endMs) || endMs <= startMs) {
      endMs = startMs + DAY_MS;
    }
    task.startMs = startMs;
    task.durationDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
    task.endMs = startMs + task.durationDays * DAY_MS;
  }

  // Dependencies + blocking: keep only existing IDs, exclude self.
  const validIds = new Set(model.tasks.map((t) => t.id));
  const parseIds = (value) =>
    String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== task.id && validIds.has(s));

  const prevDeps = task.dependencies;
  const newDeps = parseIds(tmDeps.value);
  task.dependencies = newDeps;
  try {
    topologicalSort(model.tasks);
  } catch (err) {
    task.dependencies = prevDeps;
    if (typeof showRuntimeNotice === "function") {
      showRuntimeNotice(`Dependencies not changed: ${err.message}`);
    }
  }
  task.blocking = parseIds(tmBlocking.value);

  reindex();
  renderChart();
  renderJson();
  markUnsavedEdits();
  closeTaskModal();
}

function deleteTaskById(id) {
  const index = model.tasks.findIndex((t) => t.id === id);
  if (index === -1) return;

  model.tasks.splice(index, 1);
  for (const t of model.tasks) {
    if (Array.isArray(t.dependencies)) {
      t.dependencies = t.dependencies.filter((d) => d !== id);
    }
    if (Array.isArray(t.blocking)) {
      t.blocking = t.blocking.filter((b) => b !== id);
    }
  }

  reindex();
  renderChart();
  renderJson();
  markUnsavedEdits();
}

function setupTaskModal() {
  if (!taskModal) return;

  taskModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-modal-close]")) {
      closeTaskModal();
    }
  });

  if (tmSaveButton) {
    tmSaveButton.addEventListener("click", saveTaskModal);
  }

  if (tmDeleteButton) {
    tmDeleteButton.addEventListener("click", () => {
      if (!modalTaskId) return;
      const task = model.byId.get(modalTaskId);
      const label = task ? task.name || task.id : "this task";
      if (window.confirm(`Delete "${label}"? This cannot be undone.`)) {
        deleteTaskById(modalTaskId);
        closeTaskModal();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (taskModal.hidden) return;
    if (e.key === "Escape") {
      closeTaskModal();
    } else if (e.key === "Enter" && e.target && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      saveTaskModal();
    }
  });
}

function setupZoomControls() {
  if (!zoomControls) return;
  zoomControls.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zoom]');
    if (!btn) return;
    const mode = btn.getAttribute('data-zoom');
    if (mode && mode !== currentViewMode) {
      currentViewMode = mode;
      updateColumnWidthControlState();
      renderChart(true);
    }
  });
  updateZoomActive();
}

function setupRowHeightControls() {
  if (rowHeightControlsReady) {
    updateRowHeightControlState();
    return;
  }

  if (rowHeightMinusButton) {
    rowHeightMinusButton.addEventListener("click", () => {
      currentRowHeight = Math.max(MIN_ROW_HEIGHT, currentRowHeight - ROW_HEIGHT_STEP);
      saveRowHeight();
      updateRowHeightControlState();
      renderChart();
    });
  }

  if (rowHeightPlusButton) {
    rowHeightPlusButton.addEventListener("click", () => {
      currentRowHeight = Math.min(MAX_ROW_HEIGHT, currentRowHeight + ROW_HEIGHT_STEP);
      saveRowHeight();
      updateRowHeightControlState();
      renderChart();
    });
  }

  rowHeightControlsReady = true;
  updateRowHeightControlState();
}

function updateRowHeightControlState() {
  const _bh = Math.max(8, currentRowHeight - 12);
  const _pad = Math.round((currentRowHeight - _bh) / 2);
  document.documentElement.style.setProperty('--gantt-row-height', (_bh + _pad) + 'px');
  document.documentElement.style.setProperty('--gantt-sidebar-header-h', (GANTT_HEADER_HEIGHT - 10 + _pad / 2) + 'px');
  if (rowHeightValue) {
    rowHeightValue.textContent = `Row: ${currentRowHeight}px`;
  }
  if (rowHeightMinusButton) {
    rowHeightMinusButton.disabled = currentRowHeight <= MIN_ROW_HEIGHT;
  }
  if (rowHeightPlusButton) {
    rowHeightPlusButton.disabled = currentRowHeight >= MAX_ROW_HEIGHT;
  }
}

function saveRowHeight() {
  try {
    localStorage.setItem("ganttRowHeight", String(currentRowHeight));
  } catch (e) { /* localStorage not available */ }
}

function setupColumnWidthControls() {
  if (columnWidthControlsReady) {
    updateColumnWidthControlState();
    return;
  }

  if (columnWidthMinusButton) {
    columnWidthMinusButton.addEventListener("click", () => {
      const current = getActiveGanttColumnWidth();
      ganttColumnWidthByMode[currentViewMode] = clampGanttColumnWidth(current - GANTT_COLUMN_WIDTH_STEP);
      saveGanttColumnWidth();
      updateColumnWidthControlState();
      renderChart();
    });
  }

  if (columnWidthPlusButton) {
    columnWidthPlusButton.addEventListener("click", () => {
      const current = getActiveGanttColumnWidth();
      ganttColumnWidthByMode[currentViewMode] = clampGanttColumnWidth(current + GANTT_COLUMN_WIDTH_STEP);
      saveGanttColumnWidth();
      updateColumnWidthControlState();
      renderChart();
    });
  }

  columnWidthControlsReady = true;
  updateColumnWidthControlState();
}

function updateColumnWidthControlState() {
  const activeWidth = getActiveGanttColumnWidth();
  if (columnWidthValue) {
    columnWidthValue.textContent = `${currentViewMode}: ${activeWidth}px`;
  }
  if (columnWidthMinusButton) {
    columnWidthMinusButton.disabled = activeWidth <= MIN_GANTT_COLUMN_WIDTH;
  }
  if (columnWidthPlusButton) {
    columnWidthPlusButton.disabled = activeWidth >= MAX_GANTT_COLUMN_WIDTH;
  }
}

function getActiveGanttColumnWidth() {
  const configured = ganttColumnWidthByMode[currentViewMode];
  if (Number.isFinite(configured)) {
    return clampGanttColumnWidth(configured);
  }
  const fallback = DEFAULT_GANTT_COLUMN_WIDTH_BY_MODE[currentViewMode] ?? DEFAULT_GANTT_COLUMN_WIDTH_BY_MODE.Day;
  return clampGanttColumnWidth(fallback);
}

function applyCustomGanttColumnWidth() {
  if (!model.gantt || !model.gantt.options) {
    return;
  }

  const width = getActiveGanttColumnWidth();
  if (model.gantt.options.column_width === width) {
    return;
  }

  model.gantt.options.column_width = width;
  model.gantt.setup_dates();
  model.gantt.render();
}

function clampGanttColumnWidth(value) {
  return Math.max(MIN_GANTT_COLUMN_WIDTH, Math.min(MAX_GANTT_COLUMN_WIDTH, Math.round(value)));
}

function loadGanttColumnWidth() {
  try {
    const stored = localStorage.getItem("ganttChartColumnWidth");
    if (!stored) {
      return;
    }

    // Backward compatibility with older single-number storage.
    const legacy = Number(stored);
    if (Number.isFinite(legacy)) {
      ganttColumnWidthByMode.Day = clampGanttColumnWidth(legacy);
      ganttColumnWidthByMode.Week = clampGanttColumnWidth(legacy);
      ganttColumnWidthByMode.Month = clampGanttColumnWidth(legacy);
      return;
    }

    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === "object") {
      for (const mode of Object.keys(DEFAULT_GANTT_COLUMN_WIDTH_BY_MODE)) {
        if (Number.isFinite(Number(parsed[mode]))) {
          ganttColumnWidthByMode[mode] = clampGanttColumnWidth(Number(parsed[mode]));
        }
      }
    }
  } catch (e) {
    // localStorage not available, use default
  }
}

function saveGanttColumnWidth() {
  try {
    localStorage.setItem("ganttChartColumnWidth", JSON.stringify(ganttColumnWidthByMode));
  } catch (e) {
    // localStorage not available
  }
}

function updateZoomActive() {
  if (!zoomControls) return;
  for (const btn of zoomControls.querySelectorAll('button[data-zoom]')) {
    if (btn.getAttribute('data-zoom') === currentViewMode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
}

function setupDependencyControls() {
  if (dependencyControlsReady || !dependencyToggle) {
    return;
  }

  dependencyToggle.addEventListener("click", () => {
    dependencyDisplayMode = dependencyDisplayMode === "all" ? "hover" : "all";
    if (dependencyDisplayMode === "all") {
      hoveredTaskId = null;
    }
    updateDependencyToggleUI();
    updateDependencyVisibility();
  });

  dependencyControlsReady = true;
  updateDependencyToggleUI();
}

function setupDownloadButton() {
  if (!downloadJsonButton || downloadJsonButton.dataset.ready === "true") {
    return;
  }

  downloadJsonButton.addEventListener("click", () => {
    const payload = buildOutputPayload();
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data_export_${todayStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  downloadJsonButton.dataset.ready = "true";
}

function setupLoadButton() {
  if (!loadJsonButton || loadJsonButton.dataset.ready === "true") {
    return;
  }

  setupLocalFileLoader();

  loadJsonButton.addEventListener("click", () => {
    openLoadDataDialog();
  });

  loadJsonButton.dataset.ready = "true";
}

function openLoadDataDialog() {
  const settingsDrawer = document.querySelector(".settings-drawer");
  if (settingsDrawer) {
    settingsDrawer.open = false;
  }
  showRuntimeNotice("Choose a data.json file to load, or create a new empty chart.");
}

function setupLoadDataDialog() {
  setupLocalFileLoader();

  if (runtimeNoticeCloseButton && runtimeNoticeCloseButton.dataset.ready !== "true") {
    runtimeNoticeCloseButton.addEventListener("click", () => {
      hideRuntimeNotice();
    });
    runtimeNoticeCloseButton.dataset.ready = "true";
  }

  if (createEmptyChartButton && createEmptyChartButton.dataset.ready !== "true") {
    createEmptyChartButton.addEventListener("click", () => {
      cacheTaskData("[]");
      initializeApp([]);
    });
    createEmptyChartButton.dataset.ready = "true";
  }
}

function setupRefreshButton() {
  if (!refreshDataButton || refreshDataButton.dataset.ready === "true") {
    return;
  }

  refreshDataButton.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Refresh from the configured URL? This discards local edits and reloads the source data."
    );
    if (!confirmed) {
      return;
    }

    const originalLabel = refreshDataButton.textContent;
    refreshDataButton.disabled = true;
    refreshDataButton.textContent = "Refreshing…";

    try {
      await reloadSettingsScript();
      setupTitleBar(true);

      // Wipe the local working copy so the reload uses the freshly fetched URL data.
      try { localStorage.removeItem("ganttDataCache"); } catch (e) { /* ignore */ }
      hasUnsavedEdits = false;
      if (refreshDataButton && refreshDataButton.dataset.ready === "true") {
        refreshDataButton.disabled = true;
      }

      const dataUrl = getConfiguredDataUrl();
      if (!dataUrl) {
        showRuntimeNotice("No data URL is configured. Set dataUrl in settings.js to refresh from a hosted source.");
        return;
      }

      const raw = await loadTaskJsonFromUrl(dataUrl);
      initializeApp(raw);
    } catch (error) {
      showRuntimeNotice(["Could not refresh from the configured URL.", error.message].join("\n"));
    } finally {
      refreshDataButton.disabled = !hasUnsavedEdits;
      refreshDataButton.textContent = originalLabel;
    }
  });

  refreshDataButton.dataset.ready = "true";
  refreshDataButton.disabled = !hasUnsavedEdits;
}

function setupResetLayoutButton() {
  if (!resetLayoutButton || resetLayoutButton.dataset.ready === "true") {
    return;
  }

  resetLayoutButton.addEventListener("click", () => {
    try {
      localStorage.removeItem("ganttColumnWidths");
      localStorage.removeItem("ganttSidebarWidth");
      localStorage.removeItem("ganttChartColumnWidth");
      localStorage.removeItem("ganttRowHeight");
    } catch (e) {
      // localStorage not available
    }

    // Re-apply settings.js defaults.
    const s = window.GANTT_SETTINGS || {};
    model.columnWidths = Object.assign(
      { id: 64, task: 240, assignee: 140, startDate: 74, endDate: 74, progress: 52 },
      s.columnWidths
    );
    model.sidebarWidth = null;
    currentRowHeight = Number.isFinite(Number(s.ganttRowHeight)) ? Number(s.ganttRowHeight) : GANTT_ROW_HEIGHT;
    updateRowHeightControlState();

    const modeDefaults = Object.assign({ Day: 38, Week: 140, Month: 120 }, s.columnWidthByMode);
    ganttColumnWidthByMode.Day   = clampGanttColumnWidth(modeDefaults.Day);
    ganttColumnWidthByMode.Week  = clampGanttColumnWidth(modeDefaults.Week);
    ganttColumnWidthByMode.Month = clampGanttColumnWidth(modeDefaults.Month);

    renderChart();
    updateColumnWidthControlState();
  });

  resetLayoutButton.dataset.ready = "true";
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}


function setupDependencyHoverTracking() {
  if (dependencyHoverReady) {
    return;
  }

  ganttContainer.addEventListener("mousemove", (event) => {
    if (dependencyDisplayMode !== "hover") {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const wrapper = target.closest(".bar-wrapper[data-id]");
    const nextHoveredId = wrapper ? wrapper.getAttribute("data-id") : null;
    if (nextHoveredId === hoveredTaskId) {
      return;
    }

    hoveredTaskId = nextHoveredId;
    updateDependencyVisibility();
  });

  ganttContainer.addEventListener("mouseleave", () => {
    if (dependencyDisplayMode !== "hover") {
      return;
    }
    if (hoveredTaskId !== null) {
      hoveredTaskId = null;
      updateDependencyVisibility();
    }
  });

  ganttContainer.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const wrapper = target.closest(".bar-wrapper[data-id]");
    const clickedId = wrapper ? wrapper.getAttribute("data-id") : null;

    if (clickedId && clickedId.startsWith("__group__")) {
      const groupName = clickedId.slice("__group__".length);
      if (model.collapsedGroups.has(groupName)) {
        model.collapsedGroups.delete(groupName);
      } else {
        model.collapsedGroups.add(groupName);
      }
      renderChart();
      return;
    }

    if (dependencyDisplayMode !== "hover") {
      return;
    }

    if (clickedId && clickedId !== selectedTaskId) {
      selectedTaskId = clickedId;
    } else if (clickedId === selectedTaskId) {
      selectedTaskId = null;
    } else {
      selectedTaskId = null;
    }

    updateDependencyVisibility();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedTaskId !== null) {
      selectedTaskId = null;
      updateDependencyVisibility();
    }
  });

  dependencyHoverReady = true;
}

function updateDependencyToggleUI() {
  if (!dependencyToggle) {
    return;
  }

  dependencyToggle.textContent = dependencyDisplayMode === "all" ? "Deps: All" : "Deps: Hover";
  dependencyToggle.classList.toggle("active", dependencyDisplayMode === "hover");
}

function updateDependencyVisibility() {
  const arrowPaths = ganttContainer.querySelectorAll("g.arrow path[data-from][data-to]");
  if (arrowPaths.length === 0) {
    return;
  }

  if (dependencyDisplayMode === "all") {
    for (const path of arrowPaths) {
      path.classList.remove("dependency-hidden");
    }
    return;
  }

  const activeTaskId = selectedTaskId || hoveredTaskId;
  if (!activeTaskId || !model.byId.has(activeTaskId)) {
    for (const path of arrowPaths) {
      path.classList.add("dependency-hidden");
    }
    return;
  }

  const upstream = collectAncestors(activeTaskId);
  const downstream = collectDescendants(activeTaskId);
  const visibleTasks = new Set([activeTaskId, ...upstream, ...downstream]);

  for (const path of arrowPaths) {
    const fromId = path.getAttribute("data-from");
    const toId = path.getAttribute("data-to");
    const isVisible = !!fromId && !!toId && visibleTasks.has(fromId) && visibleTasks.has(toId);
    path.classList.toggle("dependency-hidden", !isVisible);
  }
}

function setupInteractionTracking() {
  if (interactionTrackingReady) {
    return;
  }

  ganttContainer.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest(".handle.right")) {
      activeEditMode = "resize-right";
      return;
    }

    if (target.closest(".handle.left")) {
      activeEditMode = "resize-left";
      return;
    }

    if (target.closest(".bar-wrapper, .bar")) {
      activeEditMode = "move";
      return;
    }

    activeEditMode = null;
  });

  interactionTrackingReady = true;
}

function handleDateChange(taskId, newStartMs, newEndMs) {
  const task = model.byId.get(taskId);
  const oldStartMs = task.startMs;
  const oldEndMs = task.endMs;

  const pointerMode = activeEditMode;
  const inferredMode = classifyEdit(oldStartMs, oldEndMs, newStartMs, newEndMs);
  let mode = pointerMode || inferredMode;
  activeEditMode = null;

  // Frappe can occasionally report a one-day start shift when resizing right.
  if (!pointerMode
    && mode === "move"
    && (newStartMs - oldStartMs) === -DAY_MS
    && newEndMs > oldEndMs) {
    mode = "resize-right";
  }

  if (mode === "resize-right") {
    newStartMs = oldStartMs;
  } else if (mode === "resize-left") {
    newEndMs = oldEndMs;
  }

  if (newEndMs <= newStartMs) {
    newEndMs = newStartMs + DAY_MS;
  }

  task.startMs = newStartMs;
  task.endMs = newEndMs;
  task.durationDays = Math.max(1, Math.round((task.endMs - task.startMs) / DAY_MS));
  task.endMs = task.startMs + task.durationDays * DAY_MS;

  if (mode === "resize-left") {
    propagateUpstream(task.id);
  } else if (mode === "resize-right") {
    propagateDownstream(task.id);
  } else {
    propagateUpstream(task.id);
    propagateDownstream(task.id);
  }

  enforceForwardConstraints();
  renderChart();
  renderJson();
  markUnsavedEdits();
}

function markUnsavedEdits() {
  if (!getConfiguredDataUrl()) return;
  hasUnsavedEdits = true;
  if (refreshDataButton && refreshDataButton.dataset.ready === "true") {
    refreshDataButton.disabled = false;
  }
}

function classifyEdit(oldStart, oldEnd, nextStart, nextEnd) {
  const startChanged = nextStart !== oldStart;
  const endChanged = nextEnd !== oldEnd;

  if (startChanged && !endChanged) {
    return "resize-left";
  }

  if (!startChanged && endChanged) {
    return "resize-right";
  }

  const oldDuration = oldEnd - oldStart;
  const nextDuration = nextEnd - nextStart;

  if (oldDuration === nextDuration) {
    return "move";
  }

  if (Math.abs(nextStart - oldStart) >= Math.abs(nextEnd - oldEnd)) {
    return "resize-left";
  }

  return "resize-right";
}

function collectAncestors(rootId) {
  const visited = new Set();
  const stack = [rootId];
  visited.add(rootId);

  while (stack.length > 0) {
    const id = stack.pop();
    const task = model.byId.get(id);
    for (const depId of task.dependencies) {
      if (!visited.has(depId)) {
        visited.add(depId);
        stack.push(depId);
      }
    }
  }

  visited.delete(rootId);
  return visited;
}

function collectDescendants(rootId) {
  const visited = new Set();
  const stack = [rootId];
  visited.add(rootId);

  while (stack.length > 0) {
    const id = stack.pop();
    const task = model.byId.get(id);
    for (const childId of task.dependents) {
      if (!visited.has(childId)) {
        visited.add(childId);
        stack.push(childId);
      }
    }
  }

  visited.delete(rootId);
  return visited;
}

function propagateUpstream(rootId) {
  const ancestors = collectAncestors(rootId);
  const reverseOrder = model.topoOrder.slice().reverse();

  for (const id of reverseOrder) {
    if (!ancestors.has(id)) {
      continue;
    }

    const task = model.byId.get(id);
    let latestAllowedEnd = Number.POSITIVE_INFINITY;

    for (const dependentId of task.dependents) {
      const dependent = model.byId.get(dependentId);
      latestAllowedEnd = Math.min(latestAllowedEnd, dependent.startMs);
    }

    if (latestAllowedEnd !== Number.POSITIVE_INFINITY) {
      task.endMs = latestAllowedEnd;
      task.startMs = task.endMs - task.durationDays * DAY_MS;
    }
  }
}

function propagateDownstream(rootId) {
  const descendants = collectDescendants(rootId);

  for (const id of model.topoOrder) {
    if (!descendants.has(id)) {
      continue;
    }

    const task = model.byId.get(id);
    let earliestStart = Number.NEGATIVE_INFINITY;

    for (const depId of task.dependencies) {
      const dep = model.byId.get(depId);
      earliestStart = Math.max(earliestStart, dep.endMs);
    }

    // Only move forward in time (never backward)
    if (earliestStart !== Number.NEGATIVE_INFINITY && earliestStart > task.startMs) {
      task.startMs = earliestStart;
      task.endMs = task.startMs + task.durationDays * DAY_MS;
    }
  }
}

function enforceForwardConstraints() {
  for (const id of model.topoOrder) {
    const task = model.byId.get(id);
    if (task.dependencies.length === 0) {
      continue;
    }

    const minStart = Math.max(...task.dependencies.map((depId) => model.byId.get(depId).endMs));
    if (task.startMs < minStart) {
      task.startMs = minStart;
      task.endMs = minStart + task.durationDays * DAY_MS;
    }
  }
}

function renderJson() {
  const payload = buildOutputPayload();

  jsonOutput.textContent = JSON.stringify(payload, null, 2);
  cacheTaskData(JSON.stringify(payload));
}

function buildOutputPayload() {
  return model.tasks.map((task) => {
    const entry = {
      ID: task.sourceId,
      Title: task.name,
      start: msToDateString(task.startMs),
      end: msToDateString(task.endMs)
    };

    if (task.description) entry.Description = task.description;
    if (task.assignee) entry.Assignee = task.assignee;
    if (task.blocking.length) {
      entry.Blocking = task.blocking.map((id) => normalizeOutputId(id));
    }
    if (task.dependencies.length) {
      entry["Blocked by"] = task.dependencies.map((id) => normalizeOutputId(id));
    }
    if (task.progress) entry.progress = task.progress;
    if (task.group) entry.group = task.group;
    if (task.milestone === true) entry.milestone = true;

    return entry;
  });
}

function normalizeOutputId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === String(value) ? numeric : value;
}

bootstrap().catch((error) => {
  const extraHelp = window.location.protocol === "file:"
    ? [
        "Browsers block fetch() requests from file:// pages.",
        "Start a local server from this folder, for example: python3 -m http.server 8000",
        "Or choose data.json with the file picker below."
      ]
    : [
        "Check that data.json is reachable from the current server.",
        "If you opened index.html directly, use a local server instead: python3 -m http.server 8000"
      ];

  const message = ["Could not initialize the chart.", error.message, ...extraHelp].join("\n");

  jsonOutput.textContent = message;
  showRuntimeNotice(message);
  console.error(error);
});
