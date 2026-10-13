# Kế hoạch triển khai Replay cho Excel content add-in

**Trạng thái:** Đã triển khai MVP trong Excel content add-in. Xem phần kết quả kiểm thử cuối tài liệu.
**Phạm vi:** `examples/excel-content-addin/` — chart nhúng trong Excel, hỗ trợ **Market (Yahoo Japan)** và **Sheet (vùng OHLC(V) đã chọn)**.

## 1. Mục tiêu và phạm vi phiên bản đầu

Người dùng bấm **Replay**, chọn một nến trên biểu đồ, sau đó phát/tạm dừng, tiến từng nến, đổi tốc độ **1x / 2x / 5x / 10x** và thoát để khôi phục biểu đồ. Tại mọi thời điểm, chart, indicator, Export và AI chỉ được nhìn thấy các nến đã mở khóa.

- Replay **một chart** từ dữ liệu đã tải sẵn trong add-in. Với Market, dùng snapshot lịch sử trên chart; với Sheet, dùng snapshot vùng dữ liệu đã nạp. Không gọi mạng hoặc đọc lại worksheet ở từng bước.
- Giữ khoảng trống lịch sử trước điểm chọn để indicator/Heikin Ashi có dữ liệu khởi động. Bước tiếp theo chỉ mở khóa thêm **một nến**.
- Không ghi dữ liệu vào Excel, không tạo workbook mới, không lưu phiên Replay sau khi đóng add-in.
- Chưa hỗ trợ đa chart/đa timeframe, kéo thanh seek ngược thời gian, phát sinh nến intrabar hoặc backtesting lệnh.
- Với Yahoo Japan, Replay chỉ sử dụng phạm vi lịch sử thực sự có trong chart (hiện tối đa 5.000 nến theo cấu hình). Không giả định nhà cung cấp có thể trả mọi khoảng thời gian.

## 2. Cơ sở trong repository

| Thành phần hiện có | Vai trò khi triển khai |
| --- | --- |
| `examples/shared/replay/replay-clock.ts` | Clock đã được chuyển từ workstation sang module chung cho Excel/Workstation. |
| `examples/workstation/replay/replay-session.ts` | Tham khảo lifecycle, tránh race và nguồn dữ liệu tương lai; **không bê nguyên** vì phụ thuộc multi-chart, Datafeed và MarketHub. |
| `src/core/chart.ts` | Đã có `onBarClick()`, `setReplaySelectionMode()`, `setData()`, `updateCandle()` và `getCandles()`. |
| `examples/excel-content-addin/main.ts` | Composition root hiện đang quản lý market/sheet, indicator, assistant và các nút. Chỉ bổ sung wiring. |
| `examples/excel-content-addin/japan-market-controller.ts` | `pause()` ngừng subscription và vô hiệu hóa kết quả tải cũ; `load()` tải và khôi phục live subscription. |
| `examples/excel-content-addin/ohlc-range.ts` | Parse, sort và loại nến trùng timestamp trước khi đưa vào chart. |
| `examples/excel-content-addin/indicator-controller.ts` | **Hiện recompute mọi indicator ở mỗi sự kiện `data`**: chi phí thực tế cần benchmark. |
| `examples/excel-content-addin/assistant-context.ts` | Hiện gắn `replay.phase = idle` cố định và cho AI lấy thêm market feed; cần đổi để không rò dữ liệu tương lai. |

## 3. Thiết kế đề xuất

```text
Market chart / Excel Sheet
         │ snapshot Candle[] (copy đúng một lần khi bắt đầu)
         ▼
   ExcelReplayController  ────────>  ReplayClock (shared)
         │                            │ cursor/time
         │                            ▼
         ├── chọn nến: chart.onBarClick(index)
         ├── khởi tạo: chart.setData(source[0..index])
         ├── mỗi bước: chart.updateCandle(source[index + 1])
         ├── snapshot: phase / cursor / total / time / source
         └── thoát: phục hồi chart + live market (nếu có)
                    │
                    ├── ReplayControls (DOM, CSS)
                    └── Assistant context / Export / Indicators
                         đọc duy nhất chart đã cắt theo cursor
```

### Phân tách trách nhiệm

1. **Clock dùng chung**: `replay-clock.ts` đã chuyển sang `examples/shared/replay/replay-clock.ts`, cập nhật import ở workstation và unit tests. Không tạo bản sao thứ hai.
2. **`excel-replay-controller.ts`**: nắm state phiên (`idle` → `selecting` → `paused` ↔ `playing`), dữ liệu nguồn bất biến theo phiên, cursor và lifecycle. `finished` là trạng thái suy ra từ `cursor === total - 1`, không cần phase mới. Controller không truy cập DOM trực tiếp.
3. **`excel-replay-controls.ts`**: bind nút Play/Pause, Step, Speed, Stop, cập nhật trạng thái và disable phù hợp. Quản lý cleanup event listeners. Chỉ gọi API controller.
4. **`main.ts`**: ghép các dependency, xử lý chuyển nguồn/symbol/timeframe, đồng bộ assistant, register/dispose. Không đặt timer, slicing hay logic state machine ở đây.
5. **`japan-market-controller.ts`**: chỉ bổ sung API nếu cần để resume live an toàn sau `pause()`; tận dụng `load()` hiện tại trước khi thêm abstraction.
6. **`assistant-context.ts`**: nhận `getReplaySnapshot()` và xử lý context theo thời điểm Replay. Khi Replay đang active, chặn đường tải lịch sử phụ qua `getDatafeed()` trong MVP; chỉ dùng nến đã hé lộ trên chart.

