Super DarvasBox

Chỉ báo Darvas Box Pine Script v6 tự động xác định vùng tích lũy, xác nhận breakout bằng khối lượng, hỗ trợ Higher Timeframe và Dashboard đa tài sản.
free
TRADINGVIEW//INDICATOR//INDICATORPRICE ACTION
☆☆☆☆☆0.0(0 ratings)
OPEN
TỔNG QUAN KỸ THUẬT

Chỉ báo Hộp Darvas (Darvas Box) {DucTri_dev} là công cụ phân tích kỹ thuật hiện đại trên nền tảng TradingView (Pine Script v6), được phát triển dựa trên lý thuyết hộp kinh điển của Nicolas Darvas. Chỉ báo giúp nhà giao dịch tự động xác định các vùng tích lũy (nén giá), phát hiện thời điểm bứt phá (Breakout/Breakdown), lọc tín hiệu giả bằng khối lượng (Volume Filter), đồng thời hỗ trợ Khung thời gian cao hơn (HTF) và Bảng Dashboard giám sát đa tài sản.
📌 Các Tính Năng Cốt Lõi
1. 📦 Tự Động Xác Định & Vẽ Hộp Darvas

    Thuật toán Pivot High/Low: Tự động dò tìm đỉnh và đáy swing dựa trên tham số nến biên trái/phải (pivotSize).
    Cơ chế bảo vệ hộp (checkBreakBeforeCreate): Đảm bảo trong suốt quá trình hình thành giữa đỉnh và đáy, giá không bị phá thủng biên trước khi hộp chính thức được xác nhận.
    Trực quan hóa:
        Khi giá dao động bên trong biên độ, hộp tự động mở rộng sang phải (extend.right).
        Khi có nến đóng cửa vượt ra ngoài hộp, hộp sẽ chốt lại và đổi màu tương ứng với hướng bứt phá.

2. 📊 Bộ Lọc Khối Lượng Chuẩn Xác (Volume Confirmation)

Để tránh bẫy bứt phá giả (Fakeout), chỉ báo tích hợp bộ lọc MA Khối Lượng:

    Hợp lệ (Valid Breakout): Nến phá hộp có khối lượng lớn hơn $X$ lần đường MA Volume (mặc định $1.0\times$ MA 20). Hộp sẽ đổi sang màu Xanh (Tăng) hoặc Đỏ (Giảm).
    Kém thanh khoản (Low Volume): Nếu nến phá hộp nhưng khối lượng không đạt chuẩn, hộp sẽ giữ màu Xám nhằm cảnh báo lực đẩy yếu, dễ đảo chiều quay lại hộp.

3. ⏳ Hộp Darvas Khung Cao Hơn (Higher Timeframe - HTF)

    Cho phép vẽ đồng thời hộp Darvas của khung thời gian lớn (H1, H4, D1...) lên biểu đồ khung nhỏ (M5, M15...).
    Sử dụng tọa độ thời gian thực (xloc.bar_time) giúp căn chỉnh chính xác biên độ của khung lớn mà không làm biến dạng biểu đồ hiện tại.
    Hỗ trợ tùy chỉnh kiểu viền (nét liền, nét đứt, chấm chấm) và màu sắc riêng biệt để dễ dàng phân biệt với khung hiện tại.

4. 🖥️ Bảng Dashboard Theo Dõi Đa Cặp Tiền (Multi-Symbol Monitor)

Bảng thông số góc màn hình giúp theo dõi trạng thái hộp của 5 cặp tài sản cùng lúc mà không cần chuyển đổi biểu đồ:

    Nhận diện cặp tiền đang xem: Đánh dấu biểu tượng ▶ và tô sáng dòng của mã đang mở.
    Theo dõi thời gian thực:
        SYMBOL: Tên mã ngắn gọn (đã lọc bỏ tiền tố sàn như BINANCE:, FX:).
        TF: Khung thời gian đang quét.
        STATUS: Trạng thái hiện tại của hộp.
        TIME AGO: Thời gian đã trôi qua kể từ khi hình thành hộp hoặc từ lúc breakout thành công.

🎨 Bảng Giải Nghĩa Trạng Thái & Màu Sắc
Trạng Thái (Dashboard)	Màu Sắc	Ý Nghĩa Kỹ Thuật	Hành Động Gợi Ý
□ FORMING	⚪ Xám bạc	Giá đang tích lũy, nén biên độ trong hộp, chưa phá vỡ.	Chuẩn bị kịch bản, kiên nhẫn chờ breakout.
▲ BULL	🟢 Xanh lá	Bứt phá tăng chuẩn: Giá đóng cửa trên đỉnh hộp + Khối lượng đạt điều kiện.	Ưu tiên vị thế Mua (Long) theo đà xu hướng.
▼ BEAR	🔴 Đỏ	Phá vỡ giảm chuẩn: Giá đóng cửa dưới đáy hộp + Khối lượng đạt điều kiện.	Ưu tiên vị thế Bán (Short) hoặc hạ tỷ trọng.
△ BULL (VOL-)	🔘 Xám nhạt	Bứt phá tăng nhưng khối lượng thấp hơn ngưỡng MA Volume.	Cảnh báo bẫy tăng giá (Bull trap), hạn chế FOMO.
▽ BEAR (VOL-)	🔘 Xám nhạt	Phá vỡ giảm nhưng khối lượng thấp hơn ngưỡng MA Volume.	Cảnh báo bẫy giảm giá (Bear trap), theo dõi thêm.
— NO BOX	⚫ Xám tối	Chưa hình thành hộp mới hoặc chưa đủ dữ liệu pivot.	Đứng ngoài quan sát.
⚙️ Hướng Dẫn Cấu Hình (Settings)
1. ⚙️ Cài Đặt Hộp Darvas

    Số Nến Xác Định Đỉnh/Đáy (pivotSize): Mặc định là 3.
        Giá trị nhỏ (1 - 2): Hộp tạo nhanh hơn, bắt nhịp ngắn (Scalping).
        Giá trị lớn (3 - 5): Hộp bền vững hơn, biên độ rộng hơn, ít nhiễu (Day/Swing Trading).

