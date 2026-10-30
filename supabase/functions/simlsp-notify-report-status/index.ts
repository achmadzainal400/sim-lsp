import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const appOrigin = "https://achmadzainal400.github.io/sim-lsp";
const supportedStatuses = new Set(["ANTREAN", "MENUNGGU_PERSETUJUAN", "DITUNDA", "SELESAI", "DITOLAK"]);
function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysJson) {
    try {
      const secretKeys = JSON.parse(secretKeysJson);
      serviceKey = String(secretKeys.default || secretKeys.SUPABASE_SERVICE_ROLE_KEY || secretKeys.service_role || serviceKey);
    } catch (_) {
      console.error("SUPABASE_SECRET_KEYS tidak berisi JSON yang valid.");
    }
  }
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "";
  if (!supabaseUrl || !serviceKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return json({ error: "Konfigurasi server notifikasi belum lengkap. Periksa secret VAPID di Supabase." }, 500);
  }
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (_) {
    return json({ error: "Pasangan kunci VAPID di Edge Function tidak valid." }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Sesi masuk tidak berlaku." }, 401);
  let body: { reportId?: unknown; eventId?: unknown };
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Isi permintaan tidak valid." }, 400);
  }
  const reportId = String(body.reportId || "").trim();
  const eventId = String(body.eventId || "").trim();
  if (!reportId || reportId.length > 100 || !eventId || eventId.length > 100) {
    return json({ error: "ID tiket atau perubahan status tidak valid." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Sesi masuk tidak berlaku." }, 401);
  const { data: actor } = await admin.from("simlsp_profiles").select("role").eq("id", authData.user.id).maybeSingle();
  if (actor?.role !== "sarpras_admin") return json({ error: "Hanya Sarpras/Admin yang dapat mengirim pembaruan status." }, 403);

  const { data: sharedRow, error: sharedError } = await admin.from("simlsp_shared_data").select("data").eq("id", 1).single();
  if (sharedError) return json({ error: "Data bersama tidak dapat dibaca." }, 500);
  const reports = Array.isArray(sharedRow?.data?.reports) ? sharedRow.data.reports : [];
  const report = reports.find((item: Record<string, unknown>) => String(item.id || "") === reportId);
  if (!report || String(report.statusEventId || "") !== eventId || !supportedStatuses.has(String(report.status || ""))) {
    return json({ error: "Perubahan status sudah digantikan atau tidak perlu diberitahukan." }, 409);
  }
  const recipientId = String(report.creatorProfileId || "");
  if (!recipientId || recipientId === authData.user.id) return json({ ok: true, sent: 0, reason: "not-a-citizen" });
  const { data: recipient, error: recipientError } = await admin.from("simlsp_profiles").select("role").eq("id", recipientId).maybeSingle();
  if (recipientError || recipient?.role !== "warga") return json({ error: "Akun pelapor tidak valid." }, 403);

  const { data: claimed, error: claimError } = await admin.rpc("simlsp_claim_status_push_delivery", { p_event_id: eventId, p_report_id: reportId });
  if (claimError) return json({ error: "SQL pemberitahuan status belum diterapkan di Supabase." }, 500);
  if (!claimed) return json({ ok: true, duplicate: true, sent: 0 });

  const { data: subscriptions, error: subscriptionError } = await admin.from("simlsp_push_subscriptions")
    .select("endpoint, user_id, p256dh, auth_key").eq("user_id", recipientId);
  if (subscriptionError) return json({ error: "Perangkat pelapor tidak dapat dibaca." }, 500);
  if (!subscriptions?.length) {
    await admin.from("simlsp_report_status_push_log").update({ status: "no_subscribers", updated_at: new Date().toISOString() }).eq("event_id", eventId);
    return json({ ok: true, sent: 0, reason: "not-subscribed" });
  }

  const status = String(report.status);
  const statusTitle: Record<string, string> = {
    ANTREAN: "Laporan Anda terverifikasi",
    MENUNGGU_PERSETUJUAN: "Laporan menunggu persetujuan",
    DITUNDA: "Penanganan laporan ditunda",
    SELESAI: "Laporan Anda selesai ditangani",
    DITOLAK: "Laporan Anda ditolak",
  };
  const reason = status === "DITUNDA" ? String(report.deferReason || "") : String(report.approvalNote || report.internalNote || "");
  const details = [String(report.object || report.category || "Laporan sarpras"), String(report.location || ""), reason ? "Keterangan: " + reason.slice(0, 100) : ""]
    .filter(Boolean).join(" · ").slice(0, 180);
  const payload = JSON.stringify({ title: statusTitle[status], body: details, tag: "simlsp-status-" + eventId, url: appOrigin + "/?view=reports&reportId=" + encodeURIComponent(reportId) });
  const sends = await Promise.all(subscriptions.map(async (item) => {
    try {
      await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth_key } }, payload, { TTL: 300 });
      return { sent: true, stale: false };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("simlsp_push_subscriptions").delete().eq("endpoint", item.endpoint);
        return { sent: false, stale: true };
      }
      console.error("Web push pembaruan status gagal:", statusCode || "unknown");
      return { sent: false, stale: false };
    }
  }));
  const sent = sends.filter((item) => item.sent).length;
  await admin.from("simlsp_report_status_push_log").update({ status: sent ? "sent" : "failed", sent_count: sent, updated_at: new Date().toISOString() }).eq("event_id", eventId);
  return sent ? json({ ok: true, sent }) : json({ error: "Notifikasi gagal terkirim. Pastikan pelapor sudah mengaktifkan notifikasi di perangkatnya.", sent: 0 }, 502);
});
