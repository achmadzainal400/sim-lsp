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

  let title = "";
  let body = "";
  let url = appOrigin + "/";
  if (eventKey.startsWith("status:")) {
    const parts = eventKey.split(":");
    const reportId = parts[1];
    const eventId = parts.slice(2).join(":");
    const { data: actor, error: actorError } = await admin.from("simlsp_profiles").select("role").eq("id", actorId).maybeSingle();
    if (actorError || actor?.role !== "sarpras_admin") {
      return response({ error: "Hanya Sarpras/Admin yang dapat mengirim pembaruan status." }, 403);
    }
    const { data: sharedRow, error: sharedError } = await admin.from("simlsp_shared_data").select("data").eq("id", 1).maybeSingle();
    if (sharedError) return response({ error: "Data tiket tidak dapat dibaca." }, 500);
    const reports = Array.isArray(sharedRow?.data?.reports) ? sharedRow.data.reports : [];
    const report = reports.find((item: Record<string, unknown>) => String(item.id || "") === reportId);
    if (!report || String(report.statusEventId || "") !== eventId) {
      return response({ error: "Perubahan status sudah digantikan." }, 409);
    }
    title = "Pembaruan status · " + String(report.code || reportId).slice(0, 60);
    const reason = ["DITUNDA", "DITOLAK"].includes(String(report.status || "")) ? String(report.deferReason || "") : "";
    body = "Status tiket berubah menjadi " + String(report.status || "diperbarui") + (reason ? ". Alasan: " + reason : "");
    url = appOrigin + "/?view=reports&reportId=" + encodeURIComponent(reportId);
  } else if (eventKey.startsWith("comment:")) {
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
    const reports = Array.isArray(reportRow?.data?.reports) ? reportRow.data.reports : [];
    const report = reports.find((item: Record<string, unknown>) => String(item.id || "") === comment.report_id);
    if (!report) return response({ error: "Tiket komentar tidak ditemukan." }, 404);
    const code = String(report.code || comment.report_id).slice(0, 60);
    title = "Komentar baru · " + code;
    body = String(comment.by || "Pengguna") + ": " + String(comment.text || "").slice(0, 120);
    url = appOrigin + "/?view=reports&reportId=" + encodeURIComponent(comment.report_id);
  } else {
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

  const { data: notifications, error: notificationsError } = await admin.from("simlsp_notifications")
    .select("user_id")
    .eq("event_key", eventKey);
  if (notificationsError) return response({ error: "Daftar penerima notifikasi tidak dapat dibaca." }, 500);
  const userIds = Array.from(new Set((notifications || []).map((item) => item.user_id).filter((id) => id && id !== actorId)));
  if (!userIds.length) return response({ ok: true, sent: 0, reason: "no-recipients" });

  const { data: claimed, error: claimError } = await admin.from("simlsp_notification_push_log")
    .insert({ event_key: eventKey, status: "sending", sent_count: 0 })
    .select("event_key")
    .maybeSingle();
  if (claimError?.code === "23505") return response({ ok: true, duplicate: true, sent: 0 });
  if (claimError || !claimed) return response({ error: "Status pengiriman tidak dapat dikunci." }, 500);

  const { data: subscriptions, error: subscriptionsError } = await admin.from("simlsp_push_subscriptions")
    .select("endpoint,user_id,p256dh,auth_key")
    .in("user_id", userIds);
  if (subscriptionsError) {
    await admin.from("simlsp_notification_push_log").update({ status: "failed", updated_at: new Date().toISOString() }).eq("event_key", eventKey);
    return response({ error: "Daftar perangkat tidak dapat dibaca." }, 500);
  }
  if (!subscriptions?.length) {
    await admin.from("simlsp_notification_push_log").update({ status: "no_subscribers", updated_at: new Date().toISOString() }).eq("event_key", eventKey);
    return response({ ok: true, sent: 0, reason: "not-subscribed" });
  }

  const payload = JSON.stringify({
    title: title.slice(0, 80),
    body: body.slice(0, 180),
    tag: "simlsp-event-" + eventKey.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
    url,
  });
  const attempts = await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, payload, { TTL: 300 });
      return { sent: true, stale: false };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("simlsp_push_subscriptions").delete().eq("endpoint", subscription.endpoint);
        return { sent: false, stale: true };
      }
      console.error("Web push peristiwa SIM-LSP gagal:", statusCode || "unknown");
      return { sent: false, stale: false };
    }
  }));
  const sent = attempts.filter((attempt) => attempt.sent).length;
  await admin.from("simlsp_notification_push_log").update({
    status: sent ? "sent" : "failed",
    sent_count: sent,
    updated_at: new Date().toISOString(),
  }).eq("event_key", eventKey);
  return response({ ok: true, sent, stale: attempts.filter((attempt) => attempt.stale).length });
});
