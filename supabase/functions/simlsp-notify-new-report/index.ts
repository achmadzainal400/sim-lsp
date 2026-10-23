import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const appOrigin = "https://achmadzainal400.github.io/sim-lsp";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function pushFailure(statusCode: number) {
  if (statusCode === 401 || statusCode === 403) {
    return "Kunci VAPID di Supabase tidak cocok dengan kunci publik di aplikasi.";
  }
  if (statusCode === 404 || statusCode === 410) {
    return "Langganan notifikasi perangkat sudah kedaluwarsa. Aktifkan notifikasi kembali.";
  }
  return "Layanan push menolak pengiriman (HTTP " + (statusCode || "tidak diketahui") + ").";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
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
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!supabaseUrl || !serviceKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return json({ error: "Konfigurasi server notifikasi belum lengkap. Periksa secret VAPID di Supabase." }, 500);
  }
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (_) {
    return json({ error: "Pasangan kunci VAPID di Edge Function tidak valid." }, 500);
  }

  let body: { reportId?: unknown; eventToken?: unknown; test?: unknown };
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Isi permintaan tidak valid." }, 400);
  }
  const isTest = body.test === true;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let reportId = String(body.reportId || "").trim();
  let webhookEvent = false;
  let profile: { role: string } | null = null;
  if (typeof body.eventToken === "string") {
    const eventToken = body.eventToken.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventToken)) {
      return json({ error: "Token pemicu laporan tidak valid." }, 401);
    }
    const consumed = await admin.rpc("simlsp_consume_report_push_event", { p_event_token: eventToken });
    if (consumed.error) {
      console.error("Token webhook SIM-LSP tidak dapat diperiksa:", consumed.error.code || "unknown");
      return json({ error: "Pemicu otomatis belum siap. Jalankan SQL notifikasi laporan otomatis." }, 500);
    }
    reportId = String(consumed.data || "").trim();
    if (!reportId) return json({ error: "Token pemicu laporan sudah digunakan atau kedaluwarsa." }, 401);
    webhookEvent = true;
  } else {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Sesi masuk diperlukan." }, 401);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sesi masuk tidak berlaku." }, 401);

    const { data: userProfile, error: profileError } = await admin
      .from("simlsp_profiles")
      .select("role")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (profileError || !userProfile) return json({ error: "Profil akun tidak dapat diperiksa." }, 500);
    profile = userProfile;

    if (isTest) {
      if (profile.role !== "sarpras_admin") return json({ error: "Hanya Sarpras/Admin yang dapat mengirim notifikasi uji." }, 403);
      const { data: subscriptions, error } = await admin
        .from("simlsp_push_subscriptions")
        .select("endpoint, user_id, p256dh, auth_key")
        .eq("user_id", authData.user.id);
      if (error) return json({ error: "Daftar perangkat tidak dapat dibaca. Pastikan SQL notifikasi sudah dijalankan." }, 500);
      if (!subscriptions?.length) return json({ error: "Perangkat ini belum terdaftar. Aktifkan notifikasi terlebih dahulu." }, 409);

      const notice = JSON.stringify({
        title: "Uji notifikasi SIM-LSP",
        body: "Notifikasi push dari Supabase berhasil mencapai perangkat ini.",
        tag: "simlsp-test-" + Date.now(),
        url: appOrigin + "/?view=reports",
      });
      const attempts = await Promise.all(subscriptions.map(async (item) => {
        try {
          await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth_key } }, notice, { TTL: 300 });
          return { sent: true, stale: false, statusCode: 0 };
        } catch (error) {
          const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
          if (statusCode === 404 || statusCode === 410) await admin.from("simlsp_push_subscriptions").delete().eq("endpoint", item.endpoint);
          return { sent: false, stale: statusCode === 404 || statusCode === 410, statusCode };
        }
      }));
      const sent = attempts.filter((item) => item.sent).length;
      if (!sent) {
        const statusCode = attempts.find((item) => item.statusCode)?.statusCode || 0;
        return json({ error: pushFailure(statusCode), sent: 0, stale: attempts.filter((item) => item.stale).length }, 502);
      }
      return json({ ok: true, sent, stale: attempts.filter((item) => item.stale).length });
    }
  }

  if (!reportId || reportId.length > 100) return json({ error: "ID laporan tidak valid." }, 400);

  const { data: sharedRow, error: sharedError } = await admin
    .from("simlsp_shared_data")
    .select("data")
    .eq("id", 1)
    .single();
  if (sharedError) return json({ error: "Data laporan bersama tidak dapat dibaca." }, 500);

  const reports = Array.isArray(sharedRow?.data?.reports) ? sharedRow.data.reports : [];
  const report = reports.find((item: Record<string, unknown>) => String(item.id || "") === reportId);
  if (!report || String(report.status || "") !== "BARU") {
    return json({ error: "Laporan baru tidak ditemukan atau statusnya sudah berubah." }, 403);
  }
  if (webhookEvent) {
    const creatorId = String(report.creatorProfileId || "");
    const { data: creator, error: creatorError } = await admin
      .from("simlsp_profiles")
      .select("role")
      .eq("id", creatorId)
      .maybeSingle();
    if (creatorError || creator?.role !== "warga") return json({ error: "Profil pelapor bukan Warga Madrasah." }, 403);
  } else {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Sesi masuk tidak berlaku." }, 401);
    if (profile?.role !== "warga" || String(report.creatorProfileId || "") !== authData.user.id) {
      return json({ error: "Hanya laporan baru dari akun Warga yang dapat memicu notifikasi." }, 403);
    }
    const createdAt = Date.parse(String(report.createdAt || ""));
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 60_000 || Date.now() - createdAt > 15 * 60_000) {
      return json({ error: "Laporan baru tidak lagi memenuhi batas waktu notifikasi." }, 403);
    }
  }

  const { data: claimed, error: claimError } = await admin.rpc("simlsp_claim_push_delivery", { p_report_id: reportId });
  if (claimError) {
    // Keep notifications working before the retry migration is applied.
    if (claimError.code !== "42883" && claimError.code !== "PGRST202") {
      return json({ error: "Klaim pengiriman gagal. Jalankan SQL notifikasi SIM-LSP terbaru." }, 500);
    }
    const legacyClaim = await admin.from("simlsp_push_delivery_log").insert({ report_id: reportId, status: "sending" });
    if (legacyClaim.error?.code === "23505") return json({ ok: true, duplicate: true, sent: 0 });
    if (legacyClaim.error) return json({ error: "Status pengiriman tidak dapat disimpan. Jalankan SQL notifikasi SIM-LSP." }, 500);
  } else if (!claimed) {
    return json({ ok: true, duplicate: true, sent: 0 });
  }

  const { data: adminProfiles, error: adminsError } = await admin
    .from("simlsp_profiles")
    .select("id")
    .eq("role", "sarpras_admin");
  if (adminsError) {
    await admin.from("simlsp_push_delivery_log").update({ status: "failed", updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return json({ error: "Daftar penerima notifikasi tidak dapat dibaca." }, 500);
  }
  const adminIds = (adminProfiles || []).map((item) => item.id);
  if (!adminIds.length) {
    await admin.from("simlsp_push_delivery_log").update({ status: "no_subscribers", updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return json({ ok: true, sent: 0 });
  }

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("simlsp_push_subscriptions")
    .select("endpoint, user_id, p256dh, auth_key")
    .in("user_id", adminIds);
  if (subscriptionsError) {
    await admin.from("simlsp_push_delivery_log").update({ status: "failed", updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return json({ error: "Daftar perangkat penerima tidak dapat dibaca." }, 500);
  }
  if (!subscriptions?.length) {
    await admin.from("simlsp_push_delivery_log").update({ status: "no_subscribers", updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return json({ ok: true, sent: 0 });
  }

  const reportObject = String(report.object || "Laporan fasilitas baru").trim();
  const reportLocation = String(report.location || "").trim();
  const reporterName = String(report.reporterName || "Warga Madrasah").trim();
  const reportDescription = String(report.description || "").trim();
  const objectLine = reportObject.slice(0, 38) + (reportLocation ? " — " + reportLocation.slice(0, 24) : "");
  const detailLines = [objectLine, "Pelapor: " + reporterName.slice(0, 35), reportDescription ? "Uraian: " + reportDescription.slice(0, 55) : ""]
    .filter(Boolean);
  const notice = JSON.stringify({
    title: "Laporan baru masuk",
    body: detailLines.join(" · ").slice(0, 180),
    tag: "simlsp-report-" + reportId,
    url: appOrigin + "/?view=reports&reportId=" + encodeURIComponent(reportId),
  });
  const attempts = await Promise.all(subscriptions.map(async (item) => {
    try {
      await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth_key } }, notice, { TTL: 300 });
      return { sent: true, stale: false, statusCode: 0 };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("simlsp_push_subscriptions").delete().eq("endpoint", item.endpoint);
        return { sent: false, stale: true, statusCode };
      }
      console.error("Web push gagal untuk satu perangkat:", statusCode || "unknown");
      return { sent: false, stale: false, statusCode };
    }
  }));

  const sent = attempts.filter((item) => item.sent).length;
  const status = sent > 0 ? "sent" : "failed";
  await admin.from("simlsp_push_delivery_log").update({
    status,
    sent_count: sent,
    updated_at: new Date().toISOString(),
  }).eq("report_id", reportId);
  if (!sent) {
    const statusCode = attempts.find((item) => item.statusCode)?.statusCode || 0;
    return json({ error: pushFailure(statusCode), sent: 0, stale: attempts.filter((item) => item.stale).length }, 502);
  }
  return json({ ok: true, sent, stale: attempts.filter((item) => item.stale).length });
});
