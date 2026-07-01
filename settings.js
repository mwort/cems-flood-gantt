// App configuration.
// This file is loaded via a <script> tag so the settings are available even when
// index.html is opened directly from disk (file://), where fetch() of local files is blocked.
//
// Edit the values below to configure the app.
window.GANTT_SETTINGS = {
  // URL of a hosted data.json (e.g. a GitHub "raw" link or any static host that
  // allows cross-origin reads). When set, the app loads its data from here on start.
  // Leave as an empty string to skip remote loading and use the local data.json
  // (only works when served over http) or the "Load JSON" file picker.
  //
  // Example: "https://raw.githubusercontent.com/your-user/your-repo/main/data.json"
  dataUrl: "https://raw.githubusercontent.com/mwort/cems-flood-gantt/refs/heads/main/data/glofas_v5_efas_v6.json",

  // Default chart title shown in the top bar (used until you edit it in the UI).
  title: "EFAS and GloFAS release planning"
};