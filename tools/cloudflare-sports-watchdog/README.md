# NM7 Sports Watchdog

Cloudflare Worker theo dõi GitHub Actions tạo playlist thể thao.

## Vai trò và lịch

- GitHub Actions `.github/workflows/update-sports-auto.yml` tạo playlist và vẫn giữ lịch mỗi 5 phút.
- `nm7-sports-watchdog` giữ Cron `*/5 * * * *`.
- Watchdog đọc danh sách workflow runs công khai qua GitHub REST API và ghi log trạng thái. Nó chỉ monitor, không dispatch workflow.
- Không cần secret `GITHUB_TOKEN`; không gọi API bằng tài khoản GitHub `phuongnm7`.

## Triển khai và kiểm tra

Workflow `.github/workflows/deploy-fpt-event-watchdog.yml` triển khai Worker, xóa secret `GITHUB_TOKEN` cũ nếu còn tồn tại, xác minh secret đã bị loại bỏ và kiểm tra Cron vẫn giữ nguyên `*/5 * * * *`.

Endpoint `/health` phải trả về:
```json
{
  "ok": true,
  "service": "nm7-sports-watchdog",
  "schedule": "*/5 * * * *",
  "stale_after_minutes": 8,
  "githubTokenRequired": false
}
```

Watchdog không thay thế GitHub Actions; nó cung cấp thêm quan sát trạng thái. Tác vụ cập nhật playlist vẫn do lịch GitHub Actions đảm nhiệm.
