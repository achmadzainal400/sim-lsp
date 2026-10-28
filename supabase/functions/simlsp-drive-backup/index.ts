import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const APP_ORIGIN = "https://achmadzainal400.github.io";
const APP_URL = APP_ORIGIN + "/sim-lsp/";
const BUCKET = "SIM-LSP";
const BACKUP_FOLDER = "Backup";
const REDIRECT_URI = "https://lcfqhrziveksvxuldsfa.supabase.co/functions/v1/simlsp-drive-backup";
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const NIGHTLY_SOURCE = "nightly" as const;

const corsHeaders = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-simlsp-cron-key",
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
  const { data: run, error: runError } = await service.from("simlsp_drive_backup_runs")
    .select("run_at,source,status,backup_name,folder_id,size_bytes,files,photo_count,error")
    .eq("id", true)
    .maybeSingle();
  if (runError) throw new HttpError("Status backup otomatis belum tersedia. Jalankan skrip SQL Fase 3.", 500);
  const runIsNewer = Boolean(run?.run_at && (!data?.last_backup_at || Date.parse(run.run_at) >= Date.parse(data.last_backup_at)));
  const last = runIsNewer ? run : data;
  return {
    ready: Boolean(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") && Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") && (Deno.env.get("SIMLSP_DRIVE_TOKEN_ENCRYPTION_KEY") || Deno.env.get("SIMLSP_CREDENTIAL_VAULT_KEY"))),
    connected: Boolean(data?.refresh_token_ciphertext),
    googleEmail: data?.google_email || "",
    lastBackupAt: runIsNewer ? run.run_at : data?.last_backup_at || null,
    lastBackupStatus: runIsNewer ? run.status : data?.last_backup_status || "",
    lastBackupSource: runIsNewer ? run.source : "manual",
    lastBackupName: runIsNewer ? run.backup_name : data?.last_backup_name || "",
    lastBackupFolderId: runIsNewer ? run.folder_id : data?.last_backup_folder_id || "",
    lastBackupSizeBytes: Number((runIsNewer ? run.size_bytes : data?.last_backup_size_bytes) || 0),
    lastBackupFiles: Array.isArray(runIsNewer ? run.files : data?.last_backup_files) ? (runIsNewer ? run.files : data?.last_backup_files) : [],
    lastBackupPhotoCount: Number((runIsNewer ? run.photo_count : 0) || 0),
    lastBackupError: runIsNewer ? run.error || "" : data?.last_backup_error || "",
  };
}

