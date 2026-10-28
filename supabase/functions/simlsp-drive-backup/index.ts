import { createClient } from "npm:@supabase/supabase-js@2";

const APP_ORIGIN = "https://achmadzainal400.github.io";
const APP_URL = APP_ORIGIN + "/sim-lsp/";
const BUCKET = "SIM-LSP";
const BACKUP_FOLDER = "Backup";
const REDIRECT_URI = "https://lcfqhrziveksvxuldsfa.supabase.co/functions/v1/simlsp-drive-backup";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

const corsHeaders = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function appRedirect(result: string) {
  const target = new URL(APP_URL);
  target.searchParams.set("drive_oauth", result);
  target.searchParams.set("view", "settings");
  return Response.redirect(target.href, 302);
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) throw new Error("Konfigurasi Supabase fungsi belum lengkap.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function encryptionKey() {
  const dedicatedValue = Deno.env.get("SIMLSP_DRIVE_TOKEN_ENCRYPTION_KEY") || "";
  if (dedicatedValue) {
    const dedicatedRaw = Uint8Array.from(atob(dedicatedValue.trim()), (character) => character.charCodeAt(0));
    if (dedicatedRaw.length !== 32) throw new Error("Kunci khusus Google Drive harus Base64 dari 32 byte.");
    return crypto.subtle.importKey("raw", dedicatedRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  const rootValue = Deno.env.get("SIMLSP_CREDENTIAL_VAULT_KEY") || "";
  if (!rootValue) throw new Error("Kunci rahasia SIM-LSP belum tersedia.");
  const rootRaw = Uint8Array.from(atob(rootValue.trim()), (character) => character.charCodeAt(0));
  if (rootRaw.length !== 32) throw new Error("Kunci rahasia SIM-LSP harus Base64 dari 32 byte.");
  const rootKey = crypto.subtle.importKey("raw", rootRaw, "HKDF", false, ["deriveKey"]);
  return rootKey.then((key) => crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("SIM-LSP/Google-Drive/2026-10"),
    info: new TextEncoder().encode("refresh-token-encryption-v1"),
  }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptRefreshToken(token: string) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}

async function decryptRefreshToken(ivValue: string, cipherValue: string) {
  const key = await encryptionKey();
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivValue) }, key, fromBase64(cipherValue));
  return new TextDecoder().decode(clear);
}

async function requireAdmin(request: Request) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError("Sesi login diperlukan.", 401);
  const service = serviceClient();
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) throw new HttpError("Sesi login tidak valid. Silakan masuk kembali.", 401);
  const { data: profile, error: profileError } = await service
    .from("simlsp_profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError || profile?.role !== "sarpras_admin") throw new HttpError("Hanya Sarpras/Admin yang dapat menggunakan Google Drive.", 403);
  return { service, userId: data.user.id as string };
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function beginOAuth(service: ReturnType<typeof serviceClient>, userId: string) {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) {
    throw new HttpError("Google Drive belum siap. Atur GOOGLE_OAUTH_CLIENT_ID dan GOOGLE_OAUTH_CLIENT_SECRET di Supabase.", 503);
  }
  await encryptionKey();
  const state = base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const { error } = await service.from("simlsp_drive_oauth_states").insert({
    state,
    user_id: userId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw new HttpError("Sesi penyambungan Google Drive gagal disiapkan. Pastikan SIM-LSP-Drive-Backup.sql sudah dijalankan.", 500);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return url.href;
}

async function oauthCallback(request: Request) {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") || "");
  if (!state || state.length > 100) return appRedirect("error");
  const service = serviceClient();
  const { data: stateRow, error: stateError } = await service
    .from("simlsp_drive_oauth_states")
    .delete()
    .eq("state", state)
    .select("user_id, expires_at")
    .maybeSingle();
  if (stateError || !stateRow || Date.parse(stateRow.expires_at) < Date.now()) return appRedirect("error");
  if (url.searchParams.get("error")) return appRedirect("cancelled");

  const code = String(url.searchParams.get("code") || "");
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
  if (!code || !clientId || !clientSecret) return appRedirect("error");
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) return appRedirect("error");
    const { data: previous } = await service.from("simlsp_drive_connections")
      .select("refresh_token_ciphertext, refresh_token_iv, root_folder_id, backup_folder_id")
      .eq("user_id", stateRow.user_id)
      .maybeSingle();
    const refreshToken = String(tokens.refresh_token || "");
    if (!refreshToken && !previous?.refresh_token_ciphertext) return appRedirect("error");
    const encrypted = refreshToken ? await encryptRefreshToken(refreshToken) : null;
    let googleEmail = "";
    try {
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + tokens.access_token },
      });
      if (profileResponse.ok) googleEmail = String((await profileResponse.json()).email || "").slice(0, 254);
    } catch (_) { /* account label is optional */ }
    const row = {
      user_id: stateRow.user_id,
      google_email: googleEmail || "Akun Google terhubung",
      refresh_token_ciphertext: encrypted?.ciphertext || previous?.refresh_token_ciphertext,
      refresh_token_iv: encrypted?.iv || previous?.refresh_token_iv,
      root_folder_id: previous?.root_folder_id || "",
      backup_folder_id: previous?.backup_folder_id || "",
      updated_at: new Date().toISOString(),
    };
    const { error } = await service.from("simlsp_drive_connections").upsert(row, { onConflict: "user_id" });
    if (error) return appRedirect("error");
    return appRedirect("success");
  } catch (error) {
    console.error("OAuth Google Drive gagal:", error instanceof Error ? error.message : "unknown");
    return appRedirect("error");
  }
}

