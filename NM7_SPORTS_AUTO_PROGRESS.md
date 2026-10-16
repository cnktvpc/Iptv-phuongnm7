# NM7 Sports Auto Playlist — Tiến độ đến 20/09/2026

## Trạng thái
- Hệ thống playlist thể thao tự động đang chạy trên repo `dungntk9/Iptv-phuongnm7`.
- Link playlist giữ nguyên: `https://raw.githubusercontent.com/dungntk9/Iptv-phuongnm7/main/sports-auto.m3u`.
- Workflow: `.github/workflows/update-sports-auto.yml`.
- Chu kỳ cập nhật: 10 phút/lần.
- Kiến trúc hiện tại: nguồn A → B → C → D → LAST_GOOD.

## Các nguồn
- A: `https://thcoban.github.io/thtt/tttt.m3u`
- B: `https://tinyurl.com/ttthethao2`
- C: `sources/golden-tv-selected.m3u`
- D: `sources/sport-selected.m3u`
- LAST_GOOD: bản `sports-auto.m3u` trước đó nếu các nguồn không có dữ liệu usable.

## Các lỗi đã phát hiện và xử lý
### 1. Phụ thuộc một nguồn
Ban đầu playlist chỉ lấy trực tiếp từ `tttt.m3u`. Đã chuyển sang mô hình multi-source để giảm phụ thuộc một upstream.

### 2. Health-check làm mất trận
Logic cũ loại cả trận nếu URL stream không phản hồi qua probe. Đã sửa: health-check chỉ dùng để ưu tiên URL tốt hơn; không dùng nó để xóa trận khỏi danh sách.

Commit sửa: `69d4418a5db9fd01da709c297da7ea881746467e`.

### 3. Gộp match_key làm mất nhiều biến thể
Logic tiếp theo vẫn chỉ publish một entry cho mỗi trận, khiến các trận có nhiều BLV/stream variant bị giảm số lượng.

Đã sửa lại: với nguồn ưu tiên cao nhất của từng trận, giữ toàn bộ các variant/entry của nguồn đó thay vì chỉ giữ một entry.

Commit mới nhất: `b8b6c9fef0ce90ffe7d119464bf8238d5a3b3a0`.

## Kiểm tra hiện tại
- Người dùng đã xác nhận playlist hiện tại nhìn thấy **đủ hơn rõ rệt** so với trước.
- Một lần kiểm tra trước khi sửa cuối cho thấy playlist chỉ còn 167 entry, trong đó Gà Vàng 33 TV chỉ có 3 entry; đây được xác định là kết quả của logic gộp/lọc quá mạnh.
- Sau bản sửa cuối, cần tiếp tục đối chiếu từng nhóm với nguồn gốc, đặc biệt Gà Vàng 33 TV, để bảo đảm không còn thiếu trận.

## Nguyên tắc xử lý hiện tại
1. Ưu tiên dữ liệu mới từ nguồn A.
2. Bổ sung từ B nếu A không có trận tương ứng.
3. Dùng C/D làm fallback.
4. Không loại trận chỉ vì health probe thất bại.
5. Không gộp các BLV/stream variant thành một entry duy nhất.
6. Nếu không có nguồn live usable, giữ bản LAST_GOOD thay vì ghi đè playlist rỗng.
7. Không thay đổi URL playlist mà app NM7 đang sử dụng.

## Việc cần kiểm tra tiếp
- Đối chiếu số trận từng group giữa nguồn gốc và `sports-auto.m3u`.
- Kiểm tra riêng Gà Vàng 33 TV, Vua Sân Cỏ TV, Khán Đài TV và các group có nhiều BLV.
- Xác nhận workflow định kỳ vẫn cập nhật đúng sau các lần chạy tiếp theo.


## Watchdog dự phòng — 25/09/2026

Đã bổ sung mã nguồn Cloudflare Worker tại `tools/cloudflare-sports-watchdog/`.

- Cron watchdog: mỗi 5 phút.
- Ngưỡng coi workflow bị bỏ/trễ: 8 phút.
- Nếu có run gần đây hoặc run đang queued/in_progress: không dispatch trùng.
- Nếu run mới nhất đã quá 8 phút: gọi `workflow_dispatch` cho `.github/workflows/update-sports-auto.yml` trên `main`.
- Không thay đổi logic playlist hiện tại, đặc biệt quy tắc loại các trận đã có thời gian và cũ hơn 180 phút.
- Worker yêu cầu Secret Cloudflare `GITHUB_TOKEN`, với GitHub fine-grained permission **Actions: Read and write** cho riêng repository.

### Trạng thái triển khai

Mã nguồn đã được chuẩn bị và commit vào repo. Phần duy nhất cần thao tác trên tài khoản Cloudflare là tạo Worker từ thư mục trên và thêm Secret `GITHUB_TOKEN`; ChatGPT không có quyền truy cập tài khoản Cloudflare của người dùng để tự nhập Secret.
