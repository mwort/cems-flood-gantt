const DAY_MS = 24 * 60 * 60 * 1000;

const model = {
  tasks: [],
  byId: new Map(),
  topoOrder: [],
  gantt: null,
  collapsedGroups: new Set(),
  columnWidths: { id: 64, task: 240, assignee: 140, startDate: 74, endDate: 74, progress: 52 }
};

const SVG_NS = "http://www.w3.org/2000/svg";
const GANTT_HEADER_HEIGHT = 60;
const GANTT_ROW_HEIGHT = 36;
const SIDEBAR_EXPANDED_WIDTH = 540;
const SIDEBAR_COLLAPSED_WIDTH = 56;


const ganttContainer = document.getElementById("gantt");
const jsonOutput = document.getElementById("task-json");
const runtimeNotice = document.getElementById("runtime-notice");
const runtimeMessage = document.getElementById("runtime-message");
const localDataFileInput = document.getElementById("local-data-file");
const zoomControls = document.querySelector('.zoom-controls');
const dependencyToggle = document.getElementById("dependency-toggle");
let currentViewMode = 'Day';
let dependencyDisplayMode = "hover";
let hoveredTaskId = null;
let selectedTaskId = null;
let activeEditMode = null;
let interactionTrackingReady = false;
let localFileLoaderReady = false;
let dependencyControlsReady = false;
let dependencyHoverReady = false;
let stickyTimelineCleanup = null;
let taskSidebarCleanup = null;
let customTodayLineCleanup = null;
let taskSidebarCollapsed = false;
let hasAutoCenteredOnToday = false;
let sidebarResizeCleanup = null;


async function bootstrap() {
  loadColumnWidths();
  setupLocalFileLoader();
  try {
    const raw = await loadTaskJson();
    initializeApp(raw);
  } catch (error) {
    const message = [
      "Could not load ./data.json automatically.",
      "Choose data.json with the file picker below.",
      error.message
    ].join("\n");

    showRuntimeNotice(message);
    if (jsonOutput) {
      jsonOutput.textContent = message;
    }
  }
}

