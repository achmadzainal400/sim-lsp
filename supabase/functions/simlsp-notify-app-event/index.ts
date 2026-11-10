import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://achmadzainal400.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const appOrigin = "https://achmadzainal400.github.io/sim-lsp";

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function getServiceRoleKey() {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysJson) return key;
  try {
    const secretKeys = JSON.parse(secretKeysJson);
    return String(secretKeys.default || secretKeys.SUPABASE_SERVICE_ROLE_KEY || secretKeys.service_role || key);
  } catch (_) {
    console.error("SUPABASE_SECRET_KEYS tidak berisi JSON yang valid.");
    return key;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = getServiceRoleKey();
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "";
  if (!supabaseUrl || !serviceKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return response({ error: "Konfigurasi server notifikasi belum lengkap. Periksa secret VAPID di Supabase." }, 500);
  }
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (_) {
    return response({ error: "Pasangan kunci VAPID di Edge Function tidak valid." }, 500);
  }

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return response({ error: "Sesi masuk diperlukan." }, 401);

  let requestBody: { eventKey?: unknown };
  try {
    requestBody = await request.json();
  } catch (_) {
    return response({ error: "Isi permintaan tidak valid." }, 400);
  }
  const eventKey = String(requestBody.eventKey || "").trim();
  if (!/^comment:[0-9a-f-]{36}$|^info:[0-9a-f-]{36}$|^status:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$/i.test(eventKey)) {
    return response({ error: "Kunci peristiwa notifikasi tidak valid." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return response({ error: "Sesi masuk tidak berlaku." }, 401);
  const actorId = authData.user.id;

  type Report = Record<string, unknown>;
  type NotificationRow = { user_id: string; report_id: string | null; report_code: string | null };
  let eventType = "";
  let title = "";
  let body = "";
  let url = appOrigin + "/";
  let eventKeys = [eventKey];
  let rootReportId = "";
  let rootReportCode = "";
  let statusText = "";
  let statusReason = "";
  let commentAuthor = "";
  let commentText = "";
  const reporterCodeByUser = new Map<string, string>();

  function findReportGroup(reports: Report[], selected: Report) {
    const parentId = String(selected.mergedIntoReportId || selected.id || "");
    const root = reports.find((item) => String(item.id || "") === parentId) || selected;
    const rootId = String(root.id || parentId);
    const children = new Set((Array.isArray(root.mergedReportIds) ? root.mergedReportIds : []).map(String));
    const members = reports.filter((item) => {
      const id = String(item.id || "");
      return id === rootId || children.has(id) || String(item.mergedIntoReportId || "") === rootId;
    });
    for (const member of members) {
      const creatorId = String(member.creatorProfileId || member.creator_profile_id || "");
      if (creatorId) reporterCodeByUser.set(creatorId, String(member.code || member.id || rootId));
    }
    return { root, members: members.length ? members : [selected] };
  }

  if (eventKey.startsWith("status:")) {
    eventType = "status";
    const parts = eventKey.split(":");
    const reportId = parts[1];
    const eventId = parts.slice(2).join(":");
    const { data: actor, error: actorError } = await admin.from("simlsp_profiles").select("role").eq("id", actorId).maybeSingle();
    if (actorError || actor?.role !== "sarpras_admin") {
      return response({ error: "Hanya Sarpras/Admin yang dapat mengirim pembaruan status." }, 403);
    }
    const { data: sharedRow, error: sharedError } = await admin.from("simlsp_shared_data").select("data").eq("id", 1).maybeSingle();
    if (sharedError) return response({ error: "Data tiket tidak dapat dibaca." }, 500);
    const reports = Array.isArray(sharedRow?.data?.reports) ? sharedRow.data.reports as Report[] : [];
    const report = reports.find((item) => String(item.id || "") === reportId);
    if (!report || String(report.statusEventId || "") !== eventId) {
      return response({ error: "Perubahan status sudah digantikan." }, 409);
    }
    const group = findReportGroup(reports, report);
    const root = group.root;
    rootReportId = String(root.id || reportId);
    rootReportCode = String(root.code || rootReportId).slice(0, 60);
    const statusLabels: Record<string, string> = {
      BARU: "Baru", PERLU_DILENGKAPI: "Perlu dilengkapi", ANTREAN: "Terverifikasi",
      MENUNGGU_PERSETUJUAN: "Menunggu persetujuan", DITUGASKAN: "Ditugaskan",
      DALAM_PENGERJAAN: "Dalam pengerjaan", MENUNGGU_VERIFIKASI: "Menunggu verifikasi",
      DITUNDA: "Ditunda", SELESAI: "Selesai", DITOLAK: "Ditolak", DIBATALKAN: "Dibatalkan",
    };
    statusText = statusLabels[String(root.status || "")] || String(root.status || "diperbarui");
    statusReason = ["DITUNDA", "DITOLAK"].includes(String(root.status || "")) ? String(root.deferReason || "") : "";
    title = "Pembaruan status · " + rootReportCode;
    body = "Status laporan Anda berubah menjadi " + statusText + (statusReason ? ". Alasan: " + statusReason : "");
    url = appOrigin + "/?view=reports&reportId=" + encodeURIComponent(rootReportId);
    eventKeys = Array.from(new Set(group.members.map((item) => {
      const id = String(item.id || "");
      const memberEventId = String(item.statusEventId || "");
      return id && memberEventId ? "status:" + id + ":" + memberEventId : "";
    }).filter(Boolean)));
  } else if (eventKey.startsWith("comment:")) {
    eventType = "comment";
    const commentId = eventKey.slice("comment:".length);
    const { data: comment, error } = await admin.from("simlsp_report_comments")
      .select("id,report_id,by_user_id,by,text")
      .eq("id", commentId)
      .maybeSingle();
    if (error || !comment || comment.by_user_id !== actorId) {
      return response({ error: "Komentar bukan berasal dari sesi ini atau tidak tersedia." }, 403);
    }
    const { data: reportRow, error: reportError } = await admin.from("simlsp_shared_data").select("data").eq("id", 1).maybeSingle();
    if (reportError) return response({ error: "Data tiket tidak dapat dibaca." }, 500);
    const reports = Array.isArray(reportRow?.data?.reports) ? reportRow.data.reports as Report[] : [];
    const report = reports.find((item) => String(item.id || "") === String(comment.report_id || ""));
    if (!report) return response({ error: "Tiket komentar tidak ditemukan." }, 404);
    const group = findReportGroup(reports, report);
    rootReportId = String(group.root.id || report.id || comment.report_id);
    rootReportCode = String(group.root.code || rootReportId).slice(0, 60);
    commentAuthor = String(comment.by || "Pengguna");
    commentText = String(comment.text || "").slice(0, 120);
    title = "Komentar baru · " + rootReportCode;
    body = commentAuthor + ": " + commentText;
    url = appOrigin + "/?view=reports&reportId=" + encodeURIComponent(rootReportId);
  } else {
    eventType = "info";
    const infoPostId = eventKey.slice("info:".length);
    const { data: post, error } = await admin.from("simlsp_info_posts")
      .select("id,created_by,title,body,category,kind,sop_id,notify_all")
      .eq("id", infoPostId)
      .maybeSingle();
    if (error || !post || post.created_by !== actorId) {
      return response({ error: "Informasi bukan berasal dari sesi ini atau tidak tersedia." }, 403);
    }
    if (!post.notify_all) {
      return response({ error: "Pemberitahuan untuk posting ini tidak diaktifkan." }, 409);
    }
    title = String(post.category || "Info") + " · " + String(post.title || "Informasi baru");
    body = post.kind === "sop_link" ? "SOP baru tersedia. Buka Menu SOP dan Informasi untuk membacanya." : String(post.body || "").slice(0, 180);
    url = appOrigin + (post.kind === "sop_link" ? "/?view=sop&sopId=" + encodeURIComponent(String(post.sop_id || "")) : "/?view=info");
  }

  const notificationResult = eventKeys.length > 1
    ? await admin.from("simlsp_notifications").select("user_id,report_id,report_code").in("event_key", eventKeys)
    : await admin.from("simlsp_notifications").select("user_id,report_id,report_code").eq("event_key", eventKey);
  if (notificationResult.error) return response({ error: "Daftar penerima notifikasi tidak dapat dibaca." }, 500);
  const notifications = (notificationResult.data || []) as NotificationRow[];
  const userIds = Array.from(new Set(notifications.map((item) => String(item.user_id || "")).filter((id) => id && id !== actorId)));
  const reporterIds = Array.from(new Set(Array.from(reporterCodeByUser.keys()).filter((id) => id !== actorId && userIds.includes(id))));
  if (!userIds.length) return response({ ok: true, sent: 0, recipientCount: 0, reporterCount: 0, reporterSent: 0, reason: "no-recipients" });

  const { data: claimed, error: claimError } = await admin.rpc("simlsp_claim_notification_push_delivery", { p_event_key: eventKey });
  if (claimError) return response({ error: "Status pengiriman tidak dapat dikunci. Pastikan migrasi notifikasi terbaru sudah dijalankan." }, 500);
  if (!claimed) return response({ ok: true, duplicate: true, sent: 0, recipientCount: userIds.length, reporterCount: reporterIds.length, reporterSent: 0 });

  const { data: subscriptions, error: subscriptionsError } = await admin.from("simlsp_push_subscriptions")
    .select("endpoint,user_id,p256dh,auth_key")
    .in("user_id", userIds);
  if (subscriptionsError) {
    await admin.from("simlsp_notification_push_log").update({ status: "failed", updated_at: new Date().toISOString() }).eq("event_key", eventKey);
    return response({ error: "Daftar perangkat tidak dapat dibaca." }, 500);
  }
  if (!subscriptions?.length) {
    await admin.from("simlsp_notification_push_log").update({ status: "no_subscribers", updated_at: new Date().toISOString() }).eq("event_key", eventKey);
    return response({ ok: true, sent: 0, recipientCount: userIds.length, reporterCount: reporterIds.length, reporterSent: 0, reason: "not-subscribed" });
  }

  const notificationCodeByUser = new Map<string, string>();
  for (const item of notifications) {
    const userId = String(item.user_id || "");
    if (userId && item.report_code && !notificationCodeByUser.has(userId)) notificationCodeByUser.set(userId, String(item.report_code));
  }
  const tag = "simlsp-event-" + eventKey.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
  const attempts = await Promise.all(subscriptions.map(async (subscription) => {
    const userId = String(subscription.user_id || "");
    const ticketCode = reporterCodeByUser.get(userId) || notificationCodeByUser.get(userId) || rootReportCode;
    let recipientTitle = title;
    let recipientBody = body;
    if (eventType === "status" && reporterCodeByUser.has(userId)) {
      recipientTitle = "Pembaruan status · " + ticketCode;
      recipientBody = "Status laporan Anda berubah menjadi " + statusText + (statusReason ? ". Alasan: " + statusReason : "");
      if (ticketCode !== rootReportCode) recipientBody += ". Laporan ini mengikuti tiket induk " + rootReportCode;
    } else if (eventType === "comment" && reporterCodeByUser.has(userId)) {
      recipientTitle = "Komentar baru · " + ticketCode;
      recipientBody = commentAuthor + ": " + commentText;
      if (ticketCode !== rootReportCode) recipientBody += " · Perkembangan tiket induk " + rootReportCode;
    }
    const payload = JSON.stringify({
      title: recipientTitle.slice(0, 80),
      body: recipientBody.slice(0, 180),
      tag,
      url,
    });
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, payload, { TTL: 300 });
      return { userId, sent: true, stale: false };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("simlsp_push_subscriptions").delete().eq("endpoint", subscription.endpoint);
        return { userId, sent: false, stale: true };
      }
      console.error("Web push peristiwa SIM-LSP gagal:", statusCode || "unknown");
      return { userId, sent: false, stale: false };
    }
  }));
  const sent = attempts.filter((attempt) => attempt.sent).length;
  const sentUsers = new Set(attempts.filter((attempt) => attempt.sent).map((attempt) => attempt.userId));
  const reporterSent = reporterIds.filter((id) => sentUsers.has(id)).length;
  const retryableFailures = attempts.some((attempt) => !attempt.sent && !attempt.stale);
  const nextStatus = retryableFailures ? "failed" : sent ? "sent" : "no_subscribers";
  await admin.from("simlsp_notification_push_log").update({
    status: nextStatus,
    sent_count: sent,
    updated_at: new Date().toISOString(),
  }).eq("event_key", eventKey);
  return response({
    ok: true,
    sent,
    recipientCount: userIds.length,
    reporterCount: reporterIds.length,
    reporterSent,
    stale: attempts.filter((attempt) => attempt.stale).length,
    ...(retryableFailures ? { reason: "partial-failure" } : {}),
  });
});
