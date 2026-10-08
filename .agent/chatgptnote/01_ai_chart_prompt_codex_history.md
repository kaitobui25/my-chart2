# AI Chart Assistant: prompt và lịch sử Codex

Ghi nhận: 2026-10-08. Đây là hiện trạng code tại thời điểm kiểm tra; cần đối chiếu lại nếu code thay đổi.

## Prompt được gửi mỗi lần chat

- Giao diện chat L2Chart: `examples/workstation/assistant/index.ts` (`submitMessage`). Mỗi lần gửi có câu hỏi, chart context, model, reasoning và tối đa 10 tin nhắn gần nhất.
- Backend: `examples/sidecars/assistant/server.mjs` (`handleChat`) gọi `buildPrompt()` **ở mỗi request `/chat`**.
- Prompt nằm tại `examples/sidecars/assistant/prompt-builder.mjs`. Nội dung gồm vai trò trợ lý L2Chart, 10 quy tắc cố định, tóm tắt các khung thời gian, câu hỏi và chart context dạng JSON. Đây là **phần văn bản của prompt**, không phải một `system` role riêng trong API.
- Các quy tắc nổi bật: dùng dữ liệu chart được cung cấp, không đoán số liệu thiếu, trả lời ngắn theo ngôn ngữ người dùng, không tự đưa kế hoạch giao dịch.
- Với **Codex**, tối đa 10 tin nhắn cũ được nhúng thêm vào prompt (`Recent conversation JSON`). Với **ChatGPT Bridge**, lịch sử nằm trong thread ChatGPT nên không nhúng mục này.

## Lịch sử chat được lưu ở đâu?

| Thành phần | Vị trí/cách lưu |
| --- | --- |
| Lịch sử trong giao diện L2Chart | Biến `conversation` trong RAM trình duyệt, giữ tối đa 10 tin nhắn; tải lại trang sẽ mất khỏi giao diện. |
| Model và reasoning đã chọn | `localStorage` (`l2chart.assistant.settings.v1`); không chứa lịch sử chat. |
| Mã phiên của browser client | `sessionStorage` (`l2chart.assistant.clientSessionId.v1`); không chứa nội dung chat. |
| Log phiên Codex CLI trên PC | `C:\Users\nothi\.codex\sessions\YYYY\MM\DD\rollout-....jsonl` (nếu không đổi `CODEX_HOME`). |
| Lịch sử CLI bổ sung | `C:\Users\nothi\.codex\history.jsonl`; không phải kho chat riêng của L2Chart. |
| Thư mục chạy trợ lý | `C:\Users\nothi\.l2chart-assistant` (mặc định; có thể đổi qua `L2CHART_ASSISTANT_RUNTIME_ROOT`). Không phải nơi ứng dụng lưu transcript để mở lại. |

- Đường dẫn trong bảng đã được kiểm tra trực tiếp trên máy Windows ngày 2026-10-08. Lúc kiểm tra có **366 file** phiên Codex `.jsonl`, và tìm thấy **ít nhất 5 file** chứa câu mở đầu prompt L2Chart (`You are a chart assistant embedded in L2Chart.`). Các con số có thể thay đổi.
- Code tại `examples/sidecars/assistant/codex-provider.mjs` gọi `codex exec` **riêng cho mỗi tin nhắn**; thư mục tạm `l2chart-codex-*` và file kết quả `response.json` được xóa sau khi chạy. Vì vậy một cuộc chat trong UI có thể tạo nhiều file rollout Codex.
- **Hiện chưa có chức năng lưu và khôi phục transcript lâu dài trong UI**. File rollout của Codex vẫn có thể tồn tại trên đĩa dù giao diện đã mất lịch sử.

## File nguồn nên xem khi cần xác minh lại

- `examples/workstation/assistant/index.ts`: quản lý lịch sử hội thoại trong UI.
- `examples/excel-content-addin/assistant-controller.ts`: giao diện assistant trong Excel cũng giữ lịch sử trong biến `conversation`.
- `examples/assistant/client.ts`: gửi `/chat` và lưu client session ID.
- `examples/sidecars/assistant/server.mjs`: tạo prompt và định tuyến sang Codex/ChatGPT.
- `examples/sidecars/assistant/prompt-builder.mjs`: prompt mặc định và giới hạn lịch sử.
- `examples/sidecars/assistant/codex-provider.mjs`, `config.mjs`: cách chạy Codex và thư mục runtime.
