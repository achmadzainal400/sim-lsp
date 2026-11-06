/* SIM-LSP report comparison and linked-ticket behavior. Loaded after phase1.js. */
"use strict";

const duplicateDecisionCache = new Map();

function reportMergeRoot(report) {
  return report && report.mergedIntoReportId ? getReport(report.mergedIntoReportId) || report : report;
}

function reportMergeChildren(report) {
  const root = reportMergeRoot(report);
  if (!root) return [];
  return (Array.isArray(root.mergedReportIds) ? root.mergedReportIds : []).map(getReport).filter(Boolean);
}

function syncMergedReportsFromParent(parent) {
  if (!isManager() || !parent || parent.mergedIntoReportId) return;
  const children = reportMergeChildren(parent);
  if (!children.length) return;
  const workflowFields = [
    "status", "priority", "urgency", "needsApproval", "approvalStatus", "approverName",
    "previousStatus", "legacyStatus", "approvalNote", "deferReason", "internalNote",
    "pj", "executor", "executorIds", "executor_ids", "startedAt", "completedAt",
    "materialCost", "serviceCost", "result", "targetDate", "statusUpdatedAt", "updatedAt",
    "assetUsageId", "assetUsageQuantity", "assetUsageNote", "acquisitionQuantity", "acquisitionUnit"
  ];
  const parentEvents = Array.isArray(parent.events) ? parent.events : [];
  const parentWorkPhotos = (Array.isArray(parent.photos) ? parent.photos : []).filter(function (photo) {
    return photo && photo.kind === "hasil";
  });
  children.forEach(function (child) {
    const statusChanged = String(child.status || "") !== String(parent.status || "");
    workflowFields.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(parent, key)) child[key] = JSON.parse(JSON.stringify(parent[key]));
      else delete child[key];
    });
    child.photos = (Array.isArray(child.photos) ? child.photos : []).filter(function (photo) {
      return !photo || photo.kind !== "hasil";
    }).concat(JSON.parse(JSON.stringify(parentWorkPhotos)));
    if (statusChanged) child.statusEventId = makeId();
    const events = Array.isArray(child.events) ? child.events.slice() : [];
    const mergedAt = Date.parse(child.mergedAt || "");
    parentEvents.forEach(function (event, index) {
      if (!event || event.public === false) return;
      const eventAt = Date.parse(event.at || "");
      if (Number.isFinite(mergedAt) && Number.isFinite(eventAt) && eventAt < mergedAt) return;
      const key = String(parent.id) + ":" + index + ":" + JSON.stringify(event);
      if (events.some(function (existing) { return existing && existing.mergeMirrorKey === key; })) return;
      events.push(Object.assign({}, event, { mergeMirrorKey: key, mergedFromReportId: parent.id }));
    });
    child.events = events;
  });
}

const saveDbBeforeMergeSync = saveDb;
saveDb = function () {
  if (isManager()) {
    db.reports.filter(function (report) {
      return !report.mergedIntoReportId && Array.isArray(report.mergedReportIds) && report.mergedReportIds.length;
    }).forEach(syncMergedReportsFromParent);
  }
  return saveDbBeforeMergeSync();
};

notifyReportStatus = async function (report) {
  const allowedStatuses = ["ANTREAN", "MENUNGGU_PERSETUJUAN", "DITUNDA", "SELESAI", "DITOLAK"];
  if (!appSession || !supabaseClient || !sharedDataReady || !report || !isManager() || !allowedStatuses.includes(String(report.status || ""))) return;
  const current = getReport(report.id) || report;
  const parent = reportMergeRoot(current);
  if (!parent) return;
  const recipients = [parent].concat(reportMergeChildren(parent));
  const seen = new Set();
  let failed = false;
  for (const member of recipients) {
    const id = String(member.id || "");
    if (!id || seen.has(id) || !member.creatorProfileId || !member.statusEventId) continue;
    seen.add(id);
    try {
      const result = await supabaseClient.functions.invoke("simlsp-notify-report-status", {
        body: { reportId: id, eventId: String(member.statusEventId) }
      });
      if (result.error || !result.data || !result.data.ok) {
        throw result.error || new Error(result.data && result.data.error || "Pemberitahuan tidak terkirim.");
      }
    } catch (error) {
      failed = true;
      console.warn("Pemberitahuan status tidak terkirim:", member.code, error && error.message);
    }
  }
  if (failed) toast("Status tersimpan, tetapi sebagian notifikasi ke pelapor gagal dikirim.");
};

