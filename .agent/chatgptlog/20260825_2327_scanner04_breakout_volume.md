# Chat log — Scanner 04 Breakout + Volume

Date: 2026-08-25
Repo: kaitobui25/my-chart2
Branch: main

## Mục tiêu

Build Scanner 04 cho HOSE theo OHLCV tuần, dùng breakout giá + volume, chỉ dùng tuần đã đóng.

Plan đã ghi tại:
- `agent/plan/09_SCANNER_BREAKOUT_VOLUME_V1.md`

## Data flow

- Nến gốc: daily OHLCV.
- VN EOD dùng CafeF adjusted data lưu local SQLite.
- Weekly/Monthly tự aggregate từ daily, không tải nến tuần/tháng riêng.
- Scanner 04 chạy local trên `vn_eod`, universe cố định HOSE.

## Rule Scanner 04

W0 = tuần đã đóng gần nhất.
Baseline = W-8..W-1.

Thanh khoản chạy trước:
- `median(traded_value W-8..W-1) >= 5 tỷ VNĐ` mặc định.
- `median(volume W-8..W-1) >= 500,000 cp` mặc định.

Weekly traded value:
- `Σ(close_day × volume_day)`.

Breakout:
- `close(W0) > max(close W-8..W-1)`.

Momentum:
- `(close(W0) / close(W-1) - 1) × 100 >= 4%`.

RVOL:
- `RVOL(W0) = volume(W0) / median(volume W-8..W-1)`.
- Pass khi `RVOL >= 1.5x`.
- `RVOL >= 2.5x` => STRONG.

W+1 follow-up:
- Chỉ đánh giá sau khi W+1 đã đóng.
- `RVOL(W+1) = volume(W+1) / median_volume_8W_cũ`.
- `close(W+1) >= breakout_level` => giữ breakout.
- `< breakout_level` => failed.
- Signal state: `NEW` hoặc `FOLLOW_UP`.

Code chính:
- `examples/sidecars/scanner/breakout_volume.py`
- `examples/sidecars/scanner/engine.py`
- `examples/sidecars/scanner/models.py`
- `examples/sidecars/scanner/tests/test_engine.py`
- `examples/workstation/scanner/index.ts`
- `examples/workstation/scanner/types.ts`

## UI đã làm

Scanner filter sections 01/02/03/04 là dropdown accordion.

Nút Quét thị trường:
- Khi chạy có viền sáng chạy quanh nút.
- Có progress fill trái -> phải theo `progressPct` thật.
- Text hiển thị `Đang quét… xx%`.

Scanner 03 Heikin Ashi:
- Có toggle ON/OFF riêng giống Scanner 04.
- Toggle 03 và 04 độc lập, không tự bật/tắt nhau.
- 03 OFF thì control HA bị disable/mờ.

Scanner 04:
- Toggle riêng.
- Bật 04 thì source khóa `VN EOD (CafeF)` và universe HOSE.
- Chỉ closed week.

## Bug/fix trong chat

1. Result count có số nhưng table rỗng
- Nguyên nhân: frontend mới lọc theo `mode`, sidecar cũ không có field này.
- Fix normalization legacy result.
- Commit liên quan:
  - `a6b1ead fix(scanner): render legacy HA scan rows`
  - `313502c fix(scanner): type legacy result normalization`

2. Toggle 03 ban đầu auto-off 04
- User yêu cầu 03/04 độc lập.
- Đã bỏ coupling.
- Commit:
  - `d190ba6 fix(scanner): decouple Heikin and breakout toggles`

3. 03 OFF nhưng vẫn thấy bảng HA
- Nguyên nhân thực tế: frontend mới nhưng Python scanner sidecar đang chạy process cũ trong RAM, trả row HA trong khi UI đang ở Scanner 04.
- Đã thêm guard để không render nhầm mode stale; nếu 04 ON mà sidecar trả HA thì báo lỗi/restart thay vì render HA.
- Commit:
  - `d66d9dc fix(scanner): reject stale result mode`

## Commit chính của Scanner 04/UI

- `7f519c4` — Scanner 04 implementation + tests (head tại thời điểm build feature).
- `95cf4ca` — animate live scan button progress.
- `336f500` — install scan button progress.
- `fb47ab0` / `3dd9e16` / `9e88cd7` — Heikin toggle iterations.
- `d190ba6` — decouple 03/04 toggles.
- `d66d9dc` — reject stale result mode.

## Trạng thái cuối chat

- Code đang sửa trực tiếp trên `main`.
- Scanner 04 logic/test sidecar đã pass ở CI trước đó; typecheck cũng pass sau các fix UI gần nhất.
- Có một số CI docs/browser lỗi nền không liên quan scanner feature.
- Sau khi `git pull`, cần restart workstation/sidecar để Python process nạp code mới; chỉ reload browser không đủ nếu sidecar cũ vẫn chạy.

## Lệnh phía máy local

```powershell
git pull --ff-only origin main
```

Sau đó Ctrl+C process workstation hiện tại và chạy lại app.
