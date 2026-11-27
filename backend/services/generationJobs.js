'use strict';

// Aszinkron (több lépéses) generálási feladatok állapota: a „Teljes heti csomag” láncolt hívásai itt követhetők.
// A feladatok a szerverpéldány memóriájában élnek (újraindításkor elvesznek, ilyenkor a kliens hibát kap, nem csonka tervet).
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_JOBS_PER_IP = 2;
const MAX_ACTIVE_JOBS = 20;

const jobs = new Map();

function cleanup(now = Date.now()) {
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

function activeCount(ip) {
  let total = 0;
  let perIp = 0;
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    total += 1;
    if (job.ip === ip) perIp += 1;
  }
  return { total, perIp };
}

// Visszaadja a feladatot, vagy null-t, ha az IP-nek/a szervernek nincs szabad helye.
function createJob({ id, ip, labels }) {
  const { total, perIp } = activeCount(ip);
  if (perIp >= MAX_ACTIVE_JOBS_PER_IP || total >= MAX_ACTIVE_JOBS) return null;
  const now = Date.now();
  const job = {
    id, ip, status: 'running', createdAt: now, updatedAt: now,
    steps: labels.map((label) => ({ label, state: 'pending' })),
    result: null, error: null
  };
  jobs.set(id, job);
  return job;
}

function touch(job) {
  job.updatedAt = Date.now();
}

function startStep(job, index) {
  job.steps[index].state = 'running';
  touch(job);
}

function finishStep(job, index) {
  job.steps[index].state = 'done';
  touch(job);
}

function completeJob(job, result) {
  job.status = 'done';
  job.result = result;
  touch(job);
}

function failJob(job, { message, status = 500, details = '' }) {
  const running = job.steps.find((step) => step.state === 'running');
  if (running) running.state = 'error';
  job.status = 'error';
  job.error = { message, status, details };
  touch(job);
}

function getJob(id) {
  const job = jobs.get(String(id));
  return job || null;
}

// A kliensnek szánt nézet: lépéslista, haladás és – kész állapotban – az eredmény (egyszer sem tartalmaz belső részletet).
function publicView(job) {
  const done = job.steps.filter((step) => step.state === 'done').length;
  const current = job.steps.find((step) => step.state === 'running') || null;
  const view = {
    success: true,
    status: job.status,
    generationId: job.id,
    progress: { done, total: job.steps.length, label: current ? current.label : '' },
    steps: job.steps.map((step) => ({ label: step.label, state: step.state }))
  };
  if (job.status === 'done') view.result = job.result;
  if (job.status === 'error') view.error = job.error.message;
  return view;
}

function reset() {
  jobs.clear();
}

module.exports = { createJob, startStep, finishStep, completeJob, failJob, getJob, publicView, reset, MAX_ACTIVE_JOBS_PER_IP, JOB_TTL_MS };
