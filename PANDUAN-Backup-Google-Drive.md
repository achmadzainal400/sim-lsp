# Menyiapkan backup SIM-LSP ke Google Drive

Fungsi backup menyimpan JSON lengkap SIM-LSP, Excel laporan, Excel aset beserta riwayat stok, dan salinan semua foto bukti yang masih tersedia di Storage. Foto disimpan di subfolder `Foto-Bukti` dalam folder cadangan bertanggal; JSON menyertakan referensi file foto di Drive. Foto asli tetap berada di Storage Supabase. Hanya Sarpras/Admin yang dapat menyambungkan Drive, mengirim backup, dan melihat pemakaian Storage.

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

Untuk backup otomatis, buat satu secret tambahan bernama `SIMLSP_BACKUP_CRON_KEY`. Nilainya harus sama persis pada **Edge Function secret** dan **Supabase Vault**. Kunci ini hanya dipakai pemicu terjadwal untuk memanggil fungsi; jangan letakkan nilainya di repository.

## 3. Hubungkan akun dan buat backup

Masuk sebagai Sarpras/Admin, buka **Data & cadangan**, lalu pilih **Hubungkan Google Drive**. Setelah izin diberikan, gunakan **Backup sekarang ke Google Drive**. Setiap backup disimpan sebagai folder bertanggal di `SIM-LSP/Backup`.

Jika koneksi Google dicabut atau kedaluwarsa, hubungkan ulang. Supabase menampilkan status dan waktu backup terakhir. Panel Storage memberi peringatan kuning mulai 70% dan merah mulai 90% dari kuota 1 GiB yang saat ini digunakan proyek Free.

## 4. SQL dan fungsi

Jalankan `supabase/sql/SIM-LSP-Drive-Backup.sql` pada database proyek, lalu deploy fungsi `simlsp-drive-backup` dengan verifikasi JWT bawaan dimatikan. Fungsi memeriksa sendiri sesi dan peran Sarpras/Admin untuk setiap permintaan aplikasi; callback OAuth memakai state acak yang hanya berlaku sekali dan singkat.

## 5. Backup otomatis setiap tengah malam WIB

1. Pastikan `SIMLSP_BACKUP_CRON_KEY` tersimpan pada Edge Function Secrets dan pada Supabase Vault dengan nilai yang identik.
2. Jalankan `supabase/sql/SIM-LSP-Backup-Otomatis.sql` pada database proyek. SQL membuat tabel status privat dan jadwal `simlsp-drive-backup-nightly`.
3. Deploy ulang fungsi `simlsp-drive-backup` supaya fungsi mengenali pemanggilan terjadwal.
4. Jadwal database menggunakan UTC: **17.00 UTC = 00.00 WIB** hari berikutnya. Riwayatnya dapat dilihat di Supabase **Integrations → Cron → Jobs / Run history**.
5. Admin dapat melihat hasil terakhir di **Data & cadangan**. Jika gagal, aplikasi menampilkan peringatan dan alasannya.

Backup otomatis memilih koneksi Google Drive admin/sarpras yang paling baru diperbarui. Hubungkan setidaknya satu akun Google Drive admin. Setiap malam dibuat snapshot baru; file foto disalin lagi ke snapshot tersebut, sehingga penggunaan Drive akan terus bertambah. Belum ada penghapusan otomatis berdasarkan umur.

## 6. Rekap bulanan

Sarpras/Admin dapat memilih bulan pada **Data & cadangan**, lalu mengunduh Excel atau mengirimkannya ke `SIM-LSP/Rekap Bulanan/YYYY-MM` pada Google Drive. Workbook memiliki:

- `Ringkasan`: jumlah tiket pada setiap status, jenis laporan, unit, biaya bahan/jasa, rata-rata hari penyelesaian, serta jumlah laporan terbuka dan terlambat.
- `Daftar Laporan`: seluruh laporan yang dibuat pada bulan terpilih beserta status, biaya, dan informasi penanganan.
- `Laporan Terbuka`: semua tiket yang belum selesai saat rekap dibuat. Tiket yang berumur **lebih dari 14 hari** diberi tanda `Terlambat`.

Periode biaya dan agregat mengikuti bulan laporan dibuat. Rata-rata waktu penyelesaian hanya menghitung tiket bulan tersebut yang telah selesai dan memiliki waktu pembuatan serta penyelesaian yang valid. Karena sistem belum menyimpan tenggat/SLA per tiket, label terlambat menggunakan umur tiket 14 hari, bukan tenggat khusus.
