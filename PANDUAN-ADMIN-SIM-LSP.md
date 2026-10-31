# Panduan singkat Admin SIM-LSP

## Alur laporan

1. Buka **Antrean** atau **Semua laporan**, lalu pilih tiket untuk membaca uraian dan foto bukti.
2. Verifikasi laporan. Laporan yang layak masuk **Terverifikasi/Antrean** atau **Menunggu persetujuan** sesuai kebutuhan.
3. Tetapkan PJ dan pelaksana, lalu ubah status menjadi **Dalam pengerjaan**. Catat biaya dan hasil pekerjaan saat tersedia.
4. Gunakan **Ditunda** hanya dengan alasan yang jelas. Status **Ditolak** mewajibkan alasan; alasan muncul di detail dan dikirim bersama pemberitahuan status.
5. Tandai **Selesai** setelah hasil pekerjaan diperiksa. Tiket terbuka lebih dari 14 hari ditandai terlambat. SLA layanan: verifikasi maksimal 1×24 jam kerja; tindak lanjut maksimal 7 hari.

## Ringkasan dan analitik

Dashboard Admin menampilkan volume laporan per bulan, tiga jenis laporan terbanyak, rata-rata hari dari laporan dibuat hingga selesai, dan jumlah tiket terbuka yang lebih dari 14 hari. Pilih bulan dan tahun untuk membatasi jumlah, rata-rata, dan jenis terbanyak. Angka tiket terlambat selalu menghitung seluruh tiket aktif. **Perubahan aset pada periode** dapat dibuka di bagian bawah analitik untuk melihat stok masuk/keluar, pemindahan, dan penyesuaian.

Saat warga mengirim laporan dengan lokasi dan objek serupa tiket terbuka dalam 14 hari terakhir, aplikasi memberi peringatan kode tiket. Peringatan tidak membatalkan laporan; periksa tiket lama sebelum melanjutkan tindak lanjut.

## Backup Google Drive

Di **Data & cadangan → Cadangan & sync**, hubungkan akun Drive Admin jika belum tersambung. Pilih **Backup sekarang ke Google Drive**, lalu tunggu konfirmasi berhasil. Periksa waktu backup terakhir dan nama file sebelum meninggalkan halaman. Unduh cadangan JSON secara berkala juga. Jangan membagikan credential OAuth atau secret Supabase.

## Atur ulang kata sandi warga

Buka **Kelola akun** melalui aplikasi pendaftaran/kelola akun. Cari username warga, pilih **Ubah**, isi kata sandi baru minimal 6 karakter, lalu simpan. Sampaikan sandi baru secara pribadi kepada pemilik akun. Akun SIM-LSP memakai username, sehingga reset otomatis lewat email tidak tersedia.

## Notifikasi

Pemberitahuan status dikirim ke perangkat warga yang sudah mengaktifkan notifikasi dan memberi izin browser. Jika notifikasi tidak masuk, minta warga membuka **Data & cadangan → Notifikasi** pada perangkatnya dan memeriksa izin serta status langganan.

## Versi aplikasi

Nomor **SIM-LSP Web** dan tombol **Yang baru** tersedia di bagian bawah halaman masuk dan **Data & cadangan → Sistem**. Aplikasi web memperbarui diri saat terhubung ke internet. APK Android dibagikan terpisah; periksa nomor versi APK sebelum memasang pembaruan.