function safeErrorMessage(value: unknown) {
  const text = String(value || "");
  if (/invalid_grant|revoked|expired/i.test(text)) return "Akses Google Drive kedaluwarsa. Hubungkan kembali akun Google.";
  if (/storageQuotaExceeded|quotaExceeded|insufficientStorage/i.test(text)) return "Google Drive tidak memiliki ruang yang cukup untuk menyimpan cadangan.";
  if (/insufficientFilePermissions|forbidden|permission/i.test(text)) return "Google Drive menolak akses. Periksa izin OAuth dan ruang Drive.";
  if (/fetch failed|network|connection|timed out/i.test(text)) return "Koneksi terputus saat mengirim ke Google Drive. Periksa internet lalu coba lagi.";
  return text.slice(0, 260) || "Operasi Google Drive gagal. Coba lagi.";
}

async function status(service: ReturnType<typeof serviceClient>, userId: string) {
  const { data, error } = await service.from("simlsp_drive_connections")
    .select("google_email,refresh_token_ciphertext,last_backup_at,last_backup_status,last_backup_name,last_backup_folder_id,last_backup_size_bytes,last_backup_files,last_backup_error")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError("Status Google Drive belum dapat dibaca. Jalankan skrip SQL Fase 2.", 500);
  return {
    ready: Boolean(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") && Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") && (Deno.env.get("SIMLSP_DRIVE_TOKEN_ENCRYPTION_KEY") || Deno.env.get("SIMLSP_CREDENTIAL_VAULT_KEY"))),
    connected: Boolean(data?.refresh_token_ciphertext),
    googleEmail: data?.google_email || "",
    lastBackupAt: data?.last_backup_at || null,
    lastBackupStatus: data?.last_backup_status || "",
    lastBackupName: data?.last_backup_name || "",
    lastBackupFolderId: data?.last_backup_folder_id || "",
    lastBackupSizeBytes: Number(data?.last_backup_size_bytes || 0),
    lastBackupFiles: Array.isArray(data?.last_backup_files) ? data.last_backup_files : [],
    lastBackupError: data?.last_backup_error || "",
  };
}

async function refreshGoogleAccessToken(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "",
      client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new HttpError(safeErrorMessage(body.error_description || body.error), response.status === 401 ? 401 : 502);
  return String(body.access_token);
}

async function driveRequest(url: string, accessToken: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", "Bearer " + accessToken);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    let message = "";
    try {
      const body = await response.json();
      message = body.error?.errors?.[0]?.reason || body.error?.message || body.error_description || "";
    } catch (_) { message = await response.text().catch(() => ""); }
    throw new HttpError(safeErrorMessage(message || "Google Drive (HTTP " + response.status + ")"), response.status);
  }
  if (response.status === 204) return {};
  return response;
}