2. 🎨 Cài Đặt Khung Hiện Tại

    Vẽ Hộp Khung Hiện Tại: Bật/Tắt hiển thị hộp trên chart đang xem.
    Kiểu Viền / Độ Dày: Chọn solid (nét liền), dash (nét đứt), hoặc dotted (chấm bi) cùng độ dày từ 1 đến 5.
    Màu Hộp: Tùy chỉnh màu sắc hộp khi đang tạo, khi phá vỡ tăng (Xanh) và khi phá vỡ giảm (Đỏ).

3. 📊 Bộ Lọc Khối Lượng (Volume Filter)

    Bật Lọc Khối Lượng: Tích chọn để kích hoạt kiểm tra nến phá vỡ bằng Volume.
    Chu Kỳ MA Volume: Mặc định 20 cây nến.
    Hệ Số Khối Lượng (x lần): Mặc định 1.0. Nếu đặt 1.5, nến phá vỡ phải có Volume lớn gấp rưỡi trung bình 20 phiên mới được tính là hợp lệ.

4. ⏳ Hộp Khung Cao Hơn (HTF)

    Vẽ Hộp Higher Timeframe: Bật/Tắt vẽ hộp khung lớn.
    Khung Thời Gian HTF: Nhập mã khung (ví dụ: 60 cho 1H, 240 cho 4H, D cho khung Ngày).
    Kiểu Viền & Màu Sắc HTF: Nên đặt nét đứt (dash) hoặc viền dày hơn để phân biệt trực quan với khung hiện tại.

5. 🖥️ Bảng Báo Cáo Đa Cặp Tiền (Dashboard)

    Hiển Thị Bảng Dashboard: Bật/Tắt bảng giám sát.
    Khung TG Bảng: Để trống để lấy theo khung chart hiện tại, hoặc nhập khung cố định (ví dụ 15, 60, D).
    Vị Trí & Kích Thước: Cho phép chọn 9 vị trí trên màn hình và 3 kích cỡ chữ (Nhỏ, Vừa, To).
    Danh Sách Mã (Mã 01 - 05): Nhập ký hiệu cặp tiền cần theo dõi (ví dụ: BINANCE:BTCUSDT, FX:EURUSD, OANDA:XAUUSD...).

💡 Chiến Lược Giao Dịch Thực Chiến Gợi Ý
🟢 Chiến Lược 1: Bứt Phá Hộp Chuẩn Đà (Darvas Breakout & Trend Continuation)

    Xác nhận vùng tích lũy: Hộp Darvas đang ở trạng thái FORMING (hộp màu xám mở rộng sang phải).
    Tín hiệu vào lệnh:
        Cây nến đóng cửa vượt ra ngoài biên hộp.
        Khối lượng bùng nổ $> 1.0\times$ MA20 $\rightarrow$ Hộp chuyển sang màu Xanh (▲ BULL) hoặc Đỏ (▼ BEAR).
    Điểm vào lệnh (Entry):
        Cách 1 (Quyết đoán): Vào lệnh ngay khi nến breakout đóng cửa.
        Cách 2 (An toàn): Đợi nến tiếp theo test lại biên hộp vừa phá vỡ (Pullback retest).
    Cắt lỗ (Stop Loss): Đặt ở mốc giữa hộp (Mid-box) hoặc phía ngoài biên đối diện của hộp.
    Chốt lời (Take Profit): Đo chiều cao của hộp ($H = \text{Top} - \text{Bottom}$) và dóng mục tiêu tối thiểu $1\times H$ hoặc $2\times H$ từ điểm breakout.

🌐 Chiến Lược 2: Hợp Lưu Đa Khung Thời Gian (HTF Confluence)

    Bật tính năng Hộp HTF (ví dụ biểu đồ M15 bật HTF 60 hoặc 240).
    Khi Hộp HTF đã xác nhận phá vỡ tăng (▲ BULL), ưu tiên tuyệt đối các lệnh Mua trên khung nhỏ.
    Trên khung nhỏ M15, chỉ kích hoạt lệnh khi xuất hiện hộp M15 mới bứt phá cùng chiều tăng với hộp HTF (Giao dịch thuận xu hướng lớn).