function duplicateDecisionHistoryHtml(report) {
  const decisions = duplicateDecisionCache.get(String(report.id)) || [];
  if (!decisions.length) {
    return '<div class="duplicate-decision-history" data-duplicate-decisions-for="' + esc(report.id) + '"><span class="duplicate-review-loading">Memeriksa keputusan laporan sebelumnya…</span></div>';
  }
  return '<div class="duplicate-decision-history" data-duplicate-decisions-for="' + esc(report.id) + '">' + decisions.map(function (decision) {
    const linked = getReport(decision.reportId);
    const label = decision.choice === "separate" ? "Ditandai sebagai laporan berbeda" : "Pernah disetujui untuk digabung";
    return '<div class="duplicate-decision-note"><strong>' + esc(label) + (linked ? " · " + esc(linked.code) : "") + '</strong>' +
      (decision.reason ? '<div>Alasan: ' + esc(decision.reason) + '</div>' : "") +
      '<small>' + esc(decision.by || "Pengguna") + ' · ' + esc(dateText(decision.at, false)) + '</small></div>';
  }).join("") + '</div>';
}

duplicateReviewHtml = function (report) {
  if (!report || report.mergedIntoReportId) return "";
  const userId = String(appSession && appSession.user && appSession.user.id || "");
  const manager = isManager();
  const owner = !!userId && String(report.creatorProfileId || "") === userId && report.duplicateMergeEnabled === true;
  if (!manager && !owner) return "";
  const sourceDate = Date.parse(report.createdAt || "");
  const matches = findSimilarOpenReports(report.location, report.object, report.id, 3, report.createdAt)
    .filter(function (match) { return manager || Date.parse(match.report.createdAt || "") <= sourceDate; })
    .filter(function (match) { return !(Array.isArray(report.mergedReportIds) && report.mergedReportIds.includes(match.report.id)); });
  if (!matches.length && !duplicateDecisionCache.has(String(report.id))) return "";
  const title = manager ? "Tinjau laporan yang mungkin sama" : "Apakah laporan ini sama?";
  const intro = manager
    ? "Bandingkan laporan yang lokasi dan objeknya mirip. Jika satu masalah, gabungkan agar tindak lanjut cukup dilakukan sekali."
    : "Kami menemukan laporan terbuka dengan lokasi dan objek serupa dalam 14 hari terakhir. Bandingkan dulu sebelum memilih.";
  const cards = matches.map(function (match) {
    const candidate = match.report;
    const previous = (duplicateDecisionCache.get(String(report.id)) || []).find(function (decision) {
      return String(decision.reportId) === String(candidate.id);
    });
    const alreadySeparate = previous && previous.choice === "separate";
    const reportSummary = '<strong>' + esc(report.code) + ' · ' + esc(report.object || report.category) + '</strong>' +
      '<p>' + esc(report.location || "Lokasi belum dicatat") + ' · ' + esc(report.unit || "Unit belum dicatat") + '</p><p>' +
      esc(String(report.description || "Uraian belum diisi").slice(0, 260)) + (String(report.description || "").length > 260 ? "…" : "") +
      '</p><small>' + esc(dateText(report.createdAt, true)) + ' · ' + esc(STATUS[report.status] || report.status || "Status") + '</small>';
    const candidateSummary = '<strong>' + esc(candidate.code) + ' · ' + esc(candidate.object || candidate.category) + '</strong>' +
      '<p>' + esc(candidate.location || "Lokasi belum dicatat") + ' · ' + esc(candidate.unit || "Unit belum dicatat") + '</p><p>' +
      esc(String(candidate.description || "Uraian belum diisi").slice(0, 260)) + (String(candidate.description || "").length > 260 ? "…" : "") +
      '</p><small>' + esc(dateText(candidate.createdAt, true)) + ' · ' + esc(STATUS[candidate.status] || candidate.status || "Status") + '</small>';
    const comparison = '<div class="duplicate-compare"><div class="duplicate-compare-side"><small>Laporan ini</small>' + reportSummary +
      '</div><div class="duplicate-compare-side"><small>Tiket pembanding</small>' + candidateSummary + '</div></div>' +
      '<div class="action-row" style="margin-top:8px"><button class="btn secondary small" type="button" data-open="' + esc(candidate.id) + '">Buka tiket pembanding</button></div>';
    if (manager) {
      return '<article class="duplicate-candidate">' + comparison + '<form class="duplicate-admin-merge-form" data-duplicate-decision-form data-report-id="' + esc(report.id) + '" data-candidate-id="' + esc(candidate.id) + '" data-decision="merge">' +
        '<label for="duplicateAdminReason_' + esc(report.id) + '_' + esc(candidate.id) + '">Alasan penggabungan (wajib, 5–800 karakter)</label>' +
        '<textarea id="duplicateAdminReason_' + esc(report.id) + '_' + esc(candidate.id) + '" name="reason" minlength="5" maxlength="800" required placeholder="Jelaskan mengapa kedua tiket mewakili masalah yang sama."></textarea>' +
        '<button class="btn small" type="submit">Gabungkan tiket ' + esc(candidate.code) + '</button></form></article>';
    }
    if (alreadySeparate) {
      return '<article class="duplicate-candidate">' + comparison + '<div class="duplicate-decision-note"><strong>Sudah ditandai sebagai laporan berbeda</strong><div>' + esc(previous.reason || "") + '</div></div></article>';
    }
    return '<article class="duplicate-candidate">' + comparison + '<div class="duplicate-candidate-actions">' +
      '<button class="btn small" type="button" data-duplicate-choice="merge" data-report-id="' + esc(report.id) + '" data-candidate-id="' + esc(candidate.id) + '">Gabungkan dengan tiket ' + esc(candidate.code) + '</button>' +
      '<button class="btn secondary small" type="button" data-duplicate-choice="separate" data-report-id="' + esc(report.id) + '" data-candidate-id="' + esc(candidate.id) + '">Laporan saya berbeda</button></div>' +
      '<form class="duplicate-separate-form" data-duplicate-decision-form data-report-id="' + esc(report.id) + '" data-candidate-id="' + esc(candidate.id) + '" data-decision="separate" hidden>' +
      '<label for="duplicateReason_' + esc(report.id) + '_' + esc(candidate.id) + '">Apa perbedaan laporan Anda dengan tiket ' + esc(candidate.code) + '? (wajib, 5–800 karakter)</label>' +
      '<textarea id="duplicateReason_' + esc(report.id) + '_' + esc(candidate.id) + '" name="reason" minlength="5" maxlength="800" required placeholder="Contoh: meja berada di ruang berbeda atau kerusakannya tidak sama."></textarea>' +
      '<button class="btn secondary small" type="submit">Kirim alasan dan pertahankan laporan</button></form></article>';
  }).join("");
  return '<section class="duplicate-review-panel" aria-label="Perbandingan laporan serupa"><strong>' + esc(title) + '</strong><p>' + esc(intro) + '</p>' +
    duplicateDecisionHistoryHtml(report) + '<div class="duplicate-candidate-list">' + (cards || '<p class="small-note">Tidak ada tiket aktif yang memenuhi kriteria kemiripan saat ini.</p>') + '</div></section>';
};