function escapeDriveQuery(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function findFolder(name: string, parentId: string, accessToken: string) {
  const clauses = ["name = '" + escapeDriveQuery(name) + "'", "mimeType = '" + FOLDER_MIME + "'", "trashed = false"];
  if (parentId) clauses.push("'" + escapeDriveQuery(parentId) + "' in parents");
  const query = new URLSearchParams({ q: clauses.join(" and "), fields: "files(id,name)", pageSize: "100" });
  const response = await driveRequest("https://www.googleapis.com/drive/v3/files?" + query, accessToken);
  const data = await response.json();
  return Array.isArray(data.files) ? data.files[0] || null : null;
}

async function createFolder(name: string, parentId: string, accessToken: string) {
  const metadata: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  const response = await driveRequest("https://www.googleapis.com/drive/v3/files?fields=id,name", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(metadata),
  });
  return await response.json();
}

async function getOrCreateFolder(name: string, parentId: string, accessToken: string) {
  return await findFolder(name, parentId, accessToken) || await createFolder(name, parentId, accessToken);
}

async function uploadDriveFile(file: File, name: string, parentId: string, accessToken: string) {
  const mime = file.type || "application/octet-stream";
  const metadata = JSON.stringify({ name, mimeType: mime, parents: [parentId] });
  if (file.size <= 5 * 1024 * 1024) {
    const boundary = "simlsp_" + crypto.randomUUID().replaceAll("-", "");
    const body = new Blob([
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
      metadata,
      "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n",
      file,
      "\r\n--" + boundary + "--",
    ], { type: "multipart/related; boundary=" + boundary });
    const response = await driveRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size", accessToken, {
      method: "POST",
      headers: { "Content-Type": body.type },
      body,
    });
    return await response.json();
  }
  const init = await driveRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size", accessToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(file.size),
    },
    body: metadata,
  });
  const location = init.headers.get("Location");
  if (!location) throw new HttpError("Google Drive tidak memberikan alamat unggah. Coba lagi.", 502);
  const response = await driveRequest(location, accessToken, { method: "PUT", headers: { "Content-Type": mime }, body: file });
  return await response.json();
}

