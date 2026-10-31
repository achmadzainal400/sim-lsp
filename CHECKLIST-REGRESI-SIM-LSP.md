# Checklist regresi SIM-LSP

Jalankan setelah perubahan rilis. Catat perangkat, akun uji, tanggal, hasil, dan tiket uji. Jangan gunakan data akun atau laporan nyata untuk kasus gagal.

- [ ] Login warga berhasil; kata sandi salah ditolak; logout kembali ke login.
- [ ] **Lupa kata sandi?** membuka petunjuk Admin/Kelola Akun.
- [ ] Admin dapat mengubah kata sandi akun uji; sandi baru dapat dipakai login dan sandi lama ditolak.
- [ ] Onboarding akun baru menampilkan tiga langkah; **Lewati** dan **Mengerti** menutup modal; muat ulang tidak menampilkan onboarding lagi.
- [ ] Warga membuat laporan dan mendapat kode tiket; tiket muncul di **Lacak Laporan Saya**.
- [ ] Perbaikan/Pengaduan tanpa foto ditolak; foto dapat dipilih, dikompresi, diunggah, dan dibuka dari detail tiket.
- [ ] Laporan serupa (lokasi/objek mirip dalam 14 hari) memberi peringatan, tetapi tiket tetap terkirim.
- [ ] Warga menerima pemberitahuan status setelah perangkat mengaktifkan izin dan langganan notifikasi.
- [ ] Admin memverifikasi, menugaskan, memulai pekerjaan, menunda dengan alasan, dan menyelesaikan laporan.
- [ ] Admin tidak dapat menolak tanpa alasan; alasan terlihat di detail warga dan disertakan di notifikasi.
- [ ] Badge antrean sama dengan jumlah tiket yang masuk antrean.
- [ ] Aset bertambah dari pengadaan, berkurang saat digunakan, dan ringkasan mutasi mengikuti filter periode.
- [ ] Ekspor laporan/aset, template aset, dan impor file uji berjalan tanpa mengganti data secara tidak sengaja.
- [ ] Backup manual ke Drive berhasil; file ditemukan di folder SIM-LSP; backup JSON dapat diunduh.
- [ ] Rekap bulanan dan filter bulan/tahun sesuai dengan data uji.
- [ ] Dashboard Admin: jumlah tiket mengikuti filter bulan/tahun; tiga jenis terbanyak benar untuk semua periode, tahun, dan bulan; rata-rata hanya menghitung tiket selesai; tiket terlambat >14 hari menghitung semua tiket aktif.
- [ ] Ringkasan mutasi aset: stok masuk/keluar, pemindahan, dan penyesuaian mengikuti periode; satu pemindahan tidak dihitung dua kali.
- [ ] Peringatan duplikat hanya membandingkan tiket terbuka di 14 hari terakhir dan tidak memblokir kiriman baru.
- [ ] Dashboard analitik tampil untuk Admin, tidak tampil untuk Warga; ubah filter dengan keyboard tanpa kehilangan fokus.
- [ ] Skip-link membawa fokus ke konten; label input tertaut; toast diumumkan pembaca layar; setiap foto detail memiliki teks alternatif.
- [ ] Versi web dan dialog **Yang baru** sama dengan changelog rilis; APK dan web mencantumkan versi masing-masing.
- [ ] Pada zoom 200% tidak ada konten penting terpotong. Uji viewport 640 px (perkiraan desktop 1280 px pada zoom 200%), 390 px, dan 320 px; catat horizontal overflow.
- [ ] Navigasi Tab/Shift+Tab mengikuti urutan logis; Enter/Space mengaktifkan tombol, Escape menutup dialog, dan fokus kembali ke pemicu dialog.
