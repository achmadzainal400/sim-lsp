(function () {
  "use strict";

  if (window.__simlspPhase1Loaded) return;
  window.__simlspPhase1Loaded = true;

  const PHASE1_COMMENT_LIMIT = 800;
  const PHASE1_AVATAR_LIMIT = 150 * 1024;
  const PHASE1_INFO_FILE_LIMIT = 10 * 1024 * 1024;
  const PHASE1_SOP_MAX_ROWS = 501;
  const PHASE1_SOP_MAX_COLUMNS = 30;
  const PHASE1_SOP_TABLE_MAX_BYTES = 2 * 1024 * 1024;
  const PHASE1_ALLOWED_INFO_TYPES = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]);
  const PHASE1_INFO_EXTENSIONS = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/csv": "csv",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };

  let phase1AssignableUsers = [];
  let phase1AssignableLoaded = false;
  let phase1AssignableLoading = false;
  let phase1AssignableError = "";
  let phase1SelectedExecutorIds = new Set();
  let phase1Notifications = [];
  let phase1UnreadCount = 0;
  let phase1NotificationError = "";
  let phase1NotificationTimer = null;
  let phase1InfoPosts = [];
  let phase1InfoLoadedAt = 0;
  let phase1InfoLoading = false;
  let phase1InfoError = "";
  let phase1InfoCategory = "Semua";
  let phase1InfoEditingId = "";
  let phase1InfoDetailId = "";
  let phase1InfoIndex = 0;
  let phase1InfoTimer = null;
  let phase1InfoPointerDown = null;
  let phase1InfoSuppressClick = false;
  let phase1KeyboardFocusMode = false;
  let phase1InfoResumeTimer = null;
  let phase1SopDocuments = [];
  let phase1SopLoadedAt = 0;
  let phase1SopLoading = false;
  let phase1SopLoadPromise = null;
  let phase1SopLoadGeneration = 0;
  let phase1SopError = "";
  let phase1SopMessage = "";
  let phase1SelectedSopId = new URLSearchParams(window.location.search).get("sopId") || "";
  let phase1SopNavigationPending = false;
  let phase1SelectedSopFileId = "";
  const phase1InfoPauseReasons = new Set();
  const phase1AvatarUrlCache = new Map();
  const phase1InfoUrlCache = new Map();
  const phase1SopUrlCache = new Map();

  if (!APP_VIEWS.includes("info")) APP_VIEWS.push("info");
  if (!initialReportId && requestedInitialView === "info") currentView = "info";
  if (!NAV.some(function (item) { return item.id === "info"; })) {
    const informationNav = NAV.find(function (item) { return item.id === "sop"; });
    if (informationNav) {
      informationNav.id = "info";
      informationNav.icon = "▧";
      informationNav.label = "Informasi Madrasah";
    }
  }

  function phase1Initials(name) {
    const parts = String(name || "Pengguna").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toLocaleUpperCase("id-ID");
  }

  function phase1AvatarMarkup(path, name, className) {
    const initials = esc(phase1Initials(name));
    return '<span class="phase1-avatar ' + esc(className || "") + '" data-avatar-path="' + esc(path || "") + '" role="img" aria-label="Foto profil ' + esc(name || "Pengguna") + '"><span class="phase1-avatar-initials">' + initials + '</span><img alt="" hidden></span>';
  }

  async function phase1SignedStorageUrl(bucket, path, cache) {
    if (!path || !supabaseClient) return "";
    const now = Date.now();
    const cached = cache.get(path);
    if (cached && cached.expiresAt > now) return cached.url;
    const result = await supabaseClient.storage.from(bucket).createSignedUrl(path, 3600);
    if (result.error || !result.data || !result.data.signedUrl) return "";
    cache.set(path, { url: result.data.signedUrl, expiresAt: now + 3500000 });
    return result.data.signedUrl;
  }

  async function phase1HydrateAvatarImages(root) {
    if (!root || !supabaseClient) return;
    const nodes = Array.from(root.querySelectorAll(".phase1-avatar[data-avatar-path]"));
    for (const node of nodes) {
      const path = node.getAttribute("data-avatar-path");
      const image = node.querySelector("img");
      if (!path || !image || node.dataset.avatarLoaded === "true") continue;
      node.dataset.avatarLoaded = "true";
      const url = await phase1SignedStorageUrl("user-avatars", path, phase1AvatarUrlCache);
      if (!url || !node.isConnected) continue;
      image.onload = function () {
        image.hidden = false;
        const initials = node.querySelector(".phase1-avatar-initials");
        if (initials) initials.hidden = true;
      };
      image.onerror = function () {
        image.hidden = true;
        const initials = node.querySelector(".phase1-avatar-initials");
        if (initials) initials.hidden = false;
      };
      image.src = url;
    }
  }

  function phase1EnsureHeader() {
    const topControls = document.querySelector(".top-controls");
    const actor = document.getElementById("actorDisplay");
    if (!topControls || !actor) return;

    let wrap = document.getElementById("phase1NotificationWrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "phase1NotificationWrap";
      wrap.className = "phase1-notification-wrap";
      wrap.innerHTML = '<button type="button" id="phase1NotificationBell" data-action="toggleNotifications" class="phase1-notification-bell" aria-haspopup="true" aria-expanded="false" aria-controls="phase1NotificationPanel"><span aria-hidden="true">🔔</span><span class="phase1-notification-label">Notifikasi</span><span id="phase1NotificationBadge" class="phase1-notification-badge" hidden></span></button><section id="phase1NotificationPanel" class="phase1-notification-panel" aria-label="Pemberitahuan" hidden><div class="phase1-notification-head"><strong>Pemberitahuan</strong><button type="button" class="btn secondary small" data-action="refreshNotifications">Muat ulang</button></div><div id="phase1NotificationList" aria-live="polite"><p class="small-note">Memuat pemberitahuan…</p></div></section>';
      topControls.insertBefore(wrap, topControls.firstChild);
    }

    topControls.classList.add("phase1-top-controls");
    actor.classList.add("phase1-profile-link");
    actor.setAttribute("data-view", "settings");
    actor.setAttribute("aria-label", "Profil " + currentActor + " dan pengaturan akun");
    const oldAvatar = topControls.querySelector(".phase1-header-avatar-button");
    if (oldAvatar) oldAvatar.remove();
    actor.insertAdjacentHTML("beforebegin", '<button type="button" class="phase1-header-avatar-button" data-view="settings" aria-label="Buka profil dan pengaturan akun">' + phase1AvatarMarkup(userProfile && userProfile.avatar_path, currentActor, "phase1-header-avatar") + '</button>');
    phase1RenderNotifications();
    void phase1HydrateAvatarImages(topControls);
  }

  function phase1NotificationMarkup(item) {
    const when = dateText(item.created_at, true);
    return '<button type="button" class="phase1-notification-item ' + (item.is_read ? "" : "unread") + '" data-notification-id="' + esc(item.id) + '"><span class="phase1-notification-dot" aria-hidden="true"></span><span class="phase1-notification-copy"><strong>' + esc(item.title) + '</strong><span>' + esc(item.body) + '</span><small>' + esc(when) + '</small></span></button>';
  }

  function phase1RenderNotifications() {
    const badgeNode = document.getElementById("phase1NotificationBadge");
    const bell = document.getElementById("phase1NotificationBell");
    const list = document.getElementById("phase1NotificationList");
    if (badgeNode) {
      badgeNode.textContent = phase1UnreadCount > 99 ? "99+" : String(phase1UnreadCount);
      badgeNode.hidden = phase1UnreadCount <= 0;
    }
    if (bell) bell.setAttribute("aria-label", "Pemberitahuan, " + phase1UnreadCount + " belum dibaca");
    if (!list) return;
    if (phase1NotificationError) {
      list.innerHTML = '<p class="phase1-inline-error">' + esc(phase1NotificationError) + '</p>';
    } else if (!phase1Notifications.length) {
      list.innerHTML = '<p class="phase1-empty-note">Belum ada pemberitahuan.</p>';
    } else {
      list.innerHTML = phase1Notifications.map(phase1NotificationMarkup).join("");
    }
  }

  async function phase1RefreshNotifications() {
    if (!appSession || !supabaseClient) return;
    const [latest, unread] = await Promise.all([
      supabaseClient.from("simlsp_notifications")
        .select("id,type,title,body,report_id,report_code,info_post_id,is_read,created_at")
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseClient.from("simlsp_notifications")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false)
    ]);
    if (latest.error || unread.error) {
      phase1NotificationError = "Pemberitahuan belum dapat dimuat. Periksa koneksi lalu coba lagi.";
      phase1RenderNotifications();
      return;
    }
    phase1NotificationError = "";
    phase1Notifications = Array.isArray(latest.data) ? latest.data : [];
    phase1UnreadCount = Number(unread.count || 0);
    phase1RenderNotifications();
  }

  async function phase1SendPushEvent(eventKey) {
    if (!eventKey || !appSession || !supabaseClient) return;
    try {
      const result = await supabaseClient.functions.invoke("simlsp-notify-app-event", { body: { eventKey: eventKey } });
      if (result.error || result.data && result.data.error) {
        console.warn("Push pemberitahuan SIM-LSP belum terkirim:", result.error && result.error.message || result.data && result.data.error || "fungsi belum tersedia");
      }
    } catch (error) {
      console.warn("Push pemberitahuan SIM-LSP belum terkirim:", error && error.message || "koneksi gagal");
    }
  }

  function phase1StartNotificationPolling() {
    clearInterval(phase1NotificationTimer);
    phase1NotificationTimer = setInterval(function () {
      if (document.visibilityState !== "hidden" && appSession) void phase1RefreshNotifications();
    }, 45000);
    void phase1RefreshNotifications();
  }

  async function phase1OpenNotification(id) {
    const item = phase1Notifications.find(function (notification) { return notification.id === id; });
    if (!item || !supabaseClient || !appSession) return;
    if (!item.is_read) {
      const update = await supabaseClient.from("simlsp_notifications")
        .update({ is_read: true })
        .eq("id", item.id)
        .eq("user_id", appSession.user.id);
      if (update.error) {
        toast("Pemberitahuan belum dapat ditandai dibaca.");
      } else {
        item.is_read = true;
        phase1UnreadCount = Math.max(0, phase1UnreadCount - 1);
      }
    }
    phase1CloseNotifications();
    phase1RenderNotifications();
    if (item.report_id) {
      navigateToView("reports");
      const report = getReport(item.report_id);
      if (report) openDetail(report.id);
      else toast("Tiket belum ada di perangkat. Muat ulang data bersama terlebih dahulu.");
    } else if (item.info_post_id) {
      phase1InfoDetailId = item.info_post_id;
      phase1InfoLoadedAt = 0;
      navigateToView("info");
      let attempts = 0;
      while (phase1InfoLoading && attempts++ < 50) await new Promise(function (resolve) { window.setTimeout(resolve, 100); });
      const post = phase1InfoPosts.find(function (candidate) { return candidate.id === item.info_post_id; });
      if (post && post.kind === "sop_link" && post.sop_id) {
        await phase1LoadSops(false);
        if (phase1SopDocuments.some(function (doc) { return doc.id === post.sop_id && doc.active; })) {
          phase1OpenSop(post.sop_id);
        }
      } else phase1RenderInfoList();
    }
  }

  function phase1CloseNotifications() {
    const panel = document.getElementById("phase1NotificationPanel");
    const bell = document.getElementById("phase1NotificationBell");
    if (panel) panel.hidden = true;
    if (bell) bell.setAttribute("aria-expanded", "false");
  }

  function phase1ToggleNotifications() {
    const panel = document.getElementById("phase1NotificationPanel");
    const bell = document.getElementById("phase1NotificationBell");
    if (!panel || !bell) return;
    const open = panel.hidden;
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
    if (open) {
      void phase1RefreshNotifications();
      const firstItem = panel.querySelector("[data-notification-id]");
      if (firstItem) firstItem.focus();
    }
  }

  async function phase1LoadAssignableUsers(force) {
    if (!isManager() || !supabaseClient || phase1AssignableLoading) return;
    if (!force && phase1AssignableLoaded) return;
    phase1AssignableLoading = true;
    phase1AssignableError = "";
    try {
      const result = await supabaseClient.rpc("simlsp_admin_list_assignable_users");
      if (result.error) throw result.error;
      phase1AssignableUsers = Array.isArray(result.data) ? result.data : [];
      phase1AssignableLoaded = true;
    } catch (error) {
      phase1AssignableError = "Daftar akun aktif belum dapat dimuat.";
    } finally {
      phase1AssignableLoading = false;
    }
    phase1PatchAssignmentChoices();
  }

  function phase1AssigneeRows(selectedIds, search) {
    const needle = String(search || "").trim().toLocaleLowerCase("id-ID");
    if (phase1AssignableLoading && !phase1AssignableLoaded) return '<p class="small-note">Memuat daftar akun…</p>';
    if (phase1AssignableError) return '<p class="phase1-inline-error">' + esc(phase1AssignableError) + ' <button type="button" class="btn secondary small" data-action="reloadAssignees">Muat ulang</button></p>';
    const rows = phase1AssignableUsers.filter(function (user) {
      return !needle || [user.display_name, user.username, user.unit, user.role].join(" ").toLocaleLowerCase("id-ID").includes(needle.replace(/^@/, ""));
    });
    if (!rows.length) return '<p class="phase1-empty-note">Tidak ada akun yang cocok.</p>';
    return rows.map(function (user) {
      const checked = selectedIds.has(String(user.profile_id));
      const unit = user.unit ? " · " + user.unit : " · Unit belum tercatat";
      const role = user.role === "sarpras_admin" ? "Sarpras/Admin" : "Warga Madrasah";
      return '<label class="phase1-assignee-option"><input type="checkbox" name="executorIds" value="' + esc(user.profile_id) + '" ' + (checked ? "checked" : "") + '><span>' + phase1AvatarMarkup(user.avatar_path, user.display_name || user.username, "phase1-assignee-avatar") + '<span class="phase1-assignee-text"><strong>' + esc(user.display_name || user.username) + '</strong><small>@' + esc(user.username) + unit + '</small><small>' + esc(role) + '</small></span></span></label>';
    }).join("");
  }

  function phase1AssignmentControl(report) {
    phase1SelectedExecutorIds = new Set(Array.isArray(report.executorIds) ? report.executorIds.map(String) : []);
    const selected = phase1SelectedExecutorIds;
    const disabled = !phase1AssignableLoaded || !!phase1AssignableError;
    return '<fieldset class="phase1-assignee-field"><legend>PJ / pelaksana <span aria-hidden="true">*</span></legend><p class="small-note">Pilih satu atau beberapa akun aktif. Nama, username, dan unit ditampilkan agar akun yang dipilih tepat.</p><label class="phase1-assignee-search"><span class="sr-only">Cari akun penanggung jawab</span><input id="phase1AssigneeSearch" type="search" placeholder="Cari nama, username, atau unit…" autocomplete="off"></label><div id="phase1AssigneeList" class="phase1-assignee-list" aria-label="Daftar akun penanggung jawab">' + phase1AssigneeRows(selected, "") + '</div><p id="phase1AssigneeCount" class="small-note">' + selected.size + ' akun dipilih. Pilih minimal satu akun.</p></fieldset>';
  }

  function phase1ExistingAssignmentPanel(report) {
    return '<details class="phase1-reassign-panel"><summary>Ubah PJ / pelaksana</summary><div class="phase1-reassign-body">' + phase1AssignmentControl(report) + '<button type="button" class="btn small" data-action="assign" data-id="' + esc(report.id) + '" ' + (!phase1AssignableLoaded || phase1AssignableError ? "disabled" : "") + '>Simpan perubahan penugasan</button></div></details>';
  }

  function phase1PatchAssignmentChoices() {
    const list = document.getElementById("phase1AssigneeList");
    if (!list) return;
    const report = openReportId && getReport(openReportId);
    const selected = new Set(phase1SelectedExecutorIds);
    Array.from(list.querySelectorAll('input[name="executorIds"]:checked')).forEach(function (input) { selected.add(input.value); });
    phase1SelectedExecutorIds = selected;
    if (report && Array.isArray(report.executorIds) && !selected.size) report.executorIds.forEach(function (id) { phase1SelectedExecutorIds.add(String(id)); });
    const search = document.getElementById("phase1AssigneeSearch");
    list.innerHTML = phase1AssigneeRows(selected, search && search.value);
    void phase1HydrateAvatarImages(list);
    const button = document.querySelector('#modalBody [data-action="assign"]');
    if (button) button.disabled = !phase1AssignableLoaded || !!phase1AssignableError;
    const count = document.getElementById("phase1AssigneeCount");
    if (count) count.textContent = selected.size + ' akun dipilih. Pilih minimal satu akun.';
  }

  function phase1CanViewComments(report) {
    if (!appSession || !report) return false;
    const id = String(appSession.user.id || "");
    const executors = Array.isArray(report.executorIds) ? report.executorIds.map(String) : [];
    return isManager() || String(report.creatorProfileId || "") === id || executors.includes(id);
  }

  function phase1CommentsMarkup(report) {
    if (!phase1CanViewComments(report)) return "";
    return '<section class="phase1-discussion" aria-labelledby="phase1DiscussionHeading"><div class="divider"></div><div class="phase1-discussion-head"><div><h3 id="phase1DiscussionHeading">Diskusi tiket</h3><p>Hanya pelapor, akun yang ditugaskan, dan Sarpras/Admin yang dapat membaca atau menulis.</p></div></div><div id="phase1CommentList" class="phase1-comment-list" aria-live="polite"><p class="small-note">Memuat komentar…</p></div><form id="phase1CommentForm" data-report-id="' + esc(report.id) + '" class="phase1-comment-form"><label for="phase1CommentText">Tulis komentar <span class="small-note">(maks. 800 karakter)</span></label><textarea id="phase1CommentText" name="text" maxlength="800" required placeholder="Tulis informasi yang berkaitan dengan penanganan tiket ini."></textarea><div class="phase1-comment-form-foot"><span id="phase1CommentLength" class="small-note">0 / 800</span><button class="btn small" type="submit">Kirim komentar</button></div></form></section>';
  }

  function phase1CommentMarkup(comment) {
    return '<article class="phase1-comment">' + phase1AvatarMarkup(comment.avatar_path, comment.by, "phase1-comment-avatar") + '<div class="phase1-comment-body"><div class="phase1-comment-meta"><strong>' + esc(comment.by || "Pengguna") + '</strong><span class="badge ' + (comment.role === "Sarpras/Admin" ? "work" : "bar") + '">' + esc(comment.role || "Warga Madrasah") + '</span><time datetime="' + esc(comment.created_at || "") + '">' + esc(dateText(comment.created_at, true)) + '</time></div><p>' + esc(comment.text || "") + '</p></div></article>';
  }

  async function phase1LoadComments(reportId) {
    const list = document.getElementById("phase1CommentList");
    if (!list || !phase1CanViewComments(getReport(reportId))) return;
    const result = await supabaseClient.from("simlsp_report_comments")
      .select("id,report_id,by_user_id,by,role,text,avatar_path,created_at")
      .eq("report_id", reportId)
      .order("created_at", { ascending: true });
    if (result.error) {
      list.innerHTML = '<p class="phase1-inline-error">Diskusi gagal dimuat. Periksa sambungan lalu buka detail tiket lagi.</p>';
      return;
    }
    const comments = Array.isArray(result.data) ? result.data : [];
    list.innerHTML = comments.length ? comments.map(phase1CommentMarkup).join("") : '<p class="phase1-empty-note">Belum ada komentar. Gunakan diskusi ini untuk bertukar informasi tentang tiket.</p>';
    void phase1HydrateAvatarImages(list);
  }

  async function phase1SendComment(form) {
    const reportId = form.getAttribute("data-report-id");
    const field = form.elements.namedItem("text");
    const text = String(field && field.value || "").trim();
    if (!text || text.length > PHASE1_COMMENT_LIMIT) {
      toast("Komentar harus berisi 1 sampai 800 karakter.");
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.textContent = "Mengirim…";
    }
    const result = await supabaseClient.rpc("simlsp_add_report_comment", { p_report_id: reportId, p_text: text });
    if (result.error) {
      toast(result.error.message || "Komentar belum dapat dikirim.");
      if (button) {
        button.disabled = false;
        button.textContent = "Kirim komentar";
      }
      return;
    }
    if (field) field.value = "";
    const length = document.getElementById("phase1CommentLength");
    if (length) length.textContent = "0 / 800";
    await phase1LoadComments(reportId);
    await phase1RefreshNotifications();
    if (result.data && result.data.id) void phase1SendPushEvent("comment:" + result.data.id);
    toast("Komentar terkirim.");
    if (button) {
      button.disabled = false;
      button.textContent = "Kirim komentar";
    }
  }

  async function phase1AssignReport(actionElement) {
    if (!isManager()) {
      toast("Hanya Sarpras/Admin yang dapat menetapkan penanggung jawab.");
      return;
    }
    const report = getReport(actionElement.getAttribute("data-id"));
    if (!report) return;
    const ids = Array.from(phase1SelectedExecutorIds);
    const chosen = ids.map(function (id) {
      return phase1AssignableUsers.find(function (user) { return String(user.profile_id) === String(id); });
    }).filter(Boolean);
    if (!chosen.length || chosen.length !== ids.length) {
      toast("Pilih minimal satu akun aktif dari daftar penanggung jawab.");
      return;
    }
    const original = JSON.parse(JSON.stringify(report));
    const oldStatus = String(report.status || "");
    const names = chosen.map(function (user) { return String(user.display_name || user.username); });
    report.executorIds = chosen.map(function (user) { return String(user.profile_id); });
    report.pj = names[0];
    report.executor = names.join(", ");
    if (oldStatus === "ANTREAN") report.status = "DITUGASKAN";
    report.updatedAt = nowIso();
    activity(report, oldStatus === "ANTREAN" ? "Penanggung jawab ditetapkan: " + names.join(", ") + "." : "Penanggung jawab diperbarui: " + names.join(", ") + ".", true);
    if (report.status !== oldStatus) {
      report.statusUpdatedAt = nowIso();
      report.statusEventId = makeId();
    }
    if (!saveDb()) {
      Object.keys(report).forEach(function (key) { delete report[key]; });
      Object.assign(report, original);
      return;
    }
    clearTimeout(sharedSyncTimer);
    sharedSyncQueued = true;
    const committed = await syncSharedData();
    if (!committed) {
      Object.keys(report).forEach(function (key) { delete report[key]; });
      Object.assign(report, original);
      saveLocalDb();
      toast("Penugasan belum tersinkron. Data tiket dipulihkan di perangkat ini.");
      refreshDetail();
      return;
    }
    await refreshSharedData(true);
    await phase1RefreshNotifications();
    if (report.status !== oldStatus) void notifyReportStatus(report);
    void notifyQueueCount();
    toast("Penugasan tersimpan untuk " + chosen.length + " akun.");
    refreshDetail();
  }

  function phase1ProfileCard() {
    const currentPath = userProfile && userProfile.avatar_path || "";
    return '<section class="card phase1-profile-card" aria-labelledby="phase1ProfileHeading"><div><span class="stat-icon" aria-hidden="true">◉</span><h2 id="phase1ProfileHeading">Foto profil</h2><p>Foto ini tampil di header, daftar akun, dan diskusi tiket. Gambar diperkecil menjadi JPEG maksimal 256 × 256 piksel dan sekitar 150 KB.</p></div><div class="phase1-profile-editor">' + phase1AvatarMarkup(currentPath, currentActor, "phase1-profile-preview") + '<form id="phase1AvatarForm"><label class="field"><span class="field-label">Pilih foto profil</span><input id="phase1AvatarFile" name="avatar" type="file" accept="image/jpeg,image/png,image/webp" required></label><div class="phase1-profile-actions"><button class="btn small" type="submit">Simpan foto</button><button class="btn secondary small" type="button" data-action="removeAvatar" ' + (currentPath ? "" : "disabled") + '>Hapus foto</button></div><p id="phase1AvatarStatus" class="small-note" role="status" aria-live="polite"></p></form></div></section>';
  }

  async function phase1ImageFromFile(file) {
    if (window.createImageBitmap) return createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("File gambar tidak dapat dibuka."));
      };
      image.src = url;
    });
  }

  async function phase1CompressAvatar(file) {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Gunakan gambar JPG, PNG, atau WebP.");
    const image = await phase1ImageFromFile(file);
    let maxSide = 256;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * scale));
    let height = Math.max(1, Math.round(image.height * scale));
    let canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Kompresi foto tidak tersedia pada browser ini.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    if (image.close) image.close();
    for (const quality of [0.72, 0.62, 0.52, 0.44]) {
      const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
      if (blob && blob.size <= PHASE1_AVATAR_LIMIT) return blob;
    }
    maxSide = 192;
    const reducedScale = Math.min(1, maxSide / Math.max(width, height));
    const reduced = document.createElement("canvas");
    reduced.width = Math.max(1, Math.round(width * reducedScale));
    reduced.height = Math.max(1, Math.round(height * reducedScale));
    const reducedContext = reduced.getContext("2d", { alpha: false });
    reducedContext.fillStyle = "#ffffff";
    reducedContext.fillRect(0, 0, reduced.width, reduced.height);
    reducedContext.drawImage(canvas, 0, 0, reduced.width, reduced.height);
    const finalBlob = await new Promise(function (resolve) { reduced.toBlob(resolve, "image/jpeg", 0.48); });
    if (!finalBlob || finalBlob.size > PHASE1_AVATAR_LIMIT) throw new Error("Foto masih terlalu besar setelah dikompresi. Pilih gambar lain.");
    return finalBlob;
  }

  async function phase1SaveAvatar(form) {
    const fileInput = form.elements.namedItem("avatar");
    const file = fileInput && fileInput.files && fileInput.files[0];
    const status = document.getElementById("phase1AvatarStatus");
    const button = form.querySelector('button[type="submit"]');
    if (!file || !appSession) return;
    if (status) status.textContent = "Mengompresi foto…";
    if (button) {
      button.disabled = true;
      button.textContent = "Menyimpan…";
    }
    try {
      const compressed = await phase1CompressAvatar(file);
      if (status) status.textContent = "Mengunggah " + (compressed.size / 1024).toFixed(0) + " KB…";
      const path = "avatars/" + appSession.user.id + "/avatar.jpg";
      const upload = await supabaseClient.storage.from("user-avatars").upload(path, compressed, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: true
      });
      if (upload.error) throw upload.error;
      const saved = await supabaseClient.from("simlsp_profiles")
        .update({ avatar_path: path, avatar_updated_at: nowIso() })
        .eq("id", appSession.user.id)
        .select("avatar_path,avatar_updated_at")
        .maybeSingle();
      if (saved.error || !saved.data) throw saved.error || new Error("Profil tidak tersimpan.");
      userProfile = Object.assign({}, userProfile, saved.data);
      phase1AvatarUrlCache.delete(path);
      render();
      toast("Foto profil berhasil disimpan.");
    } catch (error) {
      if (status) status.textContent = error && error.message ? error.message : "Foto profil gagal disimpan.";
      if (button) {
        button.disabled = false;
        button.textContent = "Simpan foto";
      }
      return;
    }
    const nextButton = document.querySelector('#phase1AvatarForm button[type="submit"]');
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.textContent = "Simpan foto";
    }
  }

  async function phase1RemoveAvatar() {
    if (!appSession || !userProfile || !userProfile.avatar_path) return;
    if (!confirm("Hapus foto profil dari akun ini?")) return;
    const path = userProfile.avatar_path;
    const updated = await supabaseClient.from("simlsp_profiles")
      .update({ avatar_path: null, avatar_updated_at: nowIso() })
      .eq("id", appSession.user.id)
      .select("avatar_path,avatar_updated_at")
      .maybeSingle();
    if (updated.error || !updated.data) {
      toast("Foto profil belum dapat dihapus dari akun.");
      return;
    }
    userProfile = Object.assign({}, userProfile, updated.data);
    const removed = await supabaseClient.storage.from("user-avatars").remove([path]);
    phase1AvatarUrlCache.delete(path);
    render();
    toast(removed.error ? "Foto dilepas dari profil. File lama akan dibersihkan kemudian." : "Foto profil dihapus.");
  }

  function phase1InfoAttachmentType(file) {
    if (!file) return "";
    if (PHASE1_ALLOWED_INFO_TYPES.has(file.type)) return file.type;
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    const byExtension = {
      pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      csv: "text/csv", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp"
    };
    const type = byExtension[extension] || "";
    return PHASE1_ALLOWED_INFO_TYPES.has(type) ? type : "";
  }

  function phase1AttachmentMarkup(post) {
    if (!post.attachment_path) return "";
    const size = Number(post.attachment_size || 0);
    return '<div class="phase1-info-attachment" data-info-file-path="' + esc(post.attachment_path) + '"><span aria-hidden="true">↗</span><a href="#" data-info-file-link>' + esc(post.attachment_name || "Unduh lampiran") + '</a><small>' + esc(size ? (size / 1024).toFixed(0) + " KB" : "Lampiran") + '</small></div>';
  }

  function phase1InfoPostMarkup(post, index) {
    const isSopLink = post.kind === "sop_link";
    const category = String(post.category || "Pengumuman");
    const tone = isSopLink ? "sop" : category === "Jadwal" ? "schedule" : category === "Pengumuman" ? "announcement" : "other";
    const layer = index;
    const card = isSopLink
      ? '<button type="button" class="phase1-info-card phase1-info-sop-card tone-' + tone + ' gradient-' + esc(post.gradient || "mint") + '" data-p1-action="openInfoCard" data-id="' + esc(post.id) + '" aria-label="Buka SOP ' + esc(post.title) + '"><span class="phase1-info-card-kicker">SOP MADRASAH</span><strong>' + esc(post.title) + '</strong><span class="phase1-info-card-link">Buka panduan <span aria-hidden="true">↗</span></span></button>'
      : '<button type="button" class="phase1-info-card tone-' + tone + '" data-p1-action="openInfoCard" data-id="' + esc(post.id) + '" aria-label="Baca informasi ' + esc(post.title) + '"><span class="phase1-info-card-kicker">' + esc(category) + (post.pinned ? ' · DISEMATKAN' : "") + '</span><strong>' + esc(post.title) + '</strong><span class="phase1-info-card-excerpt">' + esc(String(post.body || "").slice(0, 190)) + '</span><span class="phase1-info-card-date">' + esc(dateText(post.created_at, true)) + '</span></button>';
    return '<div class="phase1-info-stack-layer" data-layer="' + layer + '" ' + (layer ? 'aria-hidden="true" inert' : "") + '>' + card + '</div>';
  }

  function phase1InfoEditorMarkup() {
    if (!isManager()) return "";
    const post = phase1InfoEditingId ? phase1InfoPosts.find(function (item) { return item.id === phase1InfoEditingId; }) : null;
    const category = post && post.category || "Pengumuman";
    const kind = post && post.kind || "info";
    const sopOptions = phase1SopDocuments.filter(function (doc) { return doc.active; }).map(function (doc) { return '<option value="' + esc(doc.id) + '" ' + (post && post.sop_id === doc.id ? "selected" : "") + '>' + esc(doc.title) + '</option>'; }).join("");
    return '<details class="card phase1-info-editor-card" aria-labelledby="phase1InfoEditorHeading" ' + (post ? "open" : "") + '><summary><span><strong id="phase1InfoEditorHeading">' + (post ? "Edit posting" : "Tulis info madrasah") + '</strong><small>Pengumuman dan tautan SOP · hanya Admin</small></span><span class="phase1-info-editor-chevron" aria-hidden="true">⌄</span></summary><div class="phase1-info-editor-body"><p>Post baru dapat mengirim pemberitahuan ke semua akun.</p><form id="phase1InfoForm" data-id="' + esc(post && post.id || "") + '"><div class="field"><label for="phase1InfoKind">Jenis posting</label><select id="phase1InfoKind" name="kind"><option value="info" ' + (kind === "info" ? "selected" : "") + '>Pengumuman atau jadwal</option><option value="sop_link" ' + (kind === "sop_link" ? "selected" : "") + '>Tautan ke SOP</option></select></div><div class="phase1-info-kind-fields" data-p1-field="info"><div class="field"><label for="phase1InfoTitle">Judul</label><input id="phase1InfoTitle" name="title" maxlength="120" ' + (kind === "info" ? "required" : "") + ' value="' + esc(post && post.title || "") + '" placeholder="Contoh: Jadwal pemeliharaan ruang kelas"></div><div class="field"><label for="phase1InfoPostCategory">Kategori</label><select id="phase1InfoPostCategory" name="category"><option ' + (category === "Pengumuman" ? "selected" : "") + '>Pengumuman</option><option ' + (category === "Jadwal" ? "selected" : "") + '>Jadwal</option><option ' + (category === "Lainnya" ? "selected" : "") + '>Lainnya</option></select></div><div class="field"><label for="phase1InfoBody">Isi informasi</label><textarea id="phase1InfoBody" name="body" maxlength="4000" ' + (kind === "info" ? "required" : "") + ' placeholder="Tulis informasi dengan jelas.">' + esc(post && post.kind !== "sop_link" ? post.body || "" : "") + '</textarea><small class="small-note">Teks ditampilkan sebagai teks biasa.</small></div><div class="field"><label for="phase1InfoFile">Lampiran tambahan (opsional, maksimal 10 MB)</label><input id="phase1InfoFile" name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,image/jpeg,image/png,image/webp"></div>' + (post && post.attachment_path ? '<div class="phase1-current-attachment">Lampiran saat ini: ' + esc(post.attachment_name || "File") + '<label><input type="checkbox" name="removeAttachment"> Hapus lampiran saat menyimpan</label></div>' : "") + '</div><div class="phase1-info-kind-fields" data-p1-field="sop_link" ' + (kind === "sop_link" ? "" : "hidden") + '><div class="field"><label for="phase1InfoSopId">Pilih SOP</label><select id="phase1InfoSopId" name="sop_id" ' + (kind === "sop_link" ? "required" : "") + '><option value="">Pilih SOP yang aktif</option>' + sopOptions + '</select><small class="small-note" data-sop-empty-hint ' + (sopOptions ? "hidden" : "") + '>Belum ada SOP aktif. Tambahkan SOP terlebih dahulu di menu SOP dan Informasi.</small></div><div class="field"><label for="phase1InfoGradient">Warna aksen kartu</label><select id="phase1InfoGradient" name="gradient"><option value="mint" ' + (!post || post.gradient === "mint" ? "selected" : "") + '>Hijau mint</option><option value="teal" ' + (post && post.gradient === "teal" ? "selected" : "") + '>Teal</option><option value="blue" ' + (post && post.gradient === "blue" ? "selected" : "") + '>Biru</option><option value="gold" ' + (post && post.gradient === "gold" ? "selected" : "") + '>Emas</option></select></div></div><label class="checkline"><input type="checkbox" name="pinned" ' + (post && post.pinned ? "checked" : "") + '> <span>Sematkan di bagian atas</span></label><label class="checkline"><input type="checkbox" name="notify_all" ' + (post && post.notify_all ? "checked" : "") + '> <span>Kirim pemberitahuan ke semua akun saat diposting</span></label><div class="phase1-info-editor-actions"><button type="submit" class="btn">' + (post ? "Simpan perubahan" : "Terbitkan posting") + '</button>' + (post ? '<button type="button" class="btn secondary" data-p1-action="cancelInfoEdit">Batal edit</button>' : "") + '</div><p id="phase1InfoFormStatus" role="status" aria-live="polite" class="small-note"></p></form></div></details>';
  }

  function phase1RenderInfoList() {
    const host = document.getElementById(currentView === "dashboard" ? "phase1DashboardInfoPostList" : "phase1InfoPostList");
    if (!host) return;
    const isDashboard = host.id === "phase1DashboardInfoPostList";
    if (phase1InfoError) {
      host.innerHTML = '<div class="banner warning-banner"><span>⚠</span><div><strong>Info Madrasah belum dapat dimuat</strong>' + esc(phase1InfoError) + '</div></div>';
      return;
    }
    if (phase1InfoLoading && !phase1InfoLoadedAt) {
      host.innerHTML = '<div class="empty"><strong>Memuat Info Madrasah…</strong></div>';
      return;
    }
    const rows = phase1InfoPosts.filter(function (post) { return isDashboard || phase1InfoCategory === "Semua" || post.category === phase1InfoCategory; });
    rows.sort(function (a, b) { return Number(!!b.pinned) - Number(!!a.pinned) || String(b.created_at || "").localeCompare(String(a.created_at || "")); });
    if (rows.length && phase1InfoIndex >= rows.length) phase1InfoIndex = 0;
    if (phase1InfoDetailId) {
      const selected = rows.find(function (post) { return post.id === phase1InfoDetailId; });
      if (selected && selected.kind === "info") {
        const author = selected.by || "Sarpras/Admin";
        host.innerHTML = '<section class="phase1-info-detail"><button type="button" class="btn secondary small" data-p1-action="backToInfoCards">← Kembali ke kartu</button><div class="phase1-info-post-head"><div class="phase1-info-author">' + phase1AvatarMarkup(selected.avatar_path || "", author, "phase1-info-avatar") + '<span><strong>' + esc(author) + '</strong><small>' + esc(selected.role || "Sarpras/Admin") + ' · ' + esc(dateText(selected.created_at, true)) + '</small></span></div><span class="badge work">' + esc(selected.category || "Pengumuman") + '</span></div><h2>' + esc(selected.title) + '</h2><p class="phase1-info-body">' + esc(selected.body || "") + '</p>' + phase1AttachmentMarkup(selected) + (isManager() ? '<div class="phase1-info-actions"><button type="button" class="btn secondary small" data-p1-action="editInfoPost" data-id="' + esc(selected.id) + '">Edit posting</button><button type="button" class="btn danger small" data-p1-action="deleteInfoPost" data-id="' + esc(selected.id) + '">Hapus posting</button></div>' : "") + '</section>';
        void phase1HydrateAvatarImages(host);
        void phase1HydrateInfoLinks(host);
        return;
      }
      phase1InfoDetailId = "";
    }
    if (isDashboard && rows.length) {
      const post = rows[phase1InfoIndex];
      const category = String(post.category || (post.kind === "sop_link" ? "SOP" : "Pengumuman"));
      const tone = post.kind === "sop_link" ? "sop" : category === "Jadwal" ? "schedule" : category === "Pengumuman" ? "announcement" : "other";
      const preview = post.kind === "sop_link" ? "Buka panduan SOP" : String(post.body || "").replace(/\s+/g, " ").trim();
      const dashboardPager = rows.length > 1
        ? '<div class="phase1-dashboard-info-controls"><span class="phase1-dashboard-info-pagination" role="status" aria-live="polite" aria-label="Info ' + (phase1InfoIndex + 1) + ' dari ' + rows.length + '"><span class="sr-only">Geser kartu untuk melihat informasi lainnya. Info ' + (phase1InfoIndex + 1) + ' dari ' + rows.length + '.</span>' + rows.map(function (_, index) { return '<i class="' + (index === phase1InfoIndex ? "is-active" : "") + '" aria-hidden="true"></i>'; }).join("") + '</span><div class="phase1-dashboard-info-arrows"><button type="button" class="phase1-carousel-arrow" data-p1-action="previousInfoCard" aria-label="Info sebelumnya">‹</button><button type="button" class="phase1-carousel-arrow" data-p1-action="nextInfoCard" aria-label="Info berikutnya">›</button></div></div>'
        : "";
      host.innerHTML = '<div class="phase1-info-carousel phase1-dashboard-info-carousel" id="phase1InfoStack" aria-label="Info Madrasah"><div class="phase1-dashboard-info-current"><button type="button" class="phase1-info-card phase1-dashboard-info-card tone-' + tone + '" data-p1-action="openInfoCard" data-id="' + esc(post.id) + '" aria-label="Baca ' + esc(category) + ': ' + esc(post.title) + '"><span class="phase1-info-card-kicker">' + esc(category) + (post.pinned ? ' · DISEMATKAN' : "") + '</span><strong>' + esc(post.title) + '</strong><span class="phase1-info-card-excerpt">' + esc(preview || "Buka untuk membaca selengkapnya") + '</span></button></div>' + dashboardPager + '</div>';
      phase1AttachInfoCarouselEvents();
      return;
    }
    const available = rows.length ? Array.from({ length: Math.min(3, rows.length) }, function (_, index) { return rows[(phase1InfoIndex + index) % rows.length]; }) : [];
    host.innerHTML = rows.length
      ? '<div class="phase1-info-carousel" id="phase1InfoStack" aria-label="Kartu informasi madrasah"><div class="phase1-info-stack">' + available.map(function (post, index) { return phase1InfoPostMarkup(post, index); }).join("") + '</div>' + (isManager() ? '<div class="phase1-info-card-admin"><button type="button" class="btn secondary small" data-p1-action="editInfoPost" data-id="' + esc(rows[phase1InfoIndex].id) + '">Edit kartu</button><button type="button" class="btn danger small" data-p1-action="deleteInfoPost" data-id="' + esc(rows[phase1InfoIndex].id) + '">Hapus kartu</button></div>' : "") + '<div class="phase1-info-carousel-controls"><button type="button" class="phase1-carousel-arrow" data-p1-action="previousInfoCard" aria-label="Kartu sebelumnya" ' + (rows.length < 2 ? "disabled" : "") + '>‹</button><span class="phase1-info-count" aria-live="off">' + (phase1InfoIndex + 1) + ' / ' + rows.length + '</span><button type="button" class="phase1-carousel-arrow" data-p1-action="nextInfoCard" aria-label="Kartu berikutnya" ' + (rows.length < 2 ? "disabled" : "") + '>›</button></div></div>'
      : '<div class="empty"><div class="empty-ico">▣</div><strong>' + (phase1InfoPosts.length ? "Tidak ada informasi pada kategori ini" : "Belum ada informasi") + '</strong><span>Sarpras/Admin dapat menambahkan pengumuman atau jadwal.</span></div>';
    if (rows.length) phase1AttachInfoCarouselEvents();
  }

  async function phase1HydrateInfoLinks(root) {
    if (!root || !supabaseClient) return;
    const rows = Array.from(root.querySelectorAll("[data-info-file-path]"));
    for (const row of rows) {
      const path = row.getAttribute("data-info-file-path");
      const link = row.querySelector("[data-info-file-link]");
      if (!path || !link || link.dataset.loaded === "true") continue;
      link.dataset.loaded = "true";
      const url = await phase1SignedStorageUrl("info-board-files", path, phase1InfoUrlCache);
      if (!url || !link.isConnected) {
        link.removeAttribute("href");
        link.textContent = "Lampiran belum dapat dibuka";
      } else {
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
  }

  async function phase1LoadInfo(force) {
    if (!appSession || !supabaseClient || phase1InfoLoading) return;
    if (!force && Date.now() - phase1InfoLoadedAt < 45000) return;
    phase1InfoLoading = true;
    phase1InfoError = "";
    phase1RenderInfoList();
    const result = await supabaseClient.from("simlsp_info_posts")
      .select("id,created_by,by,role,avatar_path,title,body,kind,sop_id,gradient,notify_all,category,pinned,attachment_path,attachment_name,attachment_content_type,attachment_size,created_at,updated_at")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    phase1InfoLoading = false;
    if (result.error) {
      phase1InfoError = result.error.message || "Periksa koneksi dan izin Info Madrasah.";
      phase1InfoLoadedAt = 0;
    } else {
      phase1InfoPosts = Array.isArray(result.data) ? result.data : [];
      phase1InfoLoadedAt = Date.now();
    }
    phase1RenderInfoList();
  }

  function phase1RenderInfo() {
    const categoryOptions = ["Semua", "Pengumuman", "SOP", "Jadwal", "Lainnya"];
    return pageHead("Pusat informasi", "Informasi Madrasah", "Pengumuman resmi, jadwal, SOP, dan panduan madrasah.", "") +
      phase1InformationTabs("info") +
      (isManager() ? phase1InfoEditorMarkup() : '<div class="banner"><span aria-hidden="true">▣</span><div><strong>Informasi resmi madrasah</strong>Warga dapat membaca pengumuman dan lampiran. Kanal ini tidak menyediakan balasan publik.</div></div>') +
      '<section class="phase1-info-board"><div class="phase1-info-filter"><div><h2>Informasi terbaru</h2><p>Kartu sematan tampil lebih dahulu, lalu posting terbaru.</p></div><label class="field"><span class="field-label">Filter kategori</span><select id="phase1InfoCategory">' + categoryOptions.map(function (category) { return '<option ' + (category === phase1InfoCategory ? "selected" : "") + '>' + esc(category) + '</option>'; }).join("") + '</select></label><button type="button" class="btn secondary small" data-p1-action="refreshInfo">Muat ulang</button></div><div id="phase1InfoPostList" class="phase1-info-post-list" aria-live="polite"></div></section>';
  }

  function phase1InformationTabs(active) {
    return '<nav class="phase1-info-section-tabs" aria-label="Bagian Informasi Madrasah"><button type="button" data-view="info" ' + (active === "info" ? 'aria-current="page"' : "") + '>Pengumuman</button><button type="button" data-view="sop" ' + (active === "sop" ? 'aria-current="page"' : "") + '>SOP &amp; Panduan</button></nav>';
  }

  function phase1DashboardInfoMarkup() {
    return '<section class="phase1-dashboard-info-board" aria-labelledby="phase1DashboardInfoHeading"><div class="phase1-dashboard-info-head"><h2 id="phase1DashboardInfoHeading">Info Madrasah</h2><button type="button" class="btn secondary small" data-view="info">Semua info</button></div><div id="phase1DashboardInfoPostList" class="phase1-info-post-list" aria-live="polite"></div></section>';
  }

  function phase1RenderDashboardInfo() {
    const content = document.getElementById("content");
    if (!content) return;
    let inserted = false;
    const transparency = Array.from(content.querySelectorAll(".banner")).find(function (item) {
      const heading = item.querySelector("strong");
      return heading && heading.textContent.trim() === "Transparansi laporan";
    });
    if (transparency) {
      const stats = content.querySelector(".grid.stats");
      transparency.remove();
      if (stats) {
        stats.insertAdjacentHTML("afterend", phase1DashboardInfoMarkup());
        inserted = true;
      }
    } else {
      const citizenLatest = content.querySelector(".citizen-latest-card");
      if (citizenLatest) {
        citizenLatest.insertAdjacentHTML("afterend", phase1DashboardInfoMarkup());
        inserted = true;
      }
    }
    if (!inserted) return;
    phase1InfoDetailId = "";
    phase1RenderInfoList();
    void phase1LoadInfo(false);
    void phase1LoadSops(false);
  }

  function phase1UpdateInfoKindFields(form) {
    if (!form) return;
    const kind = form.elements.namedItem("kind").value === "sop_link" ? "sop_link" : "info";
    Array.from(form.querySelectorAll("[data-p1-field]")).forEach(function (field) {
      field.hidden = field.getAttribute("data-p1-field") !== kind;
    });
    const title = form.elements.namedItem("title");
    const body = form.elements.namedItem("body");
    const sop = form.elements.namedItem("sop_id");
    if (title) title.required = kind === "info";
    if (body) body.required = kind === "info";
    if (sop) sop.required = kind === "sop_link";
  }

  function phase1SopType(file) {
    const name = String(file && file.name || "").toLowerCase();
    const mime = String(file && file.type || "").toLowerCase();
    if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
    if (/\.(png|jpe?g|webp)$/.test(name) || /^image\/(png|jpeg|webp)$/.test(mime)) return "image";
    if (name.endsWith(".doc") || name.endsWith(".docx") || mime === "application/msword" || mime.indexOf("wordprocessingml") >= 0) return "word";
    if (name.endsWith(".xlsx") || name.endsWith(".csv") || mime.indexOf("spreadsheetml") >= 0 || mime === "text/csv") return "excel";
    return "";
  }

  function phase1SopExtension(file) {
    const name = String(file && file.name || "").toLowerCase();
    const match = name.match(/\.([a-z0-9]{1,8})$/);
    return match ? match[1] : "";
  }

  function phase1SopMime(file, type) {
    const extension = phase1SopExtension(file);
    const map = {
      pdf: "application/pdf", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      csv: "text/csv", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp"
    };
    return map[extension] || (file && file.type) || (type === "image" ? "image/jpeg" : "application/octet-stream");
  }

  async function phase1LoadSops(force) {
    if (!appSession || !supabaseClient) return;
    if (!force && Date.now() - phase1SopLoadedAt < 45000) return;
    if (phase1SopLoadPromise) return phase1SopLoadPromise;
    phase1SopLoading = true;
    phase1SopError = "";
    const generation = phase1SopLoadGeneration;
    phase1SopLoadPromise = (async function () {
      try {
        const result = await supabaseClient.rpc("simlsp_list_sop_catalog");
        if (generation !== phase1SopLoadGeneration) return;
        phase1SopLoading = false;
        if (result.error) {
          phase1SopError = result.error.message || "Periksa koneksi dan izin katalog SOP.";
          phase1SopLoadedAt = 0;
        } else {
          phase1SopDocuments = Array.isArray(result.data) ? result.data : [];
          phase1SopDocuments = phase1SopDocuments.map(function (doc) {
            if (doc && doc.document) return doc.document;
            return doc;
          }).filter(function (doc) { return doc && typeof doc === "object"; });
          phase1SopLoadedAt = Date.now();
          if (phase1SelectedSopId && !phase1SopDocuments.some(function (doc) { return doc.id === phase1SelectedSopId; })) phase1SelectedSopId = "";
          if (phase1InfoIndex >= phase1InfoPosts.length) phase1InfoIndex = 0;
        }
        phase1UpdateInfoSopOptions();
        if (currentView === "sop") phase1RefreshSopView();
      } catch (error) {
        if (generation !== phase1SopLoadGeneration) return;
        phase1SopError = error && error.message || "Katalog SOP gagal dimuat.";
        phase1SopLoadedAt = 0;
        if (currentView === "sop") phase1RefreshSopView();
      }
    })();
    const pending = phase1SopLoadPromise;
    try { await pending; }
    finally {
      if (phase1SopLoadPromise === pending) {
        phase1SopLoading = false;
        phase1SopLoadPromise = null;
      }
    }
  }

  function phase1UpdateInfoSopOptions() {
    const select = document.getElementById("phase1InfoSopId");
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Pilih SOP yang aktif</option>' + phase1SopDocuments.filter(function (doc) { return doc.active; }).map(function (doc) {
      return '<option value="' + esc(doc.id) + '">' + esc(doc.title) + '</option>';
    }).join("");
    const editing = select.form && phase1InfoPosts.find(function (post) { return post.id === select.form.getAttribute("data-id"); });
    const preferred = current || editing && editing.sop_id || "";
    if (phase1SopDocuments.some(function (doc) { return doc.id === preferred && doc.active; })) select.value = preferred;
    const hint = select.parentElement.querySelector("[data-sop-empty-hint]");
    if (hint) hint.hidden = phase1SopDocuments.some(function (doc) { return doc.active; });
  }

  function phase1SopFileMarkup(file) {
    const labels = { pdf: "PDF", image: "Gambar", excel: "Tabel Excel", word: "Dokumen Word" };
    const preview = file.file_type === "excel"
      ? phase1SopTableMarkup(file.preview_data)
      : '<div class="phase1-sop-preview" data-sop-preview-path="' + esc(file.preview_path || "") + '" data-sop-preview-type="' + esc(file.file_type) + '"><p class="small-note">Memuat pratinjau…</p></div>';
    return '<article class="phase1-sop-file"><header class="phase1-sop-file-head"><div><strong>' + esc(file.title) + '</strong><span>' + esc(labels[file.file_type] || "Dokumen") + ' · ' + esc(formatPhotoSize(file.size_bytes)) + '</span></div><div class="phase1-sop-file-actions">' + (isManager() ? '<button type="button" class="btn secondary small" data-p1-action="downloadSopOriginal" data-id="' + esc(file.id) + '">Unduh asli</button><button type="button" class="btn secondary small" data-p1-action="toggleSopReplacement" data-id="' + esc(file.id) + '">Ganti file</button><button type="button" class="btn danger small" data-p1-action="deleteSopFile" data-id="' + esc(file.id) + '">Hapus file</button>' : "") + '</div></header>' + preview + (isManager() ? '<div class="phase1-sop-replace-panel" id="phase1SopReplacePanel-' + esc(file.id) + '" hidden><form class="phase1-sop-replace-form" data-replace-id="' + esc(file.id) + '"><label class="field"><span class="field-label">Nama tampilan file</span><input name="title" maxlength="160" required value="' + esc(file.title) + '"></label><label class="field"><span class="field-label">File pengganti</span><input class="phase1-sop-replacement-original" name="original" type="file" required accept=".pdf,.doc,.docx,.xlsx,.csv,.jpg,.jpeg,.png,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,image/jpeg,image/png,image/webp"></label><label class="field phase1-sop-replacement-pdf" hidden><span class="field-label">PDF pratinjau pengganti (wajib untuk Word)</span><input name="preview" type="file" accept=".pdf,application/pdf"></label><button type="submit" class="btn secondary">Simpan file pengganti</button><p class="small-note" role="status" aria-live="polite"></p></form></div>' : "") + '</article>';
  }

  function phase1SopTableMarkup(data) {
    const rows = Array.isArray(data) ? data.slice(0, PHASE1_SOP_MAX_ROWS) : [];
    if (!rows.length) return '<div class="phase1-sop-table-empty">Pratinjau tabel belum tersedia.</div>';
    const headers = Array.isArray(rows[0]) ? rows[0] : [];
    return '<div class="phase1-sop-table-wrap" role="region" aria-label="Tabel pratinjau SOP" tabindex="0"><table class="phase1-sop-table"><thead><tr>' + headers.map(function (cell, index) { return '<th scope="col">' + esc(cell || ("Kolom " + (index + 1))) + '</th>'; }).join("") + '</tr></thead><tbody>' + rows.slice(1).map(function (row) {
      return '<tr>' + headers.map(function (_, index) { return '<td>' + esc(Array.isArray(row) ? row[index] || "" : "") + '</td>'; }).join("") + '</tr>';
    }).join("") + '</tbody></table></div>';
  }

  function phase1SopDocumentMarkup(doc) {
    return '<button type="button" class="phase1-sop-card" data-p1-action="openSop" data-id="' + esc(doc.id) + '"><span class="phase1-sop-card-mark" aria-hidden="true">▧</span><strong>' + esc(doc.title) + '</strong></button>';
  }

  function phase1RenderSop() {
    let html = pageHead("Pusat informasi", "Informasi Madrasah", "Pengumuman resmi, jadwal, SOP, dan panduan madrasah.", "");
    html += phase1InformationTabs("sop");
    html += '<div class="banner sla-inline"><span aria-hidden="true">◷</span><div><strong>Standar layanan laporan</strong><span>Verifikasi ' + esc(TRUST_SLA_CONFIG.verification) + ' · tindak lanjut ' + esc(TRUST_SLA_CONFIG.followUp) + '.</span></div></div>';
    if (phase1SopError) return html + '<div class="banner warning-banner"><span aria-hidden="true">⚠</span><div><strong>Katalog SOP belum dapat dimuat</strong>' + esc(phase1SopError) + '<button type="button" class="btn secondary small" data-p1-action="refreshSops">Coba lagi</button></div></div>';
    const doc = phase1SopDocuments.find(function (item) { return item.id === phase1SelectedSopId && (item.active || isManager()); });
    if (phase1SelectedSopId && doc) {
      html += '<section class="phase1-sop-detail"><button type="button" class="btn secondary small" data-p1-action="backToSopList">← Semua SOP</button><div class="phase1-sop-detail-heading"><div><span class="eyebrow">PANDUAN MADRASAH</span><h2>' + esc(doc.title) + '</h2>' + (doc.description ? '<p>' + esc(doc.description) + '</p>' : "") + '</div>' + (isManager() ? '<button type="button" class="btn danger small" data-p1-action="deleteSop" data-id="' + esc(doc.id) + '">Hapus SOP</button>' : "") + '</div>';
      if (isManager()) html += '<details class="phase1-sop-admin-edit"><summary>Edit judul / keterangan</summary><form id="phase1SopEditForm" data-id="' + esc(doc.id) + '"><label class="field"><span class="field-label">Judul SOP</span><input name="title" maxlength="120" required value="' + esc(doc.title) + '"></label><label class="field"><span class="field-label">Keterangan</span><textarea name="description" maxlength="1000">' + esc(doc.description || "") + '</textarea></label><label class="checkline"><input type="checkbox" name="active" ' + (doc.active ? "checked" : "") + '> <span>Tampilkan untuk warga</span></label><button type="submit" class="btn secondary">Simpan perubahan</button></form></details>';
      const files = Array.isArray(doc.files) ? doc.files : [];
      html += files.length ? '<div class="phase1-sop-file-list">' + files.map(phase1SopFileMarkup).join("") + '</div>' : '<div class="empty"><strong>Belum ada file di dalam SOP ini</strong><span>' + (isManager() ? 'Unggah file di bawah untuk mulai mengisi panduan.' : 'Sarpras/Admin akan menambahkan isi panduan.') + '</span></div>';
      if (isManager()) html += '<section class="card phase1-sop-upload-card"><h3>Tambah file ke SOP</h3><p>Warga akan melihat pratinjau dalam aplikasi. File asli hanya dapat diunduh Admin.</p><form id="phase1SopFileForm" data-id="' + esc(doc.id) + '"><label class="field"><span class="field-label">Nama tampilan</span><input name="title" maxlength="160" required placeholder="Contoh: Alur peminjaman"></label><label class="field"><span class="field-label">File asli</span><input id="phase1SopOriginal" name="original" type="file" required accept=".pdf,.doc,.docx,.xlsx,.csv,.jpg,.jpeg,.png,.webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,image/jpeg,image/png,image/webp"></label><label class="field" id="phase1SopPdfField" hidden><span class="field-label">Pratinjau PDF untuk warga (wajib untuk Word)</span><input name="preview" type="file" accept=".pdf,application/pdf"></label><p class="small-note">Word: unggah file asli dan PDF pratinjau. Excel (.xlsx/CSV) ditampilkan sebagai tabel; PDF dan gambar dibuka di viewer. Maksimal 10 MB per file.</p><button type="submit" class="btn">Tambah file</button><p id="phase1SopFormStatus" class="small-note" role="status" aria-live="polite"></p></form></section>';
      html += '</section>';
      return html;
    }
    if (phase1SopLoading && !phase1SopLoadedAt) return html + '<div class="empty"><strong>Memuat katalog SOP…</strong></div>';
    if (isManager()) html += '<section class="card phase1-sop-create-card"><h2>Tambah judul SOP</h2><form id="phase1SopCreateForm"><label class="field"><span class="field-label">Judul</span><input name="title" maxlength="120" required placeholder="Contoh: SOP Peminjaman Sarana"></label><label class="field"><span class="field-label">Keterangan (opsional)</span><textarea name="description" maxlength="1000" placeholder="Ringkasan singkat isi panduan"></textarea></label><button type="submit" class="btn">Buat SOP</button><p class="small-note" role="status" aria-live="polite">' + esc(phase1SopMessage) + '</p></form></section>';
    const docs = phase1SopDocuments.filter(function (item) { return item.active || isManager(); });
    html += docs.length ? '<section class="phase1-sop-grid" aria-label="Daftar SOP">' + docs.map(phase1SopDocumentMarkup).join("") + '</section>' : '<section class="phase1-sop-empty" aria-label="Katalog SOP kosong"><span class="phase1-sop-empty-icon" aria-hidden="true">▧</span><strong>Belum ada SOP</strong><span>' + (isManager() ? 'Tambahkan judul SOP, lalu unggah satu atau beberapa file.' : 'Panduan madrasah akan ditampilkan di sini setelah Admin menambahkannya.') + '</span><small>Contoh: SOP Peminjaman Sarana</small></section>';
    return html;
  }

  function phase1RefreshSopView() {
    const content = document.getElementById("content");
    if (!content || currentView !== "sop") return;
    content.innerHTML = phase1RenderSop();
    void phase1HydrateSopPreviews(content);
  }

  async function phase1HydrateSopPreviews(root) {
    if (!root || !supabaseClient) return;
    for (const node of Array.from(root.querySelectorAll("[data-sop-preview-path]"))) {
      const path = node.getAttribute("data-sop-preview-path");
      const type = node.getAttribute("data-sop-preview-type");
      if (!path) {
        node.innerHTML = '<p class="small-note">Pratinjau file belum tersedia.</p>';
        continue;
      }
      const cacheKey = "preview:" + path;
      let url = phase1SopUrlCache.get(cacheKey);
      if (!url || url.expiresAt < Date.now() + 30000) {
        const signed = await supabaseClient.storage.from("sop-files").createSignedUrl(path, 900, { download: false });
        if (signed.error || !signed.data || !signed.data.signedUrl) {
          node.innerHTML = '<p class="phase1-inline-error">Pratinjau tidak dapat dibuka. Periksa izin Storage.</p>';
          continue;
        }
        url = { url: signed.data.signedUrl, expiresAt: Date.now() + 850000 };
        phase1SopUrlCache.set(cacheKey, url);
      }
      if (!node.isConnected) continue;
      if (type === "image") node.innerHTML = '<img class="phase1-sop-preview-image" src="' + esc(url.url) + '" alt="Pratinjau ' + esc(node.closest(".phase1-sop-file").querySelector(".phase1-sop-file-head strong").textContent) + '" loading="lazy">';
      else node.innerHTML = '<iframe class="phase1-sop-preview-pdf" src="' + esc(url.url) + '#toolbar=0&navpanes=0&scrollbar=1" title="Pratinjau PDF ' + esc(node.closest(".phase1-sop-file").querySelector(".phase1-sop-file-head strong").textContent) + '" loading="lazy"></iframe>';
    }
  }

  async function phase1CreateSop(form) {
    if (!isManager()) return;
    const data = new FormData(form);
    const title = String(data.get("title") || "").trim();
    const description = String(data.get("description") || "").trim();
    if (!title || title.length > 120 || description.length > 1000) throw new Error("Judul atau keterangan SOP belum valid.");
    const result = await supabaseClient.from("simlsp_sop_documents").insert({ title: title, description: description, created_by: appSession.user.id, updated_by: appSession.user.id }).select("id").maybeSingle();
    if (result.error || !result.data) throw result.error || new Error("SOP belum tersimpan.");
    phase1SopLoadedAt = 0;
    phase1SopMessage = "SOP berhasil dibuat. Tambahkan file ke dalamnya.";
    await phase1LoadSops(true);
    phase1SelectedSopId = result.data.id;
    phase1RefreshSopView();
  }

  async function phase1UpdateSop(form) {
    if (!isManager()) return;
    const data = new FormData(form);
    const id = String(form.getAttribute("data-id") || "");
    const title = String(data.get("title") || "").trim();
    const description = String(data.get("description") || "").trim();
    if (!id || !title || title.length > 120 || description.length > 1000) throw new Error("Judul atau keterangan SOP belum valid.");
    const result = await supabaseClient.from("simlsp_sop_documents").update({ title: title, description: description, active: data.get("active") === "on", updated_by: appSession.user.id }).eq("id", id).select("id").maybeSingle();
    if (result.error || !result.data) throw result.error || new Error("Perubahan SOP belum tersimpan.");
    phase1SopLoadedAt = 0;
    await phase1LoadSops(true);
    toast("SOP diperbarui.");
  }

  async function phase1ParseSopTable(file) {
    const extension = phase1SopExtension(file);
    let rows;
    if (extension === "csv") rows = parseCsvText(await file.text());
    else if (extension === "xlsx") rows = await parseXlsxFile(file);
    else throw new Error("Untuk pratinjau tabel, gunakan Excel .xlsx atau simpan sebagai CSV UTF-8.");
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > PHASE1_SOP_MAX_ROWS) throw new Error("Tabel pratinjau harus berisi maksimal 500 baris data ditambah header.");
    const cleaned = rows.map(function (row) {
      if (!Array.isArray(row)) throw new Error("Baris Excel tidak terbaca sebagai tabel.");
      if (row.length > PHASE1_SOP_MAX_COLUMNS) throw new Error("Pratinjau Excel maksimal 30 kolom.");
      return Array.from({ length: Math.max(row.length, 1) }, function (_, index) { return String(row[index] == null ? "" : row[index]).slice(0, 1000); });
    });
    const byteCount = new TextEncoder().encode(JSON.stringify(cleaned)).length;
    if (byteCount > PHASE1_SOP_TABLE_MAX_BYTES) throw new Error("Data tabel pratinjau melebihi 2 MB. Ringkas tabel lalu unggah ulang.");
    return cleaned;
  }

  function phase1SafeSopFilename(file) {
    const ext = phase1SopExtension(file);
    if (!/^(pdf|doc|docx|xlsx|csv|png|jpg|jpeg|webp)$/.test(ext)) throw new Error("Jenis file belum didukung.");
    return (window.crypto && crypto.randomUUID ? crypto.randomUUID() : makeId()) + "." + ext;
  }

  async function phase1UploadSopObject(sopId, file) {
    const path = "sop/" + sopId + "/" + phase1SafeSopFilename(file);
    const upload = await supabaseClient.storage.from("sop-files").upload(path, file, {
      contentType: phase1SopMime(file, phase1SopType(file)),
      cacheControl: "3600",
      upsert: false
    });
    if (upload.error) throw upload.error;
    return path;
  }

  async function phase1AddSopFile(form) {
    if (!isManager()) throw new Error("Hanya Sarpras/Admin yang dapat menambahkan file SOP.");
    const data = new FormData(form);
    const replaceId = String(form.getAttribute("data-replace-id") || "");
    const priorDoc = replaceId ? phase1SopDocuments.find(function (item) { return (item.files || []).some(function (entry) { return entry.id === replaceId; }); }) : null;
    const priorFile = priorDoc && priorDoc.files.find(function (entry) { return entry.id === replaceId; });
    const sopId = String(form.getAttribute("data-id") || priorDoc && priorDoc.id || "");
    const original = form.elements.namedItem("original").files[0];
    const preview = form.elements.namedItem("preview").files[0] || null;
    const title = String(data.get("title") || "").trim();
    if (!sopId || !original || !title || title.length > 160) throw new Error("Nama file dan file asli wajib diisi.");
    if (original.size < 1 || original.size > PHASE1_INFO_FILE_LIMIT) throw new Error("File asli maksimal 10 MB.");
    const type = phase1SopType(original);
    if (!type) throw new Error("Gunakan PDF, Word, Excel (.xlsx/CSV), atau gambar JPG/PNG/WebP.");
    if (type === "word" && (!preview || phase1SopType(preview) !== "pdf")) throw new Error("Untuk Word, unggah PDF pratinjau juga.");
    if (preview && (preview.size < 1 || preview.size > PHASE1_INFO_FILE_LIMIT || phase1SopType(preview) !== "pdf")) throw new Error("Pratinjau harus PDF maksimal 10 MB.");
    const previewData = type === "excel" ? await phase1ParseSopTable(original) : null;
    const uploadedPaths = [];
    try {
      const originalPath = await phase1UploadSopObject(sopId, original);
      uploadedPaths.push(originalPath);
      let previewPath = null;
      let previewSize = null;
      if (type === "word") {
        previewPath = await phase1UploadSopObject(sopId, preview);
        uploadedPaths.push(previewPath);
        previewSize = preview.size;
      } else if (type === "pdf" || type === "image") {
        previewPath = originalPath;
        previewSize = original.size;
      }
      const doc = phase1SopDocuments.find(function (item) { return item.id === sopId; });
      const payload = {
        sop_id: sopId,
        title: title,
        file_type: type,
        storage_path: originalPath,
        preview_path: previewPath,
        size_bytes: original.size,
        preview_size_bytes: previewSize,
        preview_data: previewData,
        sort_order: priorFile ? priorFile.sort_order : Array.isArray(doc && doc.files) ? doc.files.length : 0,
        created_by: appSession.user.id
      };
      const result = replaceId
        ? await supabaseClient.from("simlsp_sop_files").update(payload).eq("id", replaceId).select("id").maybeSingle()
        : await supabaseClient.from("simlsp_sop_files").insert(payload).select("id").maybeSingle();
      if (result.error || !result.data) throw result.error || new Error("File belum tercatat di daftar SOP.");
    } catch (error) {
      if (uploadedPaths.length) await supabaseClient.storage.from("sop-files").remove(uploadedPaths);
      throw error;
    }
    if (priorFile) {
      const oldPaths = Array.from(new Set([priorFile.storage_path, priorFile.preview_path].filter(Boolean)));
      if (oldPaths.length) await supabaseClient.storage.from("sop-files").remove(oldPaths);
      oldPaths.forEach(function (path) { phase1SopUrlCache.delete("preview:" + path); phase1SopUrlCache.delete("download:" + path); });
    }
    phase1SopLoadedAt = 0;
    phase1SopMessage = "";
    await phase1LoadSops(true);
    phase1SelectedSopId = sopId;
    phase1RefreshSopView();
    toast(priorFile ? "File SOP berhasil diganti." : "File berhasil ditambahkan ke SOP.");
  }

  async function phase1DeleteSopFile(id) {
    if (!isManager()) return;
    const doc = phase1SopDocuments.find(function (item) { return (item.files || []).some(function (file) { return file.id === id; }); });
    const file = doc && doc.files.find(function (item) { return item.id === id; });
    if (!file || !confirm('Hapus file "' + file.title + '" dari SOP?')) return;
    const removed = await supabaseClient.from("simlsp_sop_files").delete().eq("id", id).select("id").maybeSingle();
    if (removed.error || !removed.data) {
      toast("File belum dapat dihapus: " + (removed.error && removed.error.message || "akses ditolak"));
      return;
    }
    const paths = Array.from(new Set([file.storage_path, file.preview_path].filter(Boolean)));
    if (paths.length) await supabaseClient.storage.from("sop-files").remove(paths);
    paths.forEach(function (path) { phase1SopUrlCache.delete("preview:" + path); });
    phase1SopLoadedAt = 0;
    await phase1LoadSops(true);
  }

  async function phase1DeleteSop(id) {
    if (!isManager()) return;
    const doc = phase1SopDocuments.find(function (item) { return item.id === id; });
    if (!doc || !confirm('Hapus SOP "' + doc.title + '" beserta semua file di dalamnya?')) return;
    const paths = (doc.files || []).reduce(function (all, file) { all.push(file.storage_path, file.preview_path); return all; }, []).filter(Boolean);
    const removed = await supabaseClient.from("simlsp_sop_documents").delete().eq("id", id).select("id").maybeSingle();
    if (removed.error || !removed.data) {
      toast("SOP belum dapat dihapus: " + (removed.error && removed.error.message || "akses ditolak"));
      return;
    }
    if (paths.length) await supabaseClient.storage.from("sop-files").remove(Array.from(new Set(paths)));
    phase1SelectedSopId = "";
    phase1SopLoadedAt = 0;
    await phase1LoadSops(true);
    toast("SOP dihapus.");
  }

  async function phase1DownloadSopOriginal(id) {
    if (!isManager()) return;
    const file = phase1SopDocuments.flatMap(function (doc) { return doc.files || []; }).find(function (item) { return item.id === id; });
    if (!file || !file.storage_path) return;
    const cacheKey = "download:" + file.storage_path;
    let cached = phase1SopUrlCache.get(cacheKey);
    if (!cached || cached.expiresAt < Date.now() + 30000) {
      const result = await supabaseClient.storage.from("sop-files").createSignedUrl(file.storage_path, 300, { download: true });
      if (result.error || !result.data || !result.data.signedUrl) {
        toast("File asli tidak dapat diunduh. Periksa izin Storage.");
        return;
      }
      cached = { url: result.data.signedUrl, expiresAt: Date.now() + 270000 };
      phase1SopUrlCache.set(cacheKey, cached);
    }
    const link = document.createElement("a");
    link.href = cached.url;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function phase1StopInfoAutoPlay() {
    if (phase1InfoTimer) window.clearTimeout(phase1InfoTimer);
    phase1InfoTimer = null;
  }

  function phase1ScheduleInfoAutoPlay() {
    phase1StopInfoAutoPlay();
    if (currentView === "dashboard") return;
    const host = document.getElementById("phase1InfoStack");
    const rows = phase1InfoPosts.filter(function (post) { return phase1InfoCategory === "Semua" || post.category === phase1InfoCategory; });
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if ((currentView !== "info" && currentView !== "dashboard") || !host || rows.length < 2 || reduceMotion || document.hidden || phase1InfoPauseReasons.size) return;
    phase1InfoTimer = window.setTimeout(function () {
      phase1MoveInfoCard(1);
      phase1ScheduleInfoAutoPlay();
    }, 4000);
  }

  function phase1MoveInfoCard(direction) {
    const rows = phase1InfoPosts.filter(function (post) { return phase1InfoCategory === "Semua" || post.category === phase1InfoCategory; });
    if (rows.length < 2) return;
    const activeAction = document.activeElement && document.activeElement.closest ? document.activeElement.closest("[data-p1-action]") : null;
    const focusAction = activeAction && activeAction.getAttribute("data-p1-action");
    phase1InfoIndex = (phase1InfoIndex + direction + rows.length) % rows.length;
    phase1RenderInfoList();
    if (focusAction === "previousInfoCard" || focusAction === "nextInfoCard") {
      const replacement = document.querySelector('[data-p1-action="' + focusAction + '"]');
      if (replacement) replacement.focus({ preventScroll: true });
    }
    phase1ScheduleInfoAutoPlay();
  }

  function phase1AttachInfoCarouselEvents() {
    const stack = document.getElementById("phase1InfoStack");
    if (!stack) {
      phase1StopInfoAutoPlay();
      return;
    }
    stack.addEventListener("pointerenter", function () {
      window.clearTimeout(phase1InfoResumeTimer);
      phase1InfoPauseReasons.add("pointer");
      phase1ScheduleInfoAutoPlay();
    });
    stack.addEventListener("pointerleave", function () {
      window.clearTimeout(phase1InfoResumeTimer);
      phase1InfoResumeTimer = window.setTimeout(function () {
        phase1InfoPauseReasons.delete("pointer");
        phase1InfoPauseReasons.delete("touch");
        phase1ScheduleInfoAutoPlay();
      }, 1000);
    });
    stack.addEventListener("focusin", function () {
      if (phase1KeyboardFocusMode) {
        phase1InfoPauseReasons.add("focus");
        phase1ScheduleInfoAutoPlay();
      }
    });
    stack.addEventListener("focusout", function (event) {
      if (!event.relatedTarget || !stack.contains(event.relatedTarget)) {
        phase1InfoPauseReasons.delete("focus");
        phase1ScheduleInfoAutoPlay();
      }
    });
    stack.addEventListener("pointerdown", function (event) {
      if (!event.target.closest(".phase1-info-card") || event.button !== 0) return;
      phase1InfoPointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
      if (event.pointerType === "touch") {
        phase1InfoPauseReasons.add("touch");
        phase1ScheduleInfoAutoPlay();
      }
    });
    stack.addEventListener("pointerup", function (event) {
      if (!phase1InfoPointerDown || phase1InfoPointerDown.id !== event.pointerId) return;
      const dx = event.clientX - phase1InfoPointerDown.x;
      const dy = event.clientY - phase1InfoPointerDown.y;
      phase1InfoPointerDown = null;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        event.preventDefault();
        phase1InfoSuppressClick = true;
        window.setTimeout(function () { phase1InfoSuppressClick = false; }, 300);
        phase1MoveInfoCard(dx < 0 ? 1 : -1);
        window.clearTimeout(phase1InfoResumeTimer);
        phase1InfoResumeTimer = window.setTimeout(function () {
          phase1InfoPauseReasons.delete("pointer");
          phase1InfoPauseReasons.delete("touch");
          phase1ScheduleInfoAutoPlay();
        }, 1000);
      }
      if (event.pointerType === "touch") {
        window.clearTimeout(phase1InfoResumeTimer);
        phase1InfoResumeTimer = window.setTimeout(function () {
          phase1InfoPauseReasons.delete("touch");
          phase1ScheduleInfoAutoPlay();
        }, 1000);
      }
    });
    stack.addEventListener("pointercancel", function () {
      phase1InfoPointerDown = null;
      phase1InfoPauseReasons.delete("touch");
      phase1ScheduleInfoAutoPlay();
    });
    phase1ScheduleInfoAutoPlay();
  }

  async function phase1UploadInfoAttachment(postId, file) {
    if (!file) return null;
    const type = phase1InfoAttachmentType(file);
    if (!type) throw new Error("Gunakan dokumen Word/Excel, PDF, CSV, JPG, PNG, atau WebP.");
    if (file.size < 1 || file.size > PHASE1_INFO_FILE_LIMIT) throw new Error("Lampiran harus berukuran maksimal 10 MB.");
    const name = "file-" + crypto.randomUUID() + "." + PHASE1_INFO_EXTENSIONS[type];
    const path = "info/" + postId + "/" + name;
    const upload = await supabaseClient.storage.from("info-board-files").upload(path, file, {
      contentType: type,
      cacheControl: "3600",
      upsert: false
    });
    if (upload.error) throw upload.error;
    return { path: path, name: String(file.name || name).slice(0, 255), type: type, size: file.size };
  }

  async function phase1SaveInfoPost(form) {
    if (!isManager()) {
      toast("Hanya Sarpras/Admin yang dapat mengelola Info Madrasah.");
      return;
    }
    const fd = new FormData(form);
    const id = String(form.getAttribute("data-id") || "") || crypto.randomUUID();
    const prior = phase1InfoPosts.find(function (post) { return post.id === id; });
    const kind = fd.get("kind") === "sop_link" ? "sop_link" : "info";
    const selectedSop = kind === "sop_link" ? phase1SopDocuments.find(function (doc) { return doc.id === String(fd.get("sop_id") || "") && doc.active; }) : null;
    const file = kind === "info" ? (form.elements.namedItem("attachment").files[0] || null) : null;
    const removeAttachment = fd.get("removeAttachment") === "on";
    const status = document.getElementById("phase1InfoFormStatus");
    const button = form.querySelector('button[type="submit"]');
    let uploaded = null;
    if (button) {
      button.disabled = true;
      button.textContent = file ? "Mengunggah lampiran…" : "Menyimpan…";
    }
    try {
      if (file) uploaded = await phase1UploadInfoAttachment(id, file);
      const attachment = uploaded || (removeAttachment ? null : prior && prior.attachment_path ? {
        path: prior.attachment_path,
        name: prior.attachment_name,
        type: prior.attachment_content_type,
        size: prior.attachment_size
      } : null);
      const payload = {
        title: kind === "sop_link" ? String(selectedSop && selectedSop.title || "").trim() : String(fd.get("title") || "").trim(),
        body: kind === "sop_link" ? "" : String(fd.get("body") || "").trim(),
        kind: kind,
        sop_id: kind === "sop_link" ? selectedSop && selectedSop.id || null : null,
        gradient: String(fd.get("gradient") || "mint"),
        notify_all: fd.get("notify_all") === "on",
        category: kind === "sop_link" ? "SOP" : String(fd.get("category") || "Pengumuman"),
        pinned: fd.get("pinned") === "on",
        attachment_path: kind === "sop_link" ? null : attachment && attachment.path || null,
        attachment_name: kind === "sop_link" ? null : attachment && attachment.name || null,
        attachment_content_type: kind === "sop_link" ? null : attachment && attachment.type || null,
        attachment_size: kind === "sop_link" ? null : attachment && attachment.size || null
      };
      if (!payload.title || payload.title.length > 120 || (kind === "info" && (!payload.body || payload.body.length > 4000)) || (kind === "sop_link" && !selectedSop)) throw new Error(kind === "sop_link" ? "Pilih SOP aktif yang akan ditautkan." : "Judul atau isi informasi belum valid.");
      let saved;
      if (prior) {
        saved = await supabaseClient.from("simlsp_info_posts").update(payload).eq("id", id).select("id").maybeSingle();
      } else {
        saved = await supabaseClient.from("simlsp_info_posts").insert(Object.assign({ id: id, created_by: appSession.user.id }, payload)).select("id").maybeSingle();
      }
      if (saved.error || !saved.data) throw saved.error || new Error("Informasi belum tersimpan.");
      const oldPath = prior && prior.attachment_path;
      if (oldPath && (uploaded || removeAttachment || kind === "sop_link")) {
        await supabaseClient.storage.from("info-board-files").remove([oldPath]);
        phase1InfoUrlCache.delete(oldPath);
      }
      phase1InfoEditingId = "";
      phase1InfoLoadedAt = 0;
      await phase1LoadInfo(true);
      await phase1RefreshNotifications();
      if (!prior && payload.notify_all) void phase1SendPushEvent("info:" + id);
      toast(prior ? "Informasi diperbarui." : "Informasi diterbitkan.");
    } catch (error) {
      if (uploaded) await supabaseClient.storage.from("info-board-files").remove([uploaded.path]);
      if (status) status.textContent = error && error.message ? error.message : "Informasi gagal disimpan.";
      if (button) {
        button.disabled = false;
        button.textContent = prior ? "Simpan perubahan" : "Terbitkan informasi";
      }
      return;
    }
    render();
  }

  async function phase1EditInfoPost(id) {
    if (!isManager()) return;
    await phase1LoadSops(false);
    phase1InfoEditingId = id;
    phase1InfoDetailId = "";
    render();
    window.setTimeout(function () {
      const form = document.getElementById("phase1InfoForm");
      if (form) {
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        const title = document.getElementById("phase1InfoTitle");
        if (title) title.focus({ preventScroll: true });
      }
    }, 60);
  }

  async function phase1DeleteInfoPost(id) {
    if (!isManager()) return;
    const post = phase1InfoPosts.find(function (item) { return item.id === id; });
    if (!post || !confirm('Hapus informasi "' + post.title + '"?')) return;
    const result = await supabaseClient.from("simlsp_info_posts").delete().eq("id", id);
    if (result.error) {
      toast("Informasi belum dapat dihapus: " + result.error.message);
      return;
    }
    if (post.attachment_path) {
      await supabaseClient.storage.from("info-board-files").remove([post.attachment_path]);
      phase1InfoUrlCache.delete(post.attachment_path);
    }
    phase1InfoLoadedAt = 0;
    await phase1LoadInfo(true);
    toast("Informasi dihapus.");
  }

  async function phase1OpenInfoCard(id) {
    if (phase1InfoSuppressClick) return;
    const post = phase1InfoPosts.find(function (item) { return item.id === id; });
    if (!post) return;
    if (post.kind === "sop_link") {
      await phase1LoadSops(false);
      if (!phase1SopDocuments.some(function (doc) { return doc.id === post.sop_id && doc.active; })) {
        toast("SOP yang ditautkan belum tersedia atau sudah dinonaktifkan.");
        return;
      }
      phase1InfoDetailId = "";
      phase1OpenSop(post.sop_id);
      return;
    }
    phase1InfoDetailId = id;
    phase1RenderInfoList();
  }

  function phase1OpenSop(id) {
    if (!phase1SopDocuments.some(function (doc) { return doc.id === id && (doc.active || isManager()); })) return;
    phase1SelectedSopId = id;
    phase1SelectedSopFileId = "";
    phase1SopNavigationPending = true;
    if (currentView === "sop") phase1RefreshSopView();
    else navigateToView("sop");
    phase1SopNavigationPending = false;
    phase1WriteSopRoute(id);
  }

  function phase1WriteSopRoute(id) {
    const params = new URLSearchParams(window.location.search);
    if (id) {
      params.set("view", "sop");
      params.set("sopId", id);
    } else params.delete("sopId");
    const search = params.toString();
    const url = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
    history.replaceState(history.state, "", url);
  }

  const phase1BaseShell = shell;
  shell = function () {
    phase1BaseShell();
    phase1EnsureHeader();
  };

  const phase1BaseRender = render;
  const phase1BaseNavigateToView = navigateToView;
  navigateToView = function (view) {
    if (view === "sop" && currentView !== "sop" && !phase1SopNavigationPending) {
      phase1SelectedSopId = "";
      phase1WriteSopRoute("");
    } else if (view !== "sop" && currentView === "sop") {
      phase1SelectedSopId = "";
      phase1WriteSopRoute("");
    }
    return phase1BaseNavigateToView(view);
  };
  render = function () {
    if (currentView !== "info" && currentView !== "dashboard") phase1StopInfoAutoPlay();
    phase1BaseRender();
    if (!authReady || !appSession || !userProfile) return;
    if (currentView === "dashboard") {
      phase1RenderDashboardInfo();
    } else if (currentView === "info") {
      document.getElementById("content").innerHTML = phase1RenderInfo();
      phase1RenderInfoList();
      void phase1LoadInfo(false);
      void phase1LoadSops(false);
      phase1UpdateInfoKindFields(document.getElementById("phase1InfoForm"));
    } else if (currentView === "sop") {
      document.getElementById("content").innerHTML = phase1RenderSop();
      void phase1LoadSops(false);
      void phase1HydrateSopPreviews(document.getElementById("content"));
    } else if (currentView === "settings") {
      const content = document.getElementById("content");
      if (content && !document.getElementById("phase1ProfileHeading")) content.insertAdjacentHTML("beforeend", phase1ProfileCard());
    }
    phase1EnsureHeader();
    void phase1HydrateAvatarImages(document);
    phase1RenderNotifications();
  };

  const phase1BaseAdminEditForm = adminEditForm;
  adminEditForm = function (report) {
    let markup = phase1BaseAdminEditForm(report);
    markup = markup.replace(/<div class="field"><label>PJ \/ koordinator<\/label><input name="pj"[^>]*><\/div>/,
      '<div class="field"><span class="field-label">PJ / koordinator</span><span class="phase1-assignment-current">' + esc(report.pj || "Belum ditetapkan") + '</span><input type="hidden" name="pj" value="' + esc(report.pj || "") + '"></div>');
    markup = markup.replace(/<div class="field"><label>Pelaksana<\/label><input name="executor"[^>]*><\/div>/,
      '<div class="field"><span class="field-label">Pelaksana</span><span class="phase1-assignment-current">' + esc(report.executor || "Belum ditetapkan") + '</span><input type="hidden" name="executor" value="' + esc(report.executor || "") + '"></div>');
    return markup;
  };

  const phase1BaseRenderDetail = renderDetail;
  renderDetail = function (report) {
    let markup = phase1BaseRenderDetail(report);
    if (isManager() && report.status === "ANTREAN") {
      markup = markup.replace(/<div class="grid" style="grid-template-columns:1fr 1fr;gap:9px">[\s\S]*?<\/div>(?=<div class="action-row"><button class="btn small" data-action="assign")/, phase1AssignmentControl(report));
      if (!phase1AssignableLoaded || phase1AssignableError) markup = markup.replace(/(<button class="btn small" data-action="assign" data-id="[^"]+")>/, "$1 disabled>");
    }
    if (isManager() && ["DITUGASKAN", "DALAM_PENGERJAAN", "DITUNDA"].includes(String(report.status || ""))) markup += phase1ExistingAssignmentPanel(report);
    markup += phase1CommentsMarkup(report);
    return markup;
  };

  const phase1BaseShowDetail = showDetail;
  showDetail = function (id) {
    phase1BaseShowDetail(id);
    const report = getReport(id);
    if (report && isManager() && ["ANTREAN", "DITUGASKAN", "DALAM_PENGERJAAN", "DITUNDA"].includes(String(report.status || ""))) void phase1LoadAssignableUsers(false);
    if (report && phase1CanViewComments(report)) void phase1LoadComments(id);
    void phase1HydrateAvatarImages(document.getElementById("modalBody"));
  };

  const phase1BaseDoAction = doAction;
  doAction = async function (action, id) {
    if (action === "assign") {
      await phase1AssignReport({ getAttribute: function () { return id; } });
      return;
    }
    return phase1BaseDoAction(action, id);
  };

  notifyReportStatus = async function (report) {
    if (!isManager() || !report || !report.statusEventId || !sharedDataReady || !supabaseClient) return;
    await phase1SendPushEvent("status:" + String(report.id) + ":" + String(report.statusEventId));
  };

  const phase1BaseActivateSession = activateSession;
  activateSession = async function (session) {
    const ok = await phase1BaseActivateSession(session);
    if (!ok) return false;
    try {
      const result = await supabaseClient.from("simlsp_profiles")
        .select("avatar_path,avatar_updated_at")
        .eq("id", session.user.id)
        .maybeSingle();
      if (!result.error && result.data) userProfile = Object.assign({}, userProfile, result.data);
    } catch (_) {}
    phase1StartNotificationPolling();
    void phase1LoadInfo(false);
    if (isManager()) void phase1LoadAssignableUsers(false);
    return true;
  };

  const phase1BaseLogout = logout;
  logout = async function () {
    clearInterval(phase1NotificationTimer);
    phase1NotificationTimer = null;
    phase1Notifications = [];
    phase1UnreadCount = 0;
    phase1AssignableUsers = [];
    phase1AssignableLoaded = false;
    phase1SelectedExecutorIds = new Set();
    phase1InfoPosts = [];
    phase1InfoLoadedAt = 0;
    phase1InfoEditingId = "";
    phase1InfoDetailId = "";
    phase1InfoCategory = "Semua";
    phase1InfoDetailId = "";
    phase1InfoIndex = 0;
    phase1StopInfoAutoPlay();
    window.clearTimeout(phase1InfoResumeTimer);
    phase1InfoPauseReasons.clear();
    phase1SopDocuments = [];
    phase1SopLoadedAt = 0;
    phase1SopLoadGeneration++;
    phase1SopLoadPromise = null;
    phase1SopLoading = false;
    phase1SelectedSopId = "";
    phase1SelectedSopFileId = "";
    phase1AvatarUrlCache.clear();
    phase1InfoUrlCache.clear();
    phase1SopUrlCache.clear();
    return phase1BaseLogout();
  };

  const phase1BaseLoadAdminAccounts = loadAdminAccounts;
  loadAdminAccounts = async function (force) {
    const details = document.getElementById("accountManagementDetails");
    const box = document.getElementById("adminAccountList");
    if (!details || !details.open || !box || !isManager() || !supabaseClient) return;
    if (!force && Array.isArray(adminAccountRows)) {
      renderAdminAccountsPage();
      return;
    }
    if (adminAccountsLoading) return;
    adminAccountsLoading = true;
    box.innerHTML = '<div class="small-note">Memuat daftar akun…</div>';
    const count = document.getElementById("accountResultCount");
    if (count) count.textContent = "Sedang memuat akun…";
    try {
      const result = await supabaseClient.rpc("simlsp_admin_list_directory");
      if (result.error) throw result.error;
      adminAccountRows = Array.isArray(result.data) ? result.data : [];
      adminAccountPage = 1;
      renderAdminAccountsPage();
    } catch (error) {
      adminAccountRows = null;
      box.innerHTML = '<div class="banner warning-banner"><span>⚠</span><div><strong>Daftar akun belum tersedia</strong>' + esc(error && error.message || "Gagal memuat daftar akun.") + '</div></div>';
      const badge = document.getElementById("accountCountBadge");
      if (badge) badge.textContent = "Gagal dimuat";
    } finally {
      adminAccountsLoading = false;
    }
  };

  const phase1BaseRenderAdminAccountsPage = renderAdminAccountsPage;
  renderAdminAccountsPage = function () {
    phase1BaseRenderAdminAccountsPage();
    const box = document.getElementById("adminAccountList");
    const rows = Array.isArray(adminAccountRows) ? adminAccountRows : [];
    if (!box || !rows.length) return;
    const needle = adminAccountSearch.trim().toLocaleLowerCase("id-ID").replace(/^@/, "");
    const filtered = rows.filter(function (row) {
      const role = String(row.role || "warga");
      if (adminAccountRoleFilter !== "ALL" && role !== adminAccountRoleFilter) return false;
      return !needle || [row.display_name, row.username].some(function (value) { return String(value || "").toLocaleLowerCase("id-ID").includes(needle); });
    }).sort(function (a, b) { return String(a.display_name || a.username || "").localeCompare(String(b.display_name || b.username || ""), "id"); });
    const pageRows = filtered.slice((adminAccountPage - 1) * ADMIN_ACCOUNTS_PAGE_SIZE, adminAccountPage * ADMIN_ACCOUNTS_PAGE_SIZE);
    Array.from(box.querySelectorAll(".account-row")).forEach(function (rowNode, index) {
      const user = pageRows[index];
      const person = rowNode.querySelector(".account-person");
      if (!user || !person) return;
      if (!person.querySelector(".phase1-account-avatar")) person.insertAdjacentHTML("afterbegin", phase1AvatarMarkup(user.avatar_path, user.display_name || user.username, "phase1-account-avatar"));
      const meta = person.querySelector("small");
      if (meta && user.unit && !person.querySelector(".phase1-account-unit")) {
        const unit = document.createElement("span");
        unit.className = "phase1-account-unit";
        unit.textContent = "Unit " + user.unit;
        person.insertBefore(unit, meta);
      }
    });
    void phase1HydrateAvatarImages(box);
  };

  document.addEventListener("click", function (event) {
    const p1Action = event.target.closest("[data-p1-action]");
    if (p1Action) {
      const actionName = p1Action.getAttribute("data-p1-action");
      const id = p1Action.getAttribute("data-id");
      if (actionName === "previousInfoCard") phase1MoveInfoCard(-1);
      else if (actionName === "nextInfoCard") phase1MoveInfoCard(1);
      else if (actionName === "openInfoCard") void phase1OpenInfoCard(id);
      else if (actionName === "backToInfoCards") { phase1InfoDetailId = ""; phase1RenderInfoList(); }
      else if (actionName === "refreshInfo") { phase1InfoLoadedAt = 0; void phase1LoadInfo(true); }
      else if (actionName === "cancelInfoEdit") { phase1InfoEditingId = ""; render(); }
      else if (actionName === "editInfoPost") void phase1EditInfoPost(id);
      else if (actionName === "deleteInfoPost") void phase1DeleteInfoPost(id);
      else if (actionName === "openSop") phase1OpenSop(id);
      else if (actionName === "backToSopList") { phase1SelectedSopId = ""; phase1WriteSopRoute(""); phase1RefreshSopView(); }
      else if (actionName === "refreshSops") { phase1SopLoadedAt = 0; void phase1LoadSops(true); }
      else if (actionName === "deleteSop") void phase1DeleteSop(id);
      else if (actionName === "deleteSopFile") void phase1DeleteSopFile(id);
      else if (actionName === "downloadSopOriginal") void phase1DownloadSopOriginal(id);
      else if (actionName === "toggleSopReplacement") {
        const panel = document.getElementById("phase1SopReplacePanel-" + id);
        if (panel) {
          panel.hidden = !panel.hidden;
          if (!panel.hidden) panel.querySelector('input[type="file"]')?.focus({ preventScroll: true });
        }
      }
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      const name = action.getAttribute("data-action");
      if (name === "toggleNotifications") {
        phase1ToggleNotifications();
      } else if (name === "refreshNotifications") {
        void phase1RefreshNotifications();
      } else if (name === "reloadAssignees") {
        phase1AssignableLoaded = false;
        void phase1LoadAssignableUsers(true);
      } else if (name === "removeAvatar") {
        void phase1RemoveAvatar();
      }
    }
    const notification = event.target.closest("[data-notification-id]");
    if (notification) void phase1OpenNotification(notification.getAttribute("data-notification-id"));
  });

  document.addEventListener("click", function (event) {
    const wrap = document.getElementById("phase1NotificationWrap");
    if (!wrap || wrap.contains(event.target)) return;
    phase1CloseNotifications();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") phase1CloseNotifications();
    phase1KeyboardFocusMode = true;
  });

  document.addEventListener("pointerdown", function () {
    phase1KeyboardFocusMode = false;
    if (phase1InfoPauseReasons.delete("focus")) phase1ScheduleInfoAutoPlay();
  });

  document.getElementById("content").addEventListener("input", function (event) {
    if (event.target.id === "phase1InfoTitle") {
      const status = document.getElementById("phase1InfoFormStatus");
      if (status && event.target.value.length > 120) status.textContent = "Judul maksimal 120 karakter.";
    }
  });

  document.getElementById("content").addEventListener("change", function (event) {
    if (event.target.id === "phase1InfoCategory") {
      phase1InfoCategory = event.target.value;
      phase1InfoIndex = 0;
      phase1InfoDetailId = "";
      phase1RenderInfoList();
    } else if (event.target.id === "phase1InfoKind") {
      phase1UpdateInfoKindFields(event.target.form);
    } else if (event.target.id === "phase1SopOriginal") {
      const file = event.target.files && event.target.files[0];
      const field = document.getElementById("phase1SopPdfField");
      if (field) field.hidden = !file || phase1SopType(file) !== "word";
    } else if (event.target.classList.contains("phase1-sop-replacement-original")) {
      const file = event.target.files && event.target.files[0];
      const field = event.target.form.querySelector(".phase1-sop-replacement-pdf");
      if (field) field.hidden = !file || phase1SopType(file) !== "word";
    }
  });

  document.getElementById("content").addEventListener("submit", function (event) {
    if (event.target.id === "phase1AvatarForm") {
      event.preventDefault();
      void phase1SaveAvatar(event.target);
    } else if (event.target.id === "phase1InfoForm") {
      event.preventDefault();
      void phase1SaveInfoPost(event.target);
    } else if (event.target.id === "phase1SopCreateForm") {
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = "Membuat…"; }
      phase1CreateSop(form).catch(function (error) {
        const status = form.querySelector('[role="status"]');
        if (status) status.textContent = error && error.message || "SOP belum dapat dibuat.";
        if (button) { button.disabled = false; button.textContent = "Buat SOP"; }
      });
    } else if (event.target.id === "phase1SopEditForm") {
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = "Menyimpan…"; }
      phase1UpdateSop(form).catch(function (error) {
        toast(error && error.message || "Perubahan SOP belum tersimpan.");
        if (button) { button.disabled = false; button.textContent = "Simpan perubahan"; }
      });
    } else if (event.target.id === "phase1SopFileForm" || event.target.matches(".phase1-sop-replace-form")) {
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('button[type="submit"]');
      const replacing = form.hasAttribute("data-replace-id");
      if (button) { button.disabled = true; button.textContent = replacing ? "Mengganti file…" : "Mengunggah file…"; }
      phase1AddSopFile(form).catch(function (error) {
        const status = form.querySelector('[role="status"]');
        if (status) status.textContent = error && error.message || "File belum dapat ditambahkan.";
        if (button) { button.disabled = false; button.textContent = replacing ? "Simpan file pengganti" : "Tambah file"; }
      });
    }
  });

  document.getElementById("modalBody").addEventListener("input", function (event) {
    if (event.target.id === "phase1AssigneeSearch") {
      const list = document.getElementById("phase1AssigneeList");
      if (list) {
        Array.from(list.querySelectorAll('input[name="executorIds"]:checked')).forEach(function (input) { phase1SelectedExecutorIds.add(input.value); });
        list.innerHTML = phase1AssigneeRows(phase1SelectedExecutorIds, event.target.value);
        void phase1HydrateAvatarImages(list);
      }
    }
    if (event.target.id === "phase1CommentText") {
      const count = document.getElementById("phase1CommentLength");
      if (count) count.textContent = String(event.target.value.length) + " / 800";
    }
  });

  document.getElementById("modalBody").addEventListener("change", function (event) {
    if (event.target.name === "executorIds") {
      if (event.target.checked) phase1SelectedExecutorIds.add(event.target.value);
      else phase1SelectedExecutorIds.delete(event.target.value);
      const count = document.getElementById("phase1AssigneeCount");
      if (count) count.textContent = phase1SelectedExecutorIds.size + " akun dipilih. Pilih minimal satu akun.";
    }
  });

  document.getElementById("modalBody").addEventListener("submit", function (event) {
    if (event.target.id === "phase1CommentForm") {
      event.preventDefault();
      void phase1SendComment(event.target);
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && appSession) {
      void phase1RefreshNotifications();
      if (currentView === "info") {
        phase1InfoLoadedAt = 0;
        void phase1LoadInfo(true);
      }
    }
    phase1ScheduleInfoAutoPlay();
  });

  window.addEventListener("focus", function () {
    if (appSession) void phase1RefreshNotifications();
  });

  if (appSession && userProfile) {
    phase1StartNotificationPolling();
    if (isManager()) void phase1LoadAssignableUsers(false);
  }
})();
