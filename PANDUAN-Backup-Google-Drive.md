# Menyiapkan backup SIM-LSP ke Google Drive

Fungsi backup menyimpan tiga file setiap kali dipakai: JSON lengkap SIM-LSP, Excel laporan, dan Excel aset beserta riwayat stok. Foto tidak disalin; metadata dan lokasi file foto tetap ada di JSON. Hanya Sarpras/Admin yang dapat menyambungkan Drive, mengirim backup, dan melihat pemakaian Storage.

## 1. Siapkan Google Cloud

1. Buat project di [Google Cloud Console](https://console.cloud.google.com/).
2. Aktifkan **Google Drive API** pada project tersebut.
3. Siapkan OAuth consent screen. Untuk penggunaan yang berkelanjutan, ubah status publikasi ke **Production**. Aplikasi External yang masih berstatus Testing dapat menerima refresh token yang kedaluwarsa setelah 7 hari.
4. Buat OAuth Client ID dengan jenis **Web application**.
5. Tambahkan Authorized redirect URI persis seperti berikut:

   `https://lcfqhrziveksvxuldsfa.supabase.co/functions/v1/simlsp-drive-backup`

## 2. Pasang rahasia OAuth di Supabase

Di Supabase Dashboard, buka **Project Settings → Edge Functions → Secrets** dan tambahkan Client ID serta Client Secret. Kunci vault SIM-LSP yang sudah ada dipakai sebagai sumber untuk menurunkan kunci Drive tersendiri; jangan mengganti nilainya.

| Nama secret | Nilai |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID dari Google Cloud |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client Secret dari Google Cloud |
Fungsi menurunkan kunci khusus Google Drive dari `SIMLSP_CREDENTIAL_VAULT_KEY` dengan HKDF; kunci vault tidak dipakai langsung untuk mengenkripsi token Drive. Jangan masukkan nilai Client Secret atau kunci ke file web atau ke percakapan. Jika suatu saat menggunakan secret khusus `SIMLSP_DRIVE_TOKEN_ENCRYPTION_KEY`, kunci itu harus tetap sama; menggantinya membuat token Drive yang sudah tersimpan tidak dapat dibaca.

## 3. Hubungkan akun dan buat backup

Masuk sebagai Sarpras/Admin, buka **Data & cadangan**, lalu pilih **Hubungkan Google Drive**. Setelah izin diberikan, gunakan **Backup sekarang ke Google Drive**. Setiap backup disimpan sebagai folder bertanggal di `SIM-LSP/Backup`.

Jika koneksi Google dicabut atau kedaluwarsa, hubungkan ulang. Supabase menampilkan status dan waktu backup terakhir. Panel Storage memberi peringatan kuning mulai 70% dan merah mulai 90% dari kuota 1 GiB yang saat ini digunakan proyek Free.

## 4. SQL dan fungsi

Jalankan `supabase/sql/SIM-LSP-Drive-Backup.sql` pada database proyek, lalu deploy fungsi `simlsp-drive-backup` dengan verifikasi JWT bawaan dimatikan. Fungsi memeriksa sendiri sesi dan peran Sarpras/Admin untuk setiap permintaan aplikasi; callback OAuth memakai state acak yang hanya berlaku sekali dan singkat.