function mergeNoticeHtml(report) {
  if (!report) return "";
  const root = reportMergeRoot(report);
  if (report.mergedIntoReportId) {
    return '<aside class="merged-ticket-banner"><strong>Laporan ini mengikuti tiket induk ' + esc(root.code || root.id) + '</strong>' +
      'Kode ' + esc(report.code) + ' tetap berlaku. Status, riwayat penanganan, diskusi, dan pemberitahuan mengikuti tiket induk.' +
      '<br><button type="button" class="btn secondary small" data-open="' + esc(root.id) + '">Buka tiket induk</button></aside>';
  }
  const children = reportMergeChildren(root);
  if (!children.length) return "";
  return '<aside class="merged-ticket-banner"><strong>Grup laporan · ' + (children.length + 1) + ' tiket</strong>' +
    'Admin menanggapi tiket induk ini satu kali. Setiap pelapor tetap memakai kode masing-masing; status, riwayat, diskusi, dan pemberitahuan diselaraskan.' +
    '<ul class="merged-ticket-list">' + children.map(function (child) {
      return '<li>' + esc(child.code) + ' · ' + esc(child.reporterName || "Pelapor") + ' · ' + esc(child.object || child.category) + ' — ' + esc(child.location) + '</li>';
    }).join("") + '</ul></aside>';
}

