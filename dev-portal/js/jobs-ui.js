// ═══ Jobs management ═══
let jobsPanelOpen = false;

function openJobsPanel() {
  document.getElementById("jobsBackdrop").classList.add("open");
  document.getElementById("jobsPanel").classList.add("open");
  jobsPanelOpen = true;
  loadJobs();
}

function closeJobsPanel() {
  document.getElementById("jobsBackdrop").classList.remove("open");
  document.getElementById("jobsPanel").classList.remove("open");
  jobsPanelOpen = false;
  document.getElementById("jobsForm").style.display = "none";
}

async function loadJobs() {
  try {
    const res = await fetch("/api/jobs", { headers: await authHeaders() });
    const data = await res.json();
    const list = document.getElementById("jobsList");
    const empty = document.getElementById("jobsEmpty");
    if (!data.jobs || data.jobs.length === 0) {
      list.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    list.innerHTML = data.jobs.map(job => `
      <div class="job-card ${job.enabled ? "enabled" : "disabled"}">
        <div class="job-header">
          <div class="job-title ${job.enabled ? "" : "disabled"}">${esc(job.title)}</div>
          <span class="job-badge ${job.enabled ? "enabled" : "disabled"}">${job.enabled ? "ACTIVE" : "PAUSED"}</span>
        </div>
        <p class="job-prompt">${esc(job.prompt)}</p>
        <div class="job-meta">
          <span>${job.scheduleType}${job.scheduleType === "interval" ? " • every " + job.intervalMinutes + " min" : job.scheduleType === "daily" ? " • daily " + job.dailyTime : " • cron " + job.cron}</span>
          <span>${job.lastRun ? "Last: " + new Date(job.lastRun).toLocaleString() : "Never run"}</span>
          <span>${job.nextRun ? "Next: " + new Date(job.nextRun).toLocaleString() : "—"}</span>
        </div>
        <div class="job-actions">
          <button class="run" onclick="runJobNow('${job.id}')">Run now</button>
          <button class="toggle ${job.enabled ? "enabled" : ""}" onclick="toggleJob('${job.id}', ${job.enabled})">${job.enabled ? "Pause" : "Enable"}</button>
          <button class="delete" onclick="deleteJob('${job.id}')">Delete</button>
        </div>
        ${job.results && job.results.length > 0 ? `
          <div class="job-results">
            <div class="job-result-time">Last result ${job.results[0].at ? new Date(job.results[0].at).toLocaleString() : ""}</div>
            <div class="job-result ${job.results[0].error ? "error" : "ok"}">${esc(job.results[0].output || job.results[0].error || "")}</div>
          </div>
        ` : ""}
      </div>
    `).join("");
  } catch (e) {
    console.error("Failed to load jobs:", e);
  }
}

async function createJob() {
  const title = document.getElementById("jobTitle").value.trim();
  const prompt = document.getElementById("jobPrompt").value.trim();
  const scheduleType = document.getElementById("jobSchedule").value;
  const intervalMinutes = parseInt(document.getElementById("jobInterval").value) || 60;
  const dailyTime = document.getElementById("jobDailyTime").value;
  const cron = document.getElementById("jobCron").value.trim();
  if (!title || !prompt) return alert("Title and prompt are required");
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { ...await authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title, prompt, scheduleType, intervalMinutes, dailyTime, cron, enabled: true }),
    });
    if (!res.ok) throw new Error("Failed to create job");
    document.getElementById("jobTitle").value = "";
    document.getElementById("jobPrompt").value = "";
    document.getElementById("jobsForm").style.display = "none";
    loadJobs();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function runJobNow(jobId) {
  try {
    const res = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/run", {
      method: "POST",
      headers: await authHeaders(),
    });
    const data = await res.json();
    loadJobs();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function toggleJob(jobId, currentlyEnabled) {
  try {
    const res = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/toggle", {
      method: "POST",
      headers: await authHeaders(),
    });
    loadJobs();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function deleteJob(jobId) {
  if (!confirm("Delete this job?")) return;
  try {
    const res = await fetch("/api/jobs/" + encodeURIComponent(jobId), { method: "DELETE", headers: await authHeaders() });
    loadJobs();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function authHeaders() {
  const token = await window.getAccessToken();
  const h = {};
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

// Fetch FiveM status
async function fetchFivemStatus() {
  try {
    const res = await fetch("/api/fivem/status", { headers: await authHeaders() });
    const data = await res.json();
    const el = document.getElementById("fivemStatus");
    if (el) {
      el.textContent = data.enabled ? "FiveM: " + (data.autoDeploy ? "Auto-deploy ON" : "Deploy OFF") : "FiveM: Disabled";
      el.style.color = data.enabled && data.autoDeploy ? "#4ade80" : "#fca5a5";
    }
  } catch {}
}

setInterval(fetchFivemStatus, 10000);
fetchFivemStatus();

// Wire up jobs UI
document.getElementById("jobsBtn")?.addEventListener("click", openJobsPanel);
document.getElementById("jobsClose")?.addEventListener("click", closeJobsPanel);
document.getElementById("jobsBackdrop")?.addEventListener("click", closeJobsPanel);
document.getElementById("jobsCreateBtn")?.addEventListener("click", createJob);
document.getElementById("jobsCancelBtn")?.addEventListener("click", () => {
  document.getElementById("jobsForm").style.display = "none";
});
document.getElementById("jobSchedule")?.addEventListener("change", (e) => {
  const intervalRow = document.getElementById("jobInterval").parentElement.parentElement;
  const dailyRow = document.getElementById("jobDailyTime").parentElement.parentElement;
  const cronRow = document.getElementById("jobCron").parentElement;
  intervalRow.style.display = e.target.value === "interval" ? "flex" : "none";
  dailyRow.style.display = e.target.value === "daily" ? "flex" : "none";
  cronRow.style.display = e.target.value === "cron" ? "block" : "none";
});

function fillFiveMJob(title, prompt, scheduleType, intervalMinutes) {
  document.getElementById("jobTitle").value = title;
  document.getElementById("jobPrompt").value = prompt;
  document.getElementById("jobSchedule").value = scheduleType;
  document.getElementById("jobInterval").value = intervalMinutes;
  document.getElementById("jobDailyTime").value = "09:00";
  document.getElementById("jobCron").value = "";
  // Trigger schedule change to show/hide fields
  const event = new Event("change");
  document.getElementById("jobSchedule").dispatchEvent(event);
  document.getElementById("jobsForm").style.display = "block";
}