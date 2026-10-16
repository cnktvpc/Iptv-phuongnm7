# NM7 FPT Event Watchdog

Watchdog chạy trên Cloudflare và giám sát trạng thái của GitHub Actions scanner NM7 FPT Event Live.

## Vai trò và lịch

- GitHub Actions `.github/workflows/fpt-event-scan.yml` là bộ cập nhật playlist chính, chạy mỗi 5 phút.
- `nm7-fpt-event-live` là delivery Worker, không có Cron Trigger.
- `nm7-fpt-event-watchdog` vẫn chạy Cron `*/5 * * * *` và kiểm tra run gần nhất cùng file `generated/fpt-event-live.status.json`.
- Watchdog chỉ giám sát và ghi log. Nó không dispatch workflow, không cần Personal Access Token và không phụ thuộc tài khoản GitHub `phuongnm7`.

## Endpoint

- `/health`: trả trạng thái Worker, cron và `githubTokenRequired=false`.
- `POST /run`: chạy một vòng kiểm tra và trả diagnostics.

## Triển khai

Workflow `.github/workflows/deploy-fpt-event-watchdog.yml` triển khai watchdog, xóa secret `GITHUB_TOKEN` cũ nếu còn tồn tại, rồi xác minh secret đã bị loại bỏ và Cron vẫn là `*/5 * * * *`.

Cloudflare vẫn dùng tên miền workers.dev hiện có để không làm hỏng URL đang phục vụ. Việc dùng hostname Cloudflare cũ không khiến watchdog gọi API bằng tài khoản GitHub cũ.

## Kiểm tra

Workflow xác minh:
- JavaScript syntax;
- `/health` trả `githubTokenRequired=false`;
- `POST /run` trả `action=monitor` cùng dữ liệu scan source-only;
- Cron Cloudflare vẫn chạy mỗi 5 phút.

