import { createClient } from "npm:@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "npm:jose@5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://achmadzainal400.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getGoogleAccessToken(serviceAccount: Record<string, string>) {
  const privateKey = await importPKCS8(serviceAccount.private_key.replace(/\\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error("Google gagal memberikan token FCM.");
  }
  return tokenData.access_token as string;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method tidak didukung." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const firebaseJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response({ error: "Konfigurasi Supabase fungsi belum lengkap." }, 500);
  }
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return response({ error: "Sesi login diperlukan." }, 401);
  }
  if (!firebaseJson) {
    return response({ error: "Firebase FCM belum dikonfigurasi di server." }, 503);
  }

  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return response({ error: "Sesi login tidak valid." }, 401);

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile, error: profileError } = await serviceClient
      .from("simlsp_profiles")
      .select("id")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile) return response({ error: "Profil SIM-LSP tidak ditemukan." }, 403);

    const serviceAccount = JSON.parse(firebaseJson) as Record<string, string>;
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      return response({ error: "Data akun layanan Firebase tidak lengkap." }, 500);
    }
    const accessToken = await getGoogleAccessToken(serviceAccount);
    const { data: claim, error: claimError } = await serviceClient.rpc("simlsp_claim_queue_notification");
    if (claimError || !claim || typeof claim.count !== "number") {
      console.error("Klaim jumlah antrean gagal:", claimError?.message || "respons tidak valid");
      return response({ error: "Jumlah antrean tidak dapat disiapkan." }, 500);
    }
    if (!claim.changed) return response({ changed: false, count: claim.count });

    const pushResponse = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            topic: "simlsp-queue-count",
            data: { type: "queue_count", count: String(claim.count) },
            android: { priority: "HIGH", ttl: "86400s" },
          },
        }),
      },
    );
    if (!pushResponse.ok) {
      const details = await pushResponse.text();
      console.error("Pengiriman FCM gagal:", pushResponse.status, details);
      return response({ error: "Firebase gagal mengirim pembaruan antrean." }, 502);
    }
    return response({ changed: true, count: claim.count });
  } catch (error) {
    console.error("Notifikasi antrean gagal:", error);
    return response({ error: "Fungsi notifikasi antrean mengalami kendala." }, 500);
  }
});