const detailActionFormBeforeMerge = detailActionForm;
detailActionForm = function (report) { return report && report.mergedIntoReportId ? "" : detailActionFormBeforeMerge(report); };
const adminEditFormBeforeMerge = adminEditForm;
adminEditForm = function (report) { return report && report.mergedIntoReportId ? "" : adminEditFormBeforeMerge(report); };
const renderDetailBeforeMerge = renderDetail;
renderDetail = function (report) {
  let html = renderDetailBeforeMerge(report);
  if (!report) return html;
  if (report.mergedIntoReportId) {
    html = html.replace(/<div class="action-row"><button class="btn danger small" data-action="delete-report"[\s\S]*?<\/div>/g, "")
      .replace(/<div class="action-row"><button class="btn secondary small" data-action="cancel"[\s\S]*?<\/div>/g, "")
      .replace('class="work-photo-panel"', 'class="work-photo-panel" hidden');
  } else if (reportMergeChildren(report).length) {
    html = html.replace(/<div class="action-row"><button class="btn danger small" data-action="delete-report"[\s\S]*?<\/div>/g, "")
      .replace(/<div class="action-row"><button class="btn secondary small" data-action="cancel"[\s\S]*?<\/div>/g, "");
  }
  return mergeNoticeHtml(report) + html;
};

async function loadDuplicateDecisions(reportId) {
  const report = getReport(reportId);
  const userId = String(appSession && appSession.user && appSession.user.id || "");
  if (!report || (!isManager() && String(report.creatorProfileId || "") !== userId)) return;
  const findHost = function () { return Array.from(document.querySelectorAll("[data-duplicate-decisions-for]"))
    .find(function (node) { return node.getAttribute("data-duplicate-decisions-for") === String(report.id); }); };
  const host = findHost();
  if (!host || !supabaseClient) return;
  try {
    const result = await supabaseClient.rpc("simlsp_list_duplicate_decisions", { p_report_id: String(report.id) });
    if (result.error) throw result.error;
    const rows = Array.isArray(result.data) ? result.data : [];
    duplicateDecisionCache.set(String(report.id), rows);
    const currentHost = findHost();
    if (!currentHost) return;
    const panel = currentHost.closest(".duplicate-review-panel");
    if (panel && openReportId === report.id) panel.outerHTML = duplicateReviewHtml(report);
    else currentHost.textContent = rows.length ? rows.length + " keputusan tercatat." : "Belum ada keputusan sebelumnya untuk tiket serupa.";
  } catch (error) {
    host.textContent = "Keputusan pembanding belum dapat dimuat. " + String(error && error.message || "");
  }
}

