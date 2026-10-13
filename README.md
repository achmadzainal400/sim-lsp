# SIM-LSP

PWA Sarana Prasarana Madrasah Darul Falah. Situs dipublikasikan melalui GitHub Pages dan otomatis diperbarui setiap ada push ke cabang `main`.

Alamat situs: https://achmadzainal400.github.io/sim-lsp/

## Publikasi

Di **Settings → Pages**, pilih **GitHub Actions** sebagai sumber publikasi. Workflow `.github/workflows/deploy-pages.yml` menerbitkan isi folder ini.

## Ikon dan splash art

- Ikon aplikasi: `icons/simlsp-192.png` dan `icons/simlsp-512.png`
- Logo horizontal: `branding/SIM-LSP-logo-horizontal.png`
- Splash art 1080 × 1920: `splash/SIM-LSP-splash-1080x1920.png`
- File SVG disertakan supaya bisa diubah ukurannya tanpa pecah.

Jangan commit file rahasia atau kunci server. Secret notifikasi VAPID tetap disimpan di Supabase.

## Backend Supabase

GitHub Actions menerbitkan halaman web statis. Login, data bersama, dan notifikasi tetap memakai proyek Supabase. Edge Function `simlsp-notify-new-report` perlu di-deploy tersendiri di Supabase saat kodenya berubah; deploy GitHub Pages tidak menerbitkan Edge Function. Kode notifikasi membuka `https://achmadzainal400.github.io/sim-lsp/` setelah Edge Function diperbarui.