async function deleteDriveFile(fileId: string, accessToken: string) {
  try {
    await driveRequest("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId), accessToken, { method: "DELETE" });
  } catch (_) { /* best effort when rolling back a partial backup */ }
}

async function setBackupFailure(service: ReturnType<typeof serviceClient>, userId: string, message: string) {
  await service.from("simlsp_drive_connections").update({
    last_backup_at: new Date().toISOString(),
    last_backup_status: "gagal",
    last_backup_error: safeErrorMessage(message),
    last_backup_files: [],
    last_backup_size_bytes: 0,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
}

async function uploadBackup(request: Request, service: ReturnType<typeof serviceClient>, userId: string) {
  let form: FormData;
  try { form = await request.formData(); } catch (_) { throw new HttpError("Paket backup tidak terbaca. Coba lagi.", 400); }
  const specs = [
    { field: "json", name: "SIM-LSP-Cadangan", mime: "application/json", ext: ".json" },
    { field: "reports", name: "SIM-LSP-Laporan", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
    { field: "assets", name: "SIM-LSP-Aset", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  ];
  const files: Array<{ field: string; name: string; mime: string; ext: string; file: File }> = [];
  for (const spec of specs) {
    const value = form.get(spec.field);
    if (!(value instanceof File) || value.size < 1 || value.type !== spec.mime) {
      throw new HttpError("Paket harus berisi JSON, Excel laporan, dan Excel aset yang valid.", 400);
    }
    if (value.size > MAX_FILE_BYTES) throw new HttpError("Salah satu file melebihi batas 24 MB. Kurangi data lalu ulangi backup.", 413);
    files.push({ ...spec, file: value });
  }
  if (files.reduce((sum, entry) => sum + entry.file.size, 0) > MAX_TOTAL_BYTES) {
    throw new HttpError("Paket backup melebihi batas 48 MB. Kurangi data lalu ulangi.", 413);
  }
  try {
    const parsed = JSON.parse(await files[0].file.text());
    if (parsed?.app !== "SIM-LSP" || !Array.isArray(parsed?.reports) || !Array.isArray(parsed?.assets)) {
      throw new Error("Struktur JSON backup tidak sesuai.");
    }
  } catch (_) { throw new HttpError("File JSON cadangan tidak valid.", 400); }

  const { data: connection, error: connectionError } = await service.from("simlsp_drive_connections")
    .select("refresh_token_ciphertext,refresh_token_iv,root_folder_id,backup_folder_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError || !connection?.refresh_token_ciphertext) throw new HttpError("Hubungkan akun Google Drive sebelum mencadangkan.", 409);
  if (!Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || !Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")) {
    throw new HttpError("Konfigurasi OAuth Google belum lengkap di Supabase.", 503);
  }

  let uploaded: Array<{ id: string; name: string; size: number }> = [];
  let accessToken = "";
  let backupSnapshotFolderId = "";
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const snapshotName = "SIM-LSP-Cadangan-" + stamp;
  try {
    const refreshToken = await decryptRefreshToken(connection.refresh_token_iv, connection.refresh_token_ciphertext);
    accessToken = await refreshGoogleAccessToken(refreshToken);
    let root = connection.root_folder_id ? { id: connection.root_folder_id } : await findFolder(BUCKET, "", accessToken);
    if (!root?.id) root = await createFolder(BUCKET, "", accessToken);
    let parent = connection.backup_folder_id ? { id: connection.backup_folder_id } : await findFolder(BACKUP_FOLDER, String(root.id), accessToken);
    if (!parent?.id) parent = await createFolder(BACKUP_FOLDER, String(root.id), accessToken);
    await service.from("simlsp_drive_connections").update({ root_folder_id: root.id, backup_folder_id: parent.id }).eq("user_id", userId);
    const snapshot = await createFolder(snapshotName, String(parent.id), accessToken);
    backupSnapshotFolderId = String(snapshot.id || "");
    if (!backupSnapshotFolderId) throw new HttpError("Folder backup gagal dibuat di Google Drive.", 502);

    for (const entry of files) {
      const saved = await uploadDriveFile(entry.file, entry.name + "-" + stamp + entry.ext, backupSnapshotFolderId, accessToken);
      if (!saved.id) throw new HttpError("Google Drive tidak mengembalikan ID file.", 502);
      uploaded.push({ id: String(saved.id), name: String(saved.name || entry.name + entry.ext), size: Number(saved.size || entry.file.size) });
    }
    const totalBytes = uploaded.reduce((sum, item) => sum + item.size, 0);
    const savedAt = new Date().toISOString();
    const { error: updateError } = await service.from("simlsp_drive_connections").update({
      last_backup_at: savedAt,
      last_backup_status: "sukses",
      last_backup_name: snapshotName,
      last_backup_folder_id: backupSnapshotFolderId,
      last_backup_size_bytes: totalBytes,
      last_backup_files: uploaded.map(({ name, size }) => ({ name, size })),
      last_backup_error: "",
      updated_at: savedAt,
    }).eq("user_id", userId);
    if (updateError) throw new HttpError("File berhasil masuk Drive, tetapi status backup gagal disimpan di SIM-LSP.", 500);
    return { ok: true, name: snapshotName, folderId: backupSnapshotFolderId, sizeBytes: totalBytes, files: uploaded.map(({ name, size }) => ({ name, size })) };
  } catch (error) {
    for (const item of uploaded) await deleteDriveFile(item.id, accessToken);
    if (backupSnapshotFolderId) await deleteDriveFile(backupSnapshotFolderId, accessToken);
    const message = safeErrorMessage(error instanceof Error ? error.message : error);
    await setBackupFailure(service, userId, message);
    throw new HttpError(message, error instanceof HttpError ? error.status : 502);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(request.url);
  if (request.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await oauthCallback(request);
  if (request.method !== "POST") return json({ error: "Metode tidak didukung." }, 405);

  try {
    const { service, userId } = await requireAdmin(request);
    if (request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      const result = await uploadBackup(request, service, userId);
      return json(result);
    }
    let body: { action?: unknown };
    try { body = await request.json(); } catch (_) { throw new HttpError("Permintaan tidak valid.", 400); }
    const action = String(body.action || "");
    if (action === "status") return json(await status(service, userId));
    if (action === "connect") return json({ authorizationUrl: await beginOAuth(service, userId) });
    throw new HttpError("Aksi Google Drive tidak dikenal.", 400);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Terjadi kesalahan pada fungsi Google Drive.";
    if (statusCode >= 500) console.error("SIM-LSP Drive Backup:", message);
    return json({ error: safeErrorMessage(message) }, statusCode);
  }
});