async function submitDuplicateDecision(form) {
  const reportId = form.getAttribute("data-report-id");
  const candidateId = form.getAttribute("data-candidate-id");
  const decision = form.getAttribute("data-decision");
  const field = form.elements.namedItem("reason");
  const reason = String(field && field.value || "").trim();
  if (decision === "separate" && (reason.length < 5 || reason.length > 800)) {
    toast("Jelaskan perbedaan laporan dengan 5 sampai 800 karakter.");
    if (field) field.focus();
    return;
  }
  if (decision === "merge" && isManager() && (reason.length < 5 || reason.length > 800)) {
    toast("Alasan Admin menggabungkan tiket wajib diisi (5 sampai 800 karakter).");
    if (field) field.focus();
    return;
  }
  const source = getReport(reportId);
  const candidate = getReport(candidateId);
  if (!source || !candidate) return;
  if (decision === "merge" && !isManager() && !confirm("Gabungkan laporan Anda dengan tiket " + candidate.code + "? Kode kedua tiket tetap ada dan perkembangan tiket induk dikirim kepada kedua pelapor.")) return;
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = "Menyimpan…"; }
  try {
    const result = await supabaseClient.rpc("simlsp_resolve_duplicate_report", {
      p_report_id: String(reportId), p_candidate_id: String(candidateId), p_decision: decision, p_reason: reason
    });
    if (result.error) throw result.error;
    duplicateDecisionCache.delete(String(reportId));
    duplicateDecisionCache.delete(String(candidateId));
    if (decision === "separate") {
      toast("Laporan tetap terpisah. Alasan Anda dikirim kepada Sarpras/Admin.");
      await loadDuplicateDecisions(reportId);
      return;
    }
    await refreshSharedData(true);
    void notifyQueueCount();
    if (window.phase1RefreshNotifications) void window.phase1RefreshNotifications();
    const parentId = result.data && result.data.parentReportId || reportId;
    toast("Tiket digabungkan. Kedua kode tiket tetap dapat dipantau.");
    if (getReport(parentId)) openDetail(parentId);
    else render();
  } catch (error) {
    toast(error && error.message || "Keputusan tiket gagal disimpan. Muat ulang data lalu coba lagi.");
    if (button) {
      button.disabled = false;
      button.textContent = decision === "merge" ? "Gabungkan tiket" : "Kirim alasan dan pertahankan laporan";
    }
  }
}

document.getElementById("modalBody").addEventListener("click", function (event) {
  const choice = event.target.closest("[data-duplicate-choice]");
  if (!choice) return;
  if (choice.getAttribute("data-duplicate-choice") === "merge") {
    const form = choice.closest(".duplicate-candidate").querySelector('[data-duplicate-decision-form][data-decision="merge"]');
    if (form) void submitDuplicateDecision(form);
    return;
  }
  const form = choice.closest(".duplicate-candidate").querySelector('[data-duplicate-decision-form][data-decision="separate"]');
  if (form) {
    form.hidden = false;
    const reason = form.elements.namedItem("reason");
    if (reason) reason.focus();
  }
});
document.getElementById("modalBody").addEventListener("submit", function (event) {
  if (!event.target.matches("[data-duplicate-decision-form]")) return;
  event.preventDefault();
  void submitDuplicateDecision(event.target);
});

findSimilarOpenReports = function (location, object, excludeId, limit, anchorAt) {
  const anchor = Date.parse(anchorAt || nowIso());
  const safeAnchor = Number.isFinite(anchor) ? anchor : Date.now();
  const closed = ["SELESAI", "DITOLAK", "DIBATALKAN"];
  return db.reports.filter(function (report) {
    if (String(report.id || "") === String(excludeId || "") || report.mergedIntoReportId || closed.includes(String(report.status || ""))) return false;
    const date = Date.parse(report.createdAt || "");
    return Number.isFinite(date) && Math.abs(date - safeAnchor) <= DUPLICATE_WINDOW_MS;
  }).map(function (report) {
    const locationScore = duplicateSimilarity(location, report.location, "location");
    const objectScore = duplicateSimilarity(object, report.object, "object");
    return { report: report, score: locationScore * 0.45 + objectScore * 0.55, locationScore: locationScore, objectScore: objectScore };
  }).filter(function (match) { return match.locationScore >= 0.7 && match.objectScore >= 0.5; })
    .sort(function (a, b) { return b.score - a.score || Math.abs(Date.parse(a.report.createdAt) - safeAnchor) - Math.abs(Date.parse(b.report.createdAt) - safeAnchor); })
    .slice(0, Math.max(0, Number(limit) || 3));
};