### Quy tắc dữ liệu và lifecycle

- **Bắt đầu chọn:** yêu cầu có ít nhất 2 nến, snapshot dữ liệu gốc một lần; với Market, tạm dừng live subscription để người dùng chọn nến trên dữ liệu ổn định. Giới hạn Replay cấu hình được (đề xuất ban đầu `MAX_REPLAY_BARS = 20_000`), báo lỗi rõ nếu vượt ngưỡng, không cắt âm thầm.
- **Chọn điểm bắt đầu:** lấy `index` từ `onBarClick`, chỉ chấp nhận `0 <= index < total - 1`. Render prefix đến và bao gồm nến chọn, cursor bắt đầu tại index; timeline theo timestamp nến gốc, không nội suy nến vào khoảng trống ngày nghỉ.
- **Phát/Step:** cập nhật chỉ nến tiếp theo bằng `updateCandle`, tránh `setData` toàn bộ ở mỗi tick. Đồng hồ dừng và chuyển `paused` tại nến cuối. Nguồn `sourceCandles` không bị chart mutate.
- **Thoát/hủy chọn:** dừng timer, hủy selection mode, khôi phục toàn bộ snapshot. Nếu là Market, phục hồi subscription bằng cơ chế hiện có; nếu reload thất bại, giữ chart snapshot và hiển thị lỗi rõ. Nếu là Sheet, giữ đúng dữ liệu vùng chọn ban đầu, không đọc lại Sheet.
- **Đổi mã/timeframe hoặc bấm Sheet:** dừng/huỷ Replay trước khi bắt đầu yêu cầu mới; dùng generation/token để kết quả async cũ không ghi đè chart hay khôi phục nhầm nguồn.
- **Market candle chưa đóng:** xác định và loại nến hiện hành chưa hoàn tất khỏi phạm vi Replay khi có thể kiểm chứng theo timeframe/calendar; với Sheet, xem mỗi hàng OHLC hợp lệ là một nến do người dùng cung cấp.
- **AI/Export/indicator:** context ghi đúng phase, cursor và thời gian Replay. Không expose đầy đủ snapshot cho assistant/Export. Indicator phải tính trên prefix, không được sử dụng nến tương lai hoặc provider extra-timeframe trong Replay.

## 4. Giao diện tối thiểu

- Thêm nút **Replay** trong `index.html` tại chart toolbar; khi kích hoạt, bật crosshair mode và thông báo “Chọn nến bắt đầu”. `Esc` hủy chọn.
- Khi đã chọn, hiển thị dải điều khiển nhỏ với **Play/Pause**, **Step**, **Speed 1x–10x**, **Stop**, và `nến hiện tại / tổng nến · thời gian`.
- Đặt dải điều khiển phù hợp Excel WebView có chiều ngang hẹp; kiểm tra breakpoint **480 px** hiện dùng cho toolbar. Tránh che symbol, timeframe, nút Sheet/AI và chart.
- Nút Step/Play vô hiệu ở cuối dữ liệu; nút Stop luôn có sẵn khi active. Trạng thái và các nút hỗ trợ keyboard focus, title/aria-label. Chỉ bổ sung shortcut nếu không xung đột Excel, trình đọc bảng và AI input.

## 5. Lộ trình triển khai

| Giai đoạn | Công việc | Kết quả kiểm chứng |
| --- | --- | --- |
| **P1 — Replay engine** | Chuyển clock thành shared module, viết controller với snapshot/index/state/timer, các nhánh cancel/restore. | Unit test ở nguồn Sheet và Market bằng chart/market fake; không lộ nến tương lai; start/step/stop chính xác. |
| **P2 — Tích hợp dữ liệu** | Kết nối `main.ts` và market pause/resume; chặn kết quả async cũ khi đổi source/symbol/timeframe; bảo đảm Sheet restoration. | Chuyển Market ↔ Sheet giữa Replay và khi dữ liệu đang tải không gây update sai chart. |
| **P3 — UI + context** | Toolbar điều khiển, responsive CSS, click-to-select, state/status, AI context và Export. | Bấm chọn/phát/dừng ổn định trong Excel và browser preview; AI/Export phản ánh chỉ prefix. |
| **P4 — Kiểm thử hiệu năng** | Unit/integration/browser smoke test; profile trên dataset 2k/5k nến với indicator bật, thử 10x, dọn event listener/timer. | Không tạo request mỗi tick, không tăng timer/listener qua nhiều phiên, không giật nặng khi chạy trong WebView. |

