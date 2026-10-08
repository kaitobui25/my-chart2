# Chat log — AI Chart: nến đa khung và dữ liệu indicator

Ngày: 2026-10-08  
Project: `/lamlongchart`  
Branch: `main`

## Mục tiêu phiên

Tìm hiểu AI Chart trong Workstation và Excel Add-in, sau đó triển khai giai đoạn 1 và 2:

1. Cho AI truy xuất nến đa khung thời gian theo yêu cầu.
2. Cho AI truy xuất công thức/phương pháp và kết quả tính toán của indicator.
3. Cho Codex/ChatGPT Bridge yêu cầu dữ liệu, nhận kết quả rồi tiếp tục trả lời trong cùng lượt chat.

Ưu tiên module hóa, tái sử dụng Datafeed và công thức sẵn có, truy vấn read-only, không cung cấp quyền tùy ý đọc file hoặc gọi URL.

## Hiện trạng ban đầu

- `examples/sidecars/assistant/prompt-builder.mjs` tạo prompt cho mỗi request `/chat`: vai trò trợ lý L2Chart, quy tắc, câu hỏi, chart context và (với Codex) lịch sử gần nhất.
- Giao diện giữ tối đa 10 tin nhắn gần nhất trong RAM; không có cơ chế khôi phục transcript sau khi reload.
- Codex CLI ghi các phiên dưới `C:\Users\nothi\.codex\sessions\...` và có `history.jsonl`; không phải kho transcript riêng của Excel Add-in.
- Trước thay đổi, L2Chart đã lấy các timeframe được nêu rõ trong câu hỏi, nhưng AI chưa có vòng lặp chủ động gọi công cụ. Context indicator chỉ gồm ID/params, chưa có kết quả số.
- Phần khảo sát prompt/lưu trữ trước đây có ghi chú trong `.agent/chatgptnote/01_ai_chart_prompt_codex_history.md`.

## Đã triển khai

- `examples/assistant/candle-query.ts`: truy xuất OHLCV đa khung bằng Datafeed, lọc theo mốc chart/replay, giới hạn số nến và fallback khi provider không hỗ trợ range query.
- `examples/assistant/indicator-query.ts`: truy xuất kết quả candle-aligned `{time, value}`, tham số hiệu lực và mô tả công thức. Hỗ trợ SMA, EMA, RSI, MACD, Bollinger và các indicator TA Suite có `calculate`; các indicator khác trả lỗi rõ ràng.
- `src/indicators/registry.ts`, các định nghĩa indicator liên quan: bổ sung tùy chọn `calculate`/`formula`, dùng lại công thức tính hiện có (không tạo công thức AI riêng).
- `examples/assistant/context.ts`: bridge phục vụ `get_candles` và `get_indicator`, kiểm tra symbol/timeframe, giới hạn dữ liệu, neo thời gian; indicator khung hiện tại tính trên lịch sử nguồn để giữ kết quả nhất quán.
- `examples/assistant/chat-runner.ts`: vòng AI hỏi thêm dữ liệu → ứng dụng lấy dữ liệu → gửi lại AI → trả lời; tối đa 2 yêu cầu mỗi vòng, 3 vòng dữ liệu, tái sử dụng truy vấn trùng trong cùng lượt.
- `examples/sidecars/assistant/{prompt-builder,response-schema,server}.mjs`: hướng dẫn tool protocol, parse kết quả và kết nối Codex/ChatGPT Bridge, thêm kiểm tra cơ bản đối với request trực tiếp.
- `examples/workstation/assistant/index.ts` và `examples/excel-content-addin/assistant-controller.ts`: dùng cùng chat runner.

## Kiểm thử

- `npm run typecheck`: đạt.
- `npm run build:excel`, `npm run build:demo`: đạt.
- Vitest tập trung (assistant context, data tools, indicator query, Excel Add-in): **42/42 đạt**.
- Node tests sidecar: **20/20 đạt**.
- Chạy toàn bộ unit suite: **331/333 đạt**; 2 test cũ `provider-lazy-runtime.test.ts` lỗi ở assertion kiểm tra chuỗi mã nguồn scanner, chưa thấy liên quan đến thay đổi AI Chat.
- Test thực tế trong **giao diện web của Excel Add-in** tại `https://localhost:3000/index.html`, provider Codex, model `gpt-5.6-sol`:
  - Yêu cầu RSI(14) 1D: AI gọi công cụ và trả lời.
  - Yêu cầu 5 nến 1W: AI gọi công cụ, trả close tuần.
  - Yêu cầu kết hợp RSI(14) 1D + nến 1W trong một câu: AI trả **RSI = 42,27**, **close tuần = 2.900,5** cho mã 7203.T tại thời điểm test.
  - Kiểm tra rollout Codex xác nhận lượt gọi tiếp theo có `Results of prior chart data requests`.
- Lần test dùng Codex mặc định ban đầu thất bại do `gpt-6.1-sol` không được tài khoản Codex hỗ trợ; chuyển sang `gpt-5.6-sol` thì chạy được.
- **Chưa xác minh bằng thao tác tự động trực tiếp trong cửa sổ Excel desktop**: công cụ UI Automation chỉ nhìn thấy `WebView2Holder`, không đọc được nút chat trong WebView2. Người dùng sẽ tự nhập câu hỏi để xác nhận tại Excel desktop. Không đánh đồng việc test trên browser với test bên trong Excel desktop.

## Git và tài liệu

- Đã commit phần code trong `main`:
  - `d83f194 feat(assistant): add chart candle and indicator data queries`
- Đã cập nhật `README.md` với mục **AI Chart chat (Workstation and Excel Add-in)**: tool mới, phạm vi indicator/timeframe, giới hạn, ví dụ prompt, module tham khảo.
- **Lúc ghi log, thay đổi `README.md` chưa được commit** (đã kiểm tra `git diff --check` đạt).

## 5 câu hỏi để người dùng tự test trong Excel desktop

1. Gọi `get_indicator` lấy RSI(14) 5 nến cuối khung hiện tại; báo giá trị mới nhất và công thức.
2. Gọi `get_indicator` lấy EMA(20) 5 nến cuối; so sánh giá đóng cửa mới nhất với EMA.
3. Gọi `get_candles` lấy 5 nến gần nhất ở 1W; liệt kê ngày, OHLC.
4. Lấy RSI(14) ở 1D và 5 nến 1W; báo RSI cuối và close tuần cuối, không đoán.
5. Gọi `get_indicator` lấy MACD(12,26,9) 1W; báo MACD, Signal và Histogram cùng phương pháp tính.

## Giới hạn / việc tiếp theo

- Chờ kết quả người dùng test trong Excel desktop; đối chiếu số và lỗi nếu có.
- Indicator SMC và indicator lấy dữ liệu ngoài chưa có adapter xuất kết quả cho AI.
- Hủy query Datafeed đang chạy chưa có AbortSignal xuyên suốt; giao thức hiện giới hạn số vòng và truy vấn nhưng chưa có cache xuyên nhiều lượt chat.
- Không tự nhận giai đoạn test Excel desktop đã hoàn thành khi chưa có xác nhận thực tế.