async function recordBackupRun(service: ReturnType<typeof serviceClient>, run: Record<string, unknown>) {
  const { error } = await service.from("simlsp_drive_backup_runs").upsert({
    id: true,
    run_at: new Date().toISOString(),
    source: "manual",
    status: "gagal",
    backup_name: "",
    folder_id: "",
    size_bytes: 0,
    files: [],
    photo_count: 0,
    error: "",
    ...run,
  }, { onConflict: "id" });
  if (error) console.error("Status backup global tidak dapat disimpan:", error.message);
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

function collectBackupPhotos(backup: Record<string, any>) {
  const photos: Array<Record<string, any>> = [];
  const seenPaths = new Set<string>();
  for (const report of backup.reports) {
    if (!Array.isArray(report.photos)) continue;
    const reportId = String(report.id || "");
    if (!/^[A-Za-z0-9_-]+$/.test(reportId)) {
      throw new HttpError("ID laporan yang memiliki foto tidak valid. Periksa data laporan sebelum backup.", 400);
    }
    const ticket = String(report.code || reportId).normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || reportId;
    for (let index = 0; index < report.photos.length; index++) {
      const photo = report.photos[index];
      const path = String(photo?.path || "");
      if (!path || !/^reports\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/.test(path) || !path.startsWith("reports/" + reportId + "/")) {
        throw new HttpError("Lokasi foto pada tiket " + ticket + " tidak valid. Backup dibatalkan agar foto tidak terlewat.", 400);
      }
      if (seenPaths.has(path)) throw new HttpError("Ada lokasi foto ganda pada data laporan. Periksa tiket " + ticket + " sebelum backup.", 400);
      seenPaths.add(path);
      photos.push({ report, photo, path, ticket, index });
    }
  }
  return photos;
}

async function uploadReportPhotoToDrive(
  entry: Record<string, any>,
  service: ReturnType<typeof serviceClient>,
  parentId: string,
  accessToken: string,
) {
  const { data, error } = await service.storage.from("report-photos").download(String(entry.path));
  if (error || !data) {
    throw new HttpError("Foto tiket " + entry.ticket + " nomor " + (entry.index + 1) + " tidak ditemukan di Storage. Backup dibatalkan agar foto tidak hilang.", 424);
  }
  const mime = String(data.type || entry.photo.contentType || "image/jpeg").toLowerCase().split(";")[0];
  const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : "";
  if (!extension || data.size < 1 || data.size > 512 * 1024) {
    throw new HttpError("Foto tiket " + entry.ticket + " nomor " + (entry.index + 1) + " bukan JPEG/PNG/WebP yang valid atau melebihi 512 KB.", 413);
  }
  const name = entry.ticket + "-foto-" + String(entry.index + 1).padStart(2, "0") + extension;
  const file = new File([data], name, { type: mime });
  const saved = await uploadDriveFile(file, name, parentId, accessToken);
  if (!saved.id) throw new HttpError("Foto tiket " + entry.ticket + " gagal disimpan ke Google Drive.", 502);
  entry.photo.backupFileName = name;
  entry.photo.backupDriveFileId = String(saved.id);
  entry.photo.backupMimeType = mime;
  entry.photo.backupSize = Number(saved.size || data.size);
  return { id: String(saved.id), name: String(saved.name || name), size: Number(saved.size || data.size), kind: "photo" as const };
}

async function uploadPhotosConcurrently(
  photos: Array<Record<string, any>>,
  service: ReturnType<typeof serviceClient>,
  parentId: string,
  accessToken: string,
) {
  const uploaded: Array<{ id: string; name: string; size: number; kind: "photo" }> = [];
  let nextIndex = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex++;
      if (index >= photos.length) return;
      try {
        uploaded.push(await uploadReportPhotoToDrive(photos[index], service, parentId, accessToken));
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, photos.length) }, () => worker()));
  if (failure) throw failure;
  return uploaded;
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