## 6. Test bắt buộc và điều kiện hoàn thành

- **Tính đúng:** start tại index `i` có đúng `i+1` nến, mỗi Step thêm đúng một nến, giữ timestamp/volume, xử lý khoảng trống ngày nghỉ và hết dữ liệu.
- **Không nhìn trước:** high/low/close, chỉ báo, AI, Export đều dựa trên prefix tại cursor; thử thêm nến “tương lai” biến động cực đoan để phát hiện rò dữ liệu.
- **Lifecycle:** Play → Pause → Play → Stop; hủy trước khi chọn; đổi symbol/timeframe; chuyển Market ↔ Sheet; stop khi request đang tải; exit/unload không còn timer/subscription cũ.
- **Khôi phục:** Sheet khôi phục snapshot đúng; Market khôi phục chart và live feed; reload lỗi không làm mất biểu đồ hiện tại.
- **Hiệu năng:** mỗi tick không parse Excel, không fetch provider, không `setData(fullData)`; chart update incremental. Đo profile indicator recomputation và thời gian frame ở 1x/10x trước khi đặt ngưỡng tối ưu. Nếu benchmark cho thấy nghẽn, tối ưu incremental/batching có kiểm thử riêng, không refactor chart core trước khi có số liệu.
- **Chạy kiểm tra:** `npm run typecheck`, unit tests cho clock/controller/integration, `npm run build:excel`, browser smoke test và kiểm tra trực tiếp trong Excel desktop nếu có Office host.

## 7. Quy tắc giữ code dễ bảo trì

- Không thêm dependency, backend hay bộ lưu trữ phiên cho MVP. Mỗi module chỉ giữ một trách nhiệm; controller dùng interface nhỏ cho chart, live market và thông báo state để unit test không cần DOM/Office.
- Tránh hai nguồn sự thật: giữ **duy nhất** snapshot nến gốc trong controller; chart là phần đã mở khóa; clock là nguồn cursor/tốc độ/phase chạy.
- Dùng state transition rõ ràng, `dispose()` idempotent và cancellation token cho thao tác async. Không dùng `setInterval` ngoài `ReplayClock`.
- Đo hiện trạng trước khi tối ưu: `IndicatorController` đang recompute tất cả indicator mỗi lần `data` thay đổi nên `updateCandle` không đồng nghĩa toàn pipeline O(1).

## 8. Quyết định còn có thể mở rộng sau MVP

- Thanh timeline/seek lùi, replay liên tiếp nhiều mã, snapshot/khôi phục phiên.
- MTF Replay theo projection của workstation, chỉ khi Excel cần đa chart/timeframe.
- Backtest và điều khiển lệnh; cần policy riêng cho live quote/market source, không nằm trong Replay hiển thị lần đầu.

**Definition of Done:** Cùng một UI có thể Replay Market và Sheet, khôi phục an toàn, không rò dữ liệu tương lai, unit + build pass; kiểm tra responsive trong browser preview. Kiểm tra riêng trên Office Excel desktop vẫn nên chạy khi mở workbook thực tế.

## 9. Kết quả triển khai

- Engine: `examples/excel-content-addin/excel-replay-controller.ts`; controls: `excel-replay-controls.ts`.
- UI: `index.html` + `style.css`; data/async wiring: `main.ts` + `japan-market-controller.ts`.
- Context: `assistant-context.ts` trả về phase/cursor/time thực tế và từ chối truy cập feed khác khi Replay đang hoạt động.
- Unit regression: `tests/unit/excel-replay.test.ts`, `tests/unit/excel-content-addin.test.ts`, clock/workstation replay tests.
- Hiệu năng: thao tác theo nến sử dụng `updateCandle()`; không phát sinh yêu cầu dữ liệu mỗi tick. Headless Chromium với 2.000 nến ngày và EMA bật: 10 bước Replay ở 10× có trung vị khoảng cách ~100,5 ms, không có request lịch sử mới; Stop khôi phục đủ 2.000 nến. Đây là smoke/benchmark trong browser preview, chưa phải đo trên Excel WebView2 hoặc với SMC nặng. Indicator hiện vẫn recompute toàn bộ theo event `data`; chỉ tối ưu thuật toán khi có profile cho tình huống thực tế.
- Xác nhận: `npm run typecheck`, `npm run build:excel`, `npm run build:demo`, `npm run test:excel-replay`, 55 unit tests liên quan và 2 browser tests Workstation đều pass. Full unit suite hiện có 2 assertion thất bại trong `provider-lazy-runtime.test.ts` liên quan chuỗi nguồn Workstation đã không tồn tại ở HEAD, ngoài phạm vi Replay Excel.
