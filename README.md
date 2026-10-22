# SIM-LSP

PWA Sarana Prasarana Madrasah Darul Falah. Situs dipublikasikan melalui GitHub Pages dan otomatis diperbarui setiap ada push ke cabang `main`.

Alamat situs: https://achmadzainal400.github.io/sim-lsp/

## Offline

Setelah halaman berhasil dibuka online, service worker menyimpan shell aplikasi dan aset statis agar SIM-LSP tetap bisa dibuka saat jaringan putus. Login, pembacaan data bersama, pengiriman laporan, dan sinkronisasi aset tetap memerlukan internet; cache offline tidak menggantikan Supabase.

## Publikasi

Di **Settings → Pages**, pilih **GitHub Actions** sebagai sumber publikasi. Workflow `.github/workflows/deploy-pages.yml` menerbitkan isi folder ini.

## Ikon dan splash art

- Ikon aplikasi memakai lambang Madrasah Darul Falah: `icons/simlsp-192.png` dan `icons/simlsp-512.png`
- Ikon maskable Android: `icons/simlsp-192-maskable.png` dan `icons/simlsp-512-maskable.png`
- Gambar palu dan obeng tetap dipakai khusus untuk layar pemuatan: `icons/simlsp-refresh-tools.png`
- Sumber lambang: `branding/SIM-LSP-logo-madrasah.png`
- Ikon notifikasi memakai ilustrasi perkakas transparan; `simlsp-notification-badge.png` khusus badge Android.
- Logo horizontal: `branding/SIM-LSP-logo-horizontal.png`
- Splash art 1080 × 1920: `splash/SIM-LSP-splash-1080x1920.png`
- File SVG disertakan supaya bisa diubah ukurannya tanpa pecah.
- Splash animasi menampilkan indikator memuat sampai halaman dan sesi awal selesai dimuat.

Jangan commit file rahasia atau kunci server. Secret notifikasi VAPID tetap disimpan di Supabase.

## Backend Supabase

Login, data bersama, dan notifikasi memakai proyek Supabase. SQL sumber berada di `supabase/sql/`; skrip sumber mengaktifkan RLS pada tabel privat, mencabut akses tabel langsung, dan memeriksa peran di RPC. Jalankan `SIM-LSP-Security-Check.sql` untuk memeriksa konfigurasi proyek Supabase yang aktif; isi file lokal saja tidak membuktikan SQL sudah diterapkan di server.

GitHub Actions dapat menerbitkan Edge Functions setelah repo memiliki variable `SUPABASE_FUNCTIONS_DEPLOY_ENABLED=true` dan secret `SUPABASE_ACCESS_TOKEN`. Deploy dipicu ketika sumber fungsi berubah atau dari **Actions → Deploy SIM-LSP Supabase Functions → Run workflow**. Workflow ini menerbitkan kode fungsi saja; SQL dan secrets seperti VAPID serta kredensial Firebase tetap dikelola di Supabase.

Untuk perbaikan notifikasi terbaru, jalankan ulang `SIM-LSP-PWA-Notifikasi.sql` di SQL Editor Supabase, deploy ulang fungsi `simlsp-notify-new-report`, lalu di SIM-LSP buka **Data & cadangan → Kirim notifikasi uji**. Tombol uji mengirim ke perangkat milik akun Sarpras/Admin yang sedang masuk dan menampilkan pesan jika konfigurasi server belum lengkap.

## Angka antrean di Android

Pembaruan APK Android memakai satu notifikasi tetap yang menampilkan jumlah laporan aktif dalam antrean, termasuk `0`. Untuk menyiapkannya, jalankan `SIM-LSP-QueueNotification.sql`, simpan service account Firebase sebagai secret `FIREBASE_SERVICE_ACCOUNT_JSON` di Supabase, lalu deploy fungsi `simlsp-queue-notification`. Jangan commit service account atau private key.

## APK

`SIM-LSP-Android.apk` adalah satu-satunya unduhan APK di situs. Isinya saat ini memakai `versionName 1.3` dan `versionCode 4`; versi 1.4 di konfigurasi proyek Android belum menjadi APK rilis. Jangan mengganti nama APK sebelum nilai versi di dalam paket diverifikasi. Rilis APK berikutnya perlu dibangun dan ditandatangani dengan konfigurasi Firebase serta signing key yang benar.