async function uploadBackup(request: Request, service: ReturnType<typeof serviceClient>, userId: string, source: "manual" | "nightly" = "manual") {
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
  let backupData: Record<string, any>;
  let photos: Array<Record<string, any>>;
  try {
    backupData = JSON.parse(await files[0].file.text());
  } catch (_) { throw new HttpError("File JSON cadangan tidak valid.", 400); }
  if (backupData?.app !== "SIM-LSP" || !Array.isArray(backupData?.reports) || !Array.isArray(backupData?.assets)) {
    throw new HttpError("Struktur JSON backup tidak sesuai.", 400);
  }
  photos = collectBackupPhotos(backupData);

  const { data: connection, error: connectionError } = await service.from("simlsp_drive_connections")
    .select("refresh_token_ciphertext,refresh_token_iv,root_folder_id,backup_folder_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError || !connection?.refresh_token_ciphertext) throw new HttpError("Hubungkan akun Google Drive sebelum mencadangkan.", 409);
  if (!Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || !Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")) {
    throw new HttpError("Konfigurasi OAuth Google belum lengkap di Supabase.", 503);
  }

  let uploaded: Array<{ id: string; name: string; size: number; kind: "photo" | "data" }> = [];
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

    if (photos.length) {
      const photoFolder = await createFolder("Foto-Bukti", backupSnapshotFolderId, accessToken);
      const photoFolderId = String(photoFolder.id || "");
      if (!photoFolderId) throw new HttpError("Folder foto bukti gagal dibuat di Google Drive.", 502);
      uploaded.push(...await uploadPhotosConcurrently(photos, service, photoFolderId, accessToken));
      backupData.backupNote = "Foto bukti disertakan pada subfolder Foto-Bukti. Path Storage asli tetap dicatat sebagai metadata.";
      const json = new File([JSON.stringify(backupData, null, 2)], files[0].file.name, { type: "application/json" });
      if (json.size > MAX_FILE_BYTES || json.size + files.slice(1).reduce((sum, entry) => sum + entry.file.size, 0) > MAX_TOTAL_BYTES) {
        throw new HttpError("Data JSON backup setelah ditambahkan referensi foto melebihi batas. Kurangi data laporan lalu ulangi backup.", 413);
      }
      files[0].file = json;
    }

    for (const entry of [...files.slice(1), files[0]]) {
      const saved = await uploadDriveFile(entry.file, entry.name + "-" + stamp + entry.ext, backupSnapshotFolderId, accessToken);
      if (!saved.id) throw new HttpError("Google Drive tidak mengembalikan ID file.", 502);
      uploaded.push({ id: String(saved.id), name: String(saved.name || entry.name + entry.ext), size: Number(saved.size || entry.file.size), kind: "data" });
    }
    const totalBytes = uploaded.reduce((sum, item) => sum + item.size, 0);
    const photoUploads = uploaded.filter((item) => item.kind === "photo");
    const backupFileSummary = uploaded.filter((item) => item.kind === "data").map(({ name, size }) => ({ name, size }));
    if (photoUploads.length) backupFileSummary.push({ name: "Foto bukti (" + photoUploads.length + " foto)", size: photoUploads.reduce((sum, item) => sum + item.size, 0) });
    const savedAt = new Date().toISOString();
    const { error: updateError } = await service.from("simlsp_drive_connections").update({
      last_backup_at: savedAt,
      last_backup_status: "sukses",
      last_backup_name: snapshotName,
      last_backup_folder_id: backupSnapshotFolderId,
      last_backup_size_bytes: totalBytes,
      last_backup_files: backupFileSummary,
      last_backup_error: "",
      updated_at: savedAt,
    }).eq("user_id", userId);
    if (updateError) throw new HttpError("File berhasil masuk Drive, tetapi status backup gagal disimpan di SIM-LSP.", 500);
    await recordBackupRun(service, { run_at: savedAt, source, status: "sukses", backup_name: snapshotName, folder_id: backupSnapshotFolderId, size_bytes: totalBytes, files: backupFileSummary, photo_count: photoUploads.length, error: "" });
    return { ok: true, name: snapshotName, folderId: backupSnapshotFolderId, sizeBytes: totalBytes, photoCount: photoUploads.length, files: backupFileSummary };
  } catch (error) {
    for (const item of uploaded) await deleteDriveFile(item.id, accessToken);
    if (backupSnapshotFolderId) await deleteDriveFile(backupSnapshotFolderId, accessToken);
    const message = safeErrorMessage(error instanceof Error ? error.message : error);
    await setBackupFailure(service, userId, message);
    await recordBackupRun(service, { source, status: "gagal", backup_name: snapshotName, folder_id: "", size_bytes: 0, files: [], photo_count: 0, error: message });
    throw new HttpError(message, error instanceof HttpError ? error.status : 502);
  }
}

function safeKeyMatches(left: string, right: string) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function jakartaDate(value: unknown) {
  if (!value) return "";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

function nightlyWorkbooks(data: Record<string, any>) {
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const transactions = Array.isArray(data.assetTransactions) ? data.assetTransactions : [];
  const reportRows: unknown[][] = [["No", "Kode Laporan", "Tgl", "Jam", "Unit", "Area/Sarana", "PJS", "Pelapor", "Jenis Laporan", "Objek/Sarana", "Uraian Laporan", "Pelaksana", "Penyetuju", "Status", "BAHAN", "JASA", "Hasil/Tindakan", "Prioritas", "Tanggal Selesai", "Status Persetujuan", "Jumlah Pengadaan", "Satuan Pengadaan"]];
  reports.slice().sort((a: any, b: any) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)).forEach((r: any, i: number) => {
    const d = r.createdAt ? new Date(r.createdAt) : new Date(0);
    reportRows.push([i + 1, r.code || "", jakartaDate(r.createdAt), Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d), r.unit || "", r.location || "", r.pj || "", r.reporterName || "", r.category || "", r.object || "", r.description || "", r.executor || "", r.approverName || "", r.status || "", Number(r.materialCost || 0), Number(r.serviceCost || 0), r.result || "", r.priority || "", jakartaDate(r.completedAt), r.approvalStatus || "", Number(r.acquisitionQuantity || 0), r.acquisitionUnit || ""]);
  });
  const assetRows: unknown[][] = [["ID Aset", "Nama Aset", "Satuan", "Jumlah Stok", "Tanggal Pengadaan", "Lokasi/Area", "Status Penggunaan", "Kondisi Fisik", "Keterangan", "Tanggal Dibuat", "Terakhir Diperbarui"]];
  assets.forEach((a: any) => assetRows.push([a.id || "", a.name || "", a.unit || "", Number(a.quantity || 0), a.acquisitionDate || "", a.area || "", a.status || "", a.condition || "", a.description || "", a.createdAt || "", a.updatedAt || ""]));
  const historyRows: unknown[][] = [["No", "ID Aset", "Nama Aset", "Jenis Transaksi", "Perubahan Stok", "Satuan", "Sumber", "Kode Laporan", "Catatan", "Oleh", "Tanggal"]];
  transactions.forEach((t: any, i: number) => {
    const delta = t.type === "PENYESUAIAN" ? Number(t.adjustment || 0) : ((t.type === "MASUK" || t.type === "TRANSFER_IN") ? Number(t.quantity || 0) : (t.type === "TRANSFER_OUT" ? -Number(t.quantity || 0) : (t.type === "STATUS" ? 0 : -Number(t.quantity || 0))));
    historyRows.push([i + 1, t.assetId || "", t.assetName || "", t.type || "", delta, t.unit || "", t.source || "", t.reportCode || "", t.note || "", t.actor || "", t.at || ""]);
  });
  const make = (sheets: Array<{ name: string; rows: unknown[][] }>) => {
    const workbook = XLSX.utils.book_new();
    sheets.forEach((sheet) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name));
    return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  };
  return {
    reports: make([{ name: "Data Laporan", rows: reportRows }]),
    assets: make([{ name: "Data Aset", rows: assetRows }, { name: "Riwayat Stok", rows: historyRows }]),
  };
}

