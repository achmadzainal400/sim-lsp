import { withSupabase } from "npm:@supabase/server@1"

const LOGIN_DOMAIN = "lcfqhrziveksvxuldsfa.supabase.co"
const CREDENTIALS_TABLE = "simlsp_admin_passwords"
const CREDENTIAL_KEY_ENV = "SIMLSP_CREDENTIAL_VAULT_KEY"

function reply(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function getCredentialKey() {
  const encoded = Deno.env.get(CREDENTIAL_KEY_ENV) ?? ""
  if (!encoded) throw new Error(`Edge Function secret ${CREDENTIAL_KEY_ENV} belum diatur.`)
  let raw: Uint8Array
  try {
    raw = base64ToBytes(encoded.trim())
  } catch {
    throw new Error(`${CREDENTIAL_KEY_ENV} harus berupa Base64 dari 32 byte.`)
  }
  if (raw.length !== 32) throw new Error(`${CREDENTIAL_KEY_ENV} harus berupa Base64 dari 32 byte.`)
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

async function encryptPassword(key: CryptoKey, password: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(password))
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) }
}

async function decryptPassword(key: CryptoKey, iv: string, ciphertext: string) {
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext))
  return new TextDecoder().decode(clear)
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function storageError(error: { message?: string } | null) {
  const message = String(error?.message ?? "")
  if (/simlsp_admin_passwords|schema cache|does not exist|permission denied/i.test(message)) {
    return "Tabel sandi belum siap. Jalankan SIM-LSP-Kredensial-Vault.sql di Supabase SQL Editor."
  }
  return "Penyimpanan sandi terenkripsi gagal. Periksa tabel dan secret Edge Function."
}