function initializeApp(raw) {
  currentViewMode = "Month";
  hasAutoCenteredOnToday = false;
  model.tasks = normalizeTasks(raw);
  model.topoOrder = topologicalSort(model.tasks);
  scheduleInitialDates(model.tasks, model.topoOrder);
  reindex();
  setupInteractionTracking();
  renderChart();
  renderJson();
  setupZoomControls();
  setupDependencyControls();
  setupDependencyHoverTracking();
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
      return parseTaskPayload(text);
    }

    throw new Error(`Request failed with status ${response.status}`);
  } catch (error) {
    throw new Error(`Unable to load tasks from data.json: ${error.message}`);
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
      result.push(...group.tasks);
    }
  }
  for (const task of model.tasks) {
    if (!task.group) result.push(task);
  }
  return result;
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
  return taskSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;
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
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}`;
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
    `<div class="task-sidebar-cell task-sidebar-cell--progress"></div>`,
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
    `<div class="task-sidebar-row" style="grid-template-columns: ${getColumnGridTemplate()}">`,
    `<div class="task-sidebar-cell task-sidebar-cell--id">${task.id}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--task" title="${task.name}">${task.name}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--assignee" title="${task.assignee || "Unassigned"}">${task.assignee || "Unassigned"}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date">${formatSidebarDate(task.startMs)}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--date">${formatSidebarDate(task.endMs)}</div>`,
    `<div class="task-sidebar-cell task-sidebar-cell--progress">${task.progress}%</div>`,
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
  const baseLeft = ganttRect.left - panelRect.left + Math.max(0, paddingLeft - getTaskSidebarWidth());
  const baseTop = ganttRect.top - panelRect.top + paddingTop;
  const sidebarHeight = Math.max(180, ganttContainer.clientHeight - paddingTop * 2);

  const sidebar = document.createElement("aside");
  sidebar.className = `task-sidebar${taskSidebarCollapsed ? " is-collapsed" : ""}`;
  sidebar.style.width = `${getTaskSidebarWidth()}px`;
  sidebar.style.height = `${sidebarHeight}px`;
  sidebar.setAttribute("aria-label", "Task details sidebar");

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

  const rows = sidebar.querySelector(".task-sidebar-rows");
  const toggle = sidebar.querySelector(".task-sidebar-toggle");
  const columnsHeader = sidebar.querySelector(".task-sidebar-columns");
  const syncSidebar = () => {
    sidebar.style.transform = `translate(${baseLeft}px, ${baseTop}px)`;
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

  syncSidebar();

  taskSidebarCleanup = () => {
    ganttContainer.removeEventListener("scroll", syncSidebar);
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
  const headerHeight = Number(gridHeader.getAttribute("height")) || GANTT_HEADER_HEIGHT;
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
  marker.style.height = `${Math.max(80, ganttContainer.clientHeight - paddingTop * 2 - GANTT_HEADER_HEIGHT)}px`;
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

  applyChartInsets();

  // Save scroll position
  const scrollLeft = ganttContainer.scrollLeft;
  const scrollTop = ganttContainer.scrollTop;
  ganttContainer.innerHTML = "";
  const visibleTasks = buildVisibleTasks();
  model.gantt = new Gantt("#gantt", visibleTasks.map(toChartTask), {
    view_mode: currentViewMode,
    bar_height: 24,
    padding: 12,
    column_width: 34,
    date_format: "YYYY-MM-DD",
    custom_popup_html: (task) => {
      if (task.id.startsWith("__group__")) return "<div></div>";
      const internal = model.byId.get(task.id);
      return [
        `<div class=\"details-container\">`,
        `<h5>${internal.name}</h5>`,
        `<p><strong>Assignee:</strong> ${internal.assignee || "unassigned"}</p>`,
        `<p><strong>Duration:</strong> ${internal.durationDays} days</p>`,
        `<p><strong>Progress:</strong> ${internal.progress}%</p>`,
        `<p><strong>Dependencies:</strong> ${internal.dependencies.join(", ") || "none"}</p>`,
        `<p><strong>Blocks:</strong> ${internal.blocking.join(", ") || "none"}</p>`,
        internal.description ? `<p>${internal.description}</p>` : "",
        `</div>`
      ].join("");
    },
    on_date_change: (task, start, end) => {
      if (task.id.startsWith("__group__")) return;
      handleDateChange(task.id, dateToMs(start), dateToMs(end));
    }
  });
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
  updateDependencyVisibility();
  updateZoomActive();
}

function setupZoomControls() {
  if (!zoomControls) return;
  zoomControls.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zoom]');
    if (!btn) return;
    const mode = btn.getAttribute('data-zoom');
    if (mode && mode !== currentViewMode) {
      currentViewMode = mode;
      renderChart(true);
    }
  });
  updateZoomActive();
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

  if (newEndMs <= newStartMs) {
    newEndMs = newStartMs + DAY_MS;
  }

  task.startMs = newStartMs;
  task.endMs = newEndMs;
  task.durationDays = Math.max(1, Math.round((task.endMs - task.startMs) / DAY_MS));
  task.endMs = task.startMs + task.durationDays * DAY_MS;

  const inferredMode = classifyEdit(oldStartMs, oldEndMs, task.startMs, task.endMs);
  const mode = activeEditMode || inferredMode;
  activeEditMode = null;

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
  const payload = model.tasks.map((task) => ({
    ID: task.sourceId,
    Title: task.name,
    Description: task.description,
    Assignee: task.assignee,
    Blocking: task.blocking.map((id) => normalizeOutputId(id)),
    "Blocked by": task.dependencies.map((id) => normalizeOutputId(id)),
    progress: task.progress,
    start: task.startMs,
    end: task.endMs,
    time: task.durationDays
  }));

  jsonOutput.textContent = JSON.stringify(payload, null, 2);
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