async function nightlyBackup(service: ReturnType<typeof serviceClient>) {
  const { data: state, error: stateError } = await service.from("simlsp_shared_state").select("data").eq("id", true).maybeSingle();
  if (stateError || !state?.data) throw new HttpError("Data bersama SIM-LSP tidak dapat dibaca untuk backup otomatis.", 500);
  const { data: admins, error: adminError } = await service.from("simlsp_profiles").select("id").eq("role", "sarpras_admin");
  if (adminError || !admins?.length) throw new HttpError("Akun Sarpras/Admin tidak ditemukan.", 409);
  const { data: connections, error: connectionError } = await service.from("simlsp_drive_connections").select("user_id,updated_at,refresh_token_ciphertext").in("user_id", admins.map((row: any) => row.id)).order("updated_at", { ascending: false });
  if (connectionError || !connections?.length) throw new HttpError("Belum ada Google Drive Sarpras/Admin yang terhubung untuk backup otomatis.", 409);
  const userId = String(connections[0].user_id);
  const appData = state.data as Record<string, any>;
  const payload = { app: "SIM-LSP", exportedAt: new Date().toISOString(), ...appData };
  const workbooks = nightlyWorkbooks(appData);
  const form = new FormData();
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  form.append("json", new File([JSON.stringify(payload)], `SIM-LSP-Cadangan-${stamp}.json`, { type: "application/json" }));
  form.append("reports", new File([workbooks.reports], `SIM-LSP-Laporan-${stamp}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  form.append("assets", new File([workbooks.assets], `SIM-LSP-Aset-${stamp}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const request = new Request("https://internal.sim-lsp/functions/v1/simlsp-drive-backup", { method: "POST", body: form });
  const result = await uploadBackup(request, service, userId, NIGHTLY_SOURCE);
  return { ...result, source: NIGHTLY_SOURCE };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(request.url);
  if (request.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await oauthCallback(request);
  if (request.method !== "POST") return json({ error: "Metode tidak didukung." }, 405);

  try {
    const internalKey = Deno.env.get("SIMLSP_BACKUP_CRON_KEY") || "";
    if (request.headers.has("x-simlsp-cron-key")) {
      if (!internalKey || !safeKeyMatches(request.headers.get("x-simlsp-cron-key") || "", internalKey)) throw new HttpError("Kunci pemicu backup otomatis tidak valid.", 401);
      const service = serviceClient();
      try { return json(await nightlyBackup(service)); }
      catch (error) {
        const message = safeErrorMessage(error instanceof Error ? error.message : error);
        await recordBackupRun(service, { source: NIGHTLY_SOURCE, status: "gagal", error: message });
        throw error;
      }
    }
    const { service, userId } = await requireAdmin(request);
    if (request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      const result = await uploadBackup(request, service, userId, "manual");
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