async function encryptedCredentialRow(admin: any, accountId: string, password: string, actorId: string) {
  const key = await getCredentialKey()
  const encrypted = await encryptPassword(key, password)
  return {
    account_id: accountId,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    updated_by: actorId,
    updated_at: new Date().toISOString(),
  }
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "POST") return reply("Metode permintaan tidak didukung.", 405)

    const actorId = String(context.jwtClaims?.sub ?? "")
    if (!actorId) return reply("Sesi tidak valid. Silakan masuk kembali.", 401)

    const actorResult = await context.supabaseAdmin
      .from("simlsp_profiles")
      .select("role")
      .eq("id", actorId)
      .maybeSingle()

    if (actorResult.error || actorResult.data?.role !== "sarpras_admin") {
      return reply("Hanya Sarpras / Admin yang dapat mengelola akun.", 403)
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return reply("Isi permintaan tidak valid.")
    }

    if (body.action === "list") {
      const result = await context.supabaseAdmin
        .from("simlsp_profiles")
        .select("id, username, display_name, role, created_at")
        .order("username", { ascending: true })

      if (result.error) return reply("Daftar akun gagal dimuat.", 500)

      const credentials = await context.supabaseAdmin
        .from(CREDENTIALS_TABLE)
        .select("account_id, iv, ciphertext")

      if (credentials.error) return reply(storageError(credentials.error), 500)

      let key: CryptoKey | null = null
      try {
        key = await getCredentialKey()
      } catch (error) {
        if ((credentials.data ?? []).length) return reply(String((error as Error).message || "Kunci sandi tidak tersedia."), 500)
      }

      const passwords = new Map<string, string>()
      if (key) {
        try {
          for (const row of credentials.data ?? []) {
            passwords.set(String(row.account_id), await decryptPassword(key, row.iv, row.ciphertext))
          }
        } catch {
          return reply("Sandi tersimpan gagal dibuka. Secret enkripsi mungkin berubah; pulihkan secret sebelumnya.", 500)
        }
      }
      const accounts = (result.data ?? []).map((account) => ({
        ...account,
        password: passwords.get(String(account.id)) ?? null,
      }))
      return Response.json({ accounts, credentialStorageReady: !!key })
    }

    if (body.action === "save-credentials") {
      const input = Array.isArray(body.credentials) ? body.credentials : []
      if (!input.length || input.length > 500) return reply("CSV tidak berisi sandi akun yang cocok atau jumlahnya melebihi 500.")
      let key: CryptoKey
      try {
        key = await getCredentialKey()
      } catch (error) {
        return reply(String((error as Error).message || "Kunci sandi tidak tersedia."), 503)
      }

      const updates = new Map<string, string>()
      for (const raw of input) {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
        const accountId = String(item.accountId ?? "")
        const password = String(item.password ?? "")
        if (!isUuid(accountId) || password.length < 1 || password.length > 128) {
          return reply("CSV memuat akun atau sandi yang tidak valid. Sandi harus 1–128 karakter.")
        }
        updates.set(accountId, password)
      }
      const ids = [...updates.keys()]
      const profiles = await context.supabaseAdmin.from("simlsp_profiles").select("id").in("id", ids)
      if (profiles.error) return reply("Akun untuk sandi CSV gagal diverifikasi.", 500)
      const validIds = new Set((profiles.data ?? []).map((row) => String(row.id)))
      if (ids.some((id) => !validIds.has(id))) return reply("CSV merujuk akun yang sudah tidak terdaftar. Muat ulang daftar akun.")

      const rows = []
      for (const [accountId, password] of updates) {
        const encrypted = await encryptPassword(key, password)
        rows.push({ account_id: accountId, iv: encrypted.iv, ciphertext: encrypted.ciphertext, updated_by: actorId, updated_at: new Date().toISOString() })
      }
      const saved = await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert(rows, { onConflict: "account_id" })
      if (saved.error) return reply(storageError(saved.error), 500)
      return Response.json({ saved: rows.length })
    }

    if (body.action === "bulk-create") {
      const input = Array.isArray(body.accounts) ? body.accounts : []
      if (!input.length || input.length > 50) return reply("Impor harus berisi 1–50 akun per proses.")

      let key: CryptoKey
      try {
        key = await getCredentialKey()
      } catch (error) {
        return reply(String((error as Error).message || "Penyimpanan sandi belum siap."), 503)
      }
      const vaultReady = await context.supabaseAdmin.from(CREDENTIALS_TABLE).select("account_id").limit(1)
      if (vaultReady.error) return reply(storageError(vaultReady.error), 500)

      const existingResult = await context.supabaseAdmin.from("simlsp_profiles").select("id, username, display_name, role")
      if (existingResult.error) return reply("Daftar akun lama gagal diperiksa.", 500)
      const existingByUsername = new Map((existingResult.data ?? []).map((account) => [String(account.username ?? "").toLowerCase(), account]))
      const seenInFile = new Set<string>()
      const results: Array<{ rowNumber: number; username: string; success: boolean; message: string }> = []
      let createdCount = 0
      let updatedCount = 0

      for (let index = 0; index < input.length; index++) {
        const item = input[index] && typeof input[index] === "object" ? input[index] as Record<string, unknown> : {}
        const rowNumber = Number.isInteger(Number(item.rowNumber)) ? Number(item.rowNumber) : index + 2
        const username = String(item.username ?? "").trim()
        const displayName = String(item.displayName ?? "").trim()
        const password = String(item.password ?? "")
        const role = String(item.role ?? "warga")
        const fail = (message: string) => results.push({ rowNumber, username, success: false, message })

        if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) { fail("Username harus 3–40 karakter dan hanya memakai huruf, angka, titik, garis bawah, atau tanda hubung."); continue }
        if (displayName.length < 2 || displayName.length > 80) { fail("Nama harus 2–80 karakter."); continue }
        if (password.length < 6 || password.length > 128) { fail("Sandi harus 6–128 karakter."); continue }
        if (role !== "warga" && role !== "sarpras_admin") { fail("Role harus warga atau sarpras_admin."); continue }
        const normalizedUsername = username.toLowerCase()
        if (seenInFile.has(normalizedUsername)) { fail("Username muncul lebih dari sekali di file."); continue }
        seenInFile.add(normalizedUsername)

        const existing = existingByUsername.get(normalizedUsername)
        if (existing) {
          const userId = String(existing.id)
          const oldAuth = await context.supabaseAdmin.auth.admin.getUserById(userId)
          if (oldAuth.error || !oldAuth.data.user) { fail("Akun Auth tidak ditemukan; baris ini tidak diubah."); continue }
          const previous = await context.supabaseAdmin.from(CREDENTIALS_TABLE)
            .select("account_id, iv, ciphertext, updated_by, updated_at")
            .eq("account_id", userId)
            .maybeSingle()
          if (previous.error) { fail(storageError(previous.error)); continue }
          const oldCredential = previous.data ?? null
          const encrypted = await encryptPassword(key, password)
          const savedCredential = await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert({
            account_id: userId,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext,
            updated_by: actorId,
            updated_at: new Date().toISOString(),
          }, { onConflict: "account_id" })
          if (savedCredential.error) { fail(storageError(savedCredential.error)); continue }

          const profile = await context.supabaseAdmin.from("simlsp_profiles")
            .update({ username, display_name: displayName, role })
            .eq("id", userId)
            .select("id, username, display_name, role, created_at")
            .single()
          if (profile.error || !profile.data) {
            const rollback = oldCredential
              ? await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert(oldCredential, { onConflict: "account_id" })
              : await context.supabaseAdmin.from(CREDENTIALS_TABLE).delete().eq("account_id", userId)
            fail("Profil gagal diperbarui." + (rollback.error ? " Sandi brankas juga gagal dipulihkan; periksa akun ini." : " Perubahan dibatalkan."))
            continue
          }

          const nextEmail = `${normalizedUsername}@${LOGIN_DOMAIN}`
          const authChanges: { email?: string; email_confirm?: boolean; password: string } = { password }
          if ((oldAuth.data.user.email ?? "").toLowerCase() !== nextEmail.toLowerCase()) {
            authChanges.email = nextEmail
            authChanges.email_confirm = true
          }
          const authUpdate = await context.supabaseAdmin.auth.admin.updateUserById(userId, authChanges)
          if (authUpdate.error) {
            await context.supabaseAdmin.from("simlsp_profiles").update({ username: existing.username, display_name: existing.display_name, role: existing.role }).eq("id", userId)
            const rollback = oldCredential
              ? await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert(oldCredential, { onConflict: "account_id" })
              : await context.supabaseAdmin.from(CREDENTIALS_TABLE).delete().eq("account_id", userId)
            fail("Sandi/login gagal diperbarui." + (rollback.error ? " Sandi brankas lama juga gagal dipulihkan; periksa akun ini." : " Perubahan dibatalkan."))
            continue
          }
          existingByUsername.set(normalizedUsername, profile.data)
          updatedCount++
          results.push({ rowNumber, username, success: true, message: "Akun yang sudah ada diperbarui; sandi login dan brankas ikut diperbarui." })
          continue
        }

        const created = await context.supabaseAdmin.auth.admin.createUser({
          email: `${normalizedUsername}@${LOGIN_DOMAIN}`,
          password,
          email_confirm: true,
          user_metadata: { username, display_name: displayName },
        })
        if (created.error || !created.data.user) {
          fail(/already|duplicate|exists/i.test(created.error?.message ?? "") ? "Username sudah digunakan." : "Akun Auth gagal dibuat.")
          continue
        }

        const profile = await context.supabaseAdmin.from("simlsp_profiles")
          .upsert({ id: created.data.user.id, username, display_name: displayName, role }, { onConflict: "id" })
          .select("id, username, display_name, role, created_at")
          .single()
        if (profile.error || !profile.data) {
          await context.supabaseAdmin.auth.admin.deleteUser(created.data.user.id)
          fail("Profil gagal dibuat; akun yang baru dibuat dibatalkan.")
          continue
        }

        const encrypted = await encryptPassword(key, password)
        const saved = await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert({
          account_id: created.data.user.id,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          updated_by: actorId,
          updated_at: new Date().toISOString(),
        }, { onConflict: "account_id" })
        if (saved.error) {
          await context.supabaseAdmin.auth.admin.deleteUser(created.data.user.id)
          fail(storageError(saved.error) + " Akun baru dibatalkan.")
          continue
        }
        existingByUsername.set(normalizedUsername, profile.data)
        createdCount++
        results.push({ rowNumber, username, success: true, message: "Akun baru berhasil dibuat." })
      }

      return Response.json({ results, created: createdCount, updated: updatedCount, failed: results.filter((row) => !row.success).length })
    }

    if (body.action === "create") {
      const username = String(body.username ?? "").trim()
      const displayName = String(body.displayName ?? "").trim()
      const password = String(body.password ?? "")

      if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
        return reply("Username harus 3–40 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.")
      }
      if (displayName.length < 2 || displayName.length > 80) {
        return reply("Nama lengkap harus 2–80 karakter.")
      }
      if (password.length < 6 || password.length > 128) {
        return reply("Kata sandi harus 6–128 karakter.")
      }

      let passwordRow: Record<string, unknown>
      try {
        passwordRow = await encryptedCredentialRow(context.supabaseAdmin, "pending", password, actorId)
      } catch (error) {
        return reply(String((error as Error).message || "Penyimpanan sandi belum siap."), 503)
      }
      const duplicateResult = await context.supabaseAdmin.from("simlsp_profiles").select("username")
      if (duplicateResult.error) return reply("Pemeriksaan username gagal.", 500)
      if ((duplicateResult.data ?? []).some((account) => account.username.toLowerCase() === username.toLowerCase())) {
        return reply("Username tersebut sudah digunakan.", 409)
      }

      const created = await context.supabaseAdmin.auth.admin.createUser({
        email: `${username.toLowerCase()}@${LOGIN_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { username, display_name: displayName },
      })
      if (created.error || !created.data.user) {
        if (/already|duplicate|exists/i.test(created.error?.message ?? "")) return reply("Username tersebut sudah digunakan.", 409)
        return reply("Akun gagal dibuat. Periksa username dan kata sandi.", 400)
      }

      const profile = await context.supabaseAdmin
        .from("simlsp_profiles")
        .upsert({ id: created.data.user.id, username, display_name: displayName, role: "warga" }, { onConflict: "id" })
        .select("id, username, display_name, role, created_at")
        .single()
      if (profile.error || !profile.data) {
        await context.supabaseAdmin.auth.admin.deleteUser(created.data.user.id)
        return reply("Profil akun gagal dibuat. Pembuatan akun dibatalkan.", 500)
      }

      const encrypted = await encryptPassword(await getCredentialKey(), password)
      const saved = await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert({
        account_id: created.data.user.id,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "account_id" })
      if (saved.error) {
        await context.supabaseAdmin.auth.admin.deleteUser(created.data.user.id)
        return reply(storageError(saved.error) + " Akun baru dibatalkan.", 500)
      }
      return Response.json({ account: profile.data, passwordSaved: true })
    }

    if (body.action === "delete") {
      const userId = String(body.userId ?? "")
      if (!isUuid(userId)) return reply("Identitas akun tidak valid.")

      const target = await context.supabaseAdmin.from("simlsp_profiles").select("id").eq("id", userId).maybeSingle()
      if (target.error) return reply("Data akun gagal dibaca.", 500)
      if (!target.data) return reply("Akun tidak ditemukan.", 404)

      const deletion = await context.supabaseAdmin.auth.admin.deleteUser(userId)
      if (deletion.error) return reply(`Penghapusan akun gagal: ${deletion.error.message}`, 400)
      const cleanup = await context.supabaseAdmin.from("simlsp_profiles").delete().eq("id", userId)
      if (cleanup.error) return reply(`Akun Auth terhapus, tetapi profil gagal dibersihkan: ${cleanup.error.message}`, 500)
      const remaining = await context.supabaseAdmin.from("simlsp_profiles").select("id").eq("id", userId).maybeSingle()
      if (remaining.error) return reply("Status penghapusan akun tidak dapat diverifikasi.", 500)
      if (remaining.data) return reply("Akun masih tercatat di profil dan belum benar-benar terhapus.", 500)
      return Response.json({ deleted: true, userId })
    }

    if (body.action !== "update") return reply("Aksi tidak dikenal.")

    const userId = String(body.userId ?? "")
    const username = String(body.username ?? "").trim()
    const displayName = String(body.displayName ?? "").trim()
    const role = String(body.role ?? "")
    const password = body.password == null ? "" : String(body.password)

    if (!isUuid(userId)) return reply("Identitas akun tidak valid.")
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return reply("Username harus 3–40 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.")
    if (displayName.length < 2 || displayName.length > 80) return reply("Nama lengkap harus 2–80 karakter.")
    if (role !== "warga" && role !== "sarpras_admin") return reply("Peran akun tidak dikenal.")
    if (password && (password.length < 6 || password.length > 128)) return reply("Kata sandi baru harus 6–128 karakter.")

    let key: CryptoKey | null = null
    let encrypted: { iv: string; ciphertext: string } | null = null
    let previousCredential: Record<string, unknown> | null = null
    if (password) {
      try {
        key = await getCredentialKey()
      } catch (error) {
        return reply(String((error as Error).message || "Penyimpanan sandi belum siap."), 503)
      }
      const previous = await context.supabaseAdmin.from(CREDENTIALS_TABLE).select("account_id, iv, ciphertext, updated_by, updated_at").eq("account_id", userId).maybeSingle()
      if (previous.error) return reply(storageError(previous.error), 500)
      previousCredential = previous.data ?? null
      encrypted = await encryptPassword(key, password)
    }

    const targetResult = await context.supabaseAdmin.from("simlsp_profiles").select("id, username, display_name, role").eq("id", userId).maybeSingle()
    if (targetResult.error) return reply("Data akun gagal dibaca.", 500)
    if (!targetResult.data) return reply("Akun tidak ditemukan.", 404)
    const target = targetResult.data
    const duplicateResult = await context.supabaseAdmin.from("simlsp_profiles").select("id, username").neq("id", userId)
    if (duplicateResult.error) return reply("Pemeriksaan username gagal.", 500)
    if ((duplicateResult.data ?? []).some((account) => account.username.toLowerCase() === username.toLowerCase())) return reply("Username tersebut sudah digunakan.", 409)

    const profileUpdate = await context.supabaseAdmin.from("simlsp_profiles")
      .update({ username, display_name: displayName, role })
      .eq("id", userId)
      .select("id, username, display_name, role, created_at")
      .single()
    if (profileUpdate.error || !profileUpdate.data) {
      if (profileUpdate.error?.code === "23505") return reply("Username tersebut sudah digunakan.", 409)
      return reply("Perubahan profil gagal disimpan.", 500)
    }

    const oldAuth = await context.supabaseAdmin.auth.admin.getUserById(userId)
    if (oldAuth.error || !oldAuth.data.user) {
      await context.supabaseAdmin.from("simlsp_profiles").update({ username: target.username, display_name: target.display_name, role: target.role }).eq("id", userId)
      return reply("Akun Auth tidak ditemukan. Profil dikembalikan seperti semula.", 404)
    }
    const nextEmail = `${username.toLowerCase()}@${LOGIN_DOMAIN}`
    const authChanges: { email?: string; email_confirm?: boolean; password?: string } = {}
    if ((oldAuth.data.user.email ?? "").toLowerCase() !== nextEmail.toLowerCase()) {
      authChanges.email = nextEmail
      authChanges.email_confirm = true
    }
    if (password) authChanges.password = password

    if (Object.keys(authChanges).length) {
      const authUpdate = await context.supabaseAdmin.auth.admin.updateUserById(userId, authChanges)
      if (authUpdate.error) {
        await context.supabaseAdmin.from("simlsp_profiles").update({ username: target.username, display_name: target.display_name, role: target.role }).eq("id", userId)
        if (/already|duplicate|exists/i.test(authUpdate.error.message ?? "")) return reply("Username tersebut sudah digunakan.", 409)
        return reply("Perubahan login gagal disimpan. Profil dikembalikan seperti semula.", 400)
      }
    }

    if (password && encrypted) {
      const saved = await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert({
        account_id: userId,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "account_id" })
      if (saved.error) {
        const rollback = previousCredential
          ? await context.supabaseAdmin.from(CREDENTIALS_TABLE).upsert(previousCredential, { onConflict: "account_id" })
          : await context.supabaseAdmin.from(CREDENTIALS_TABLE).delete().eq("account_id", userId)
        return reply(storageError(saved.error) + (rollback.error ? " Data sandi tersimpan sebelumnya juga gagal dipulihkan." : " Kata sandi login sudah berubah; ulangi penyimpanan sandi dari Kelola akun."), 500)
      }
    }

    return Response.json({ account: profileUpdate.data, passwordSaved: password ? true : undefined })
  }),
}
