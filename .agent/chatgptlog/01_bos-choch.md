Đúng ý bạn: **không cần đổi công thức gắn nhãn BOS/CHOCH**. Phần phải sửa là **pivot nào được phép trở thành mốc BOS/CHOCH**.

Hiện Pine gốc làm sai với logic trong video ở chỗ: mỗi pivot mới đều ghi đè `swingHigh/swingLow`, nên khi một đáy con bị phá, `displayStructure()` lập tức coi đó là CHOCH. Pasted text(20261006-174002)

Trong khi video muốn:

```text
Trend tăng:

        H2 -------- BOS
       /  \
      /    \ L2       ← L2 chưa được bảo vệ
 H1 --      \
   \         \
    L1       ↓

L2 bị phá → KHÔNG CHOCH
L1 bị phá → CHOCH

Chỉ sau khi H2 bị phá tạo BOS
thì L2 mới trở thành đáy chính/protected low.
```

Đây chính là ý tác giả nói: không lấy đáy gần nhất bên trong làm CHOCH; phải phá **đáy chính của sóng lớn**. Pasted text

## Cách sửa

Giữ nguyên `swingHigh` và `swingLow` để chúng làm **raw pivot / candidate pivot**.

Thêm hai pivot mới:

```pine
// Pivot thô vẫn là:
// swingHigh
// swingLow

// Mốc cấu trúc thực sự dùng để tính BOS / CHOCH
var pivot structureHigh = pivot.new(na, na, false)
var pivot structureLow  = pivot.new(na, na, false)
```

Ý nghĩa:

```text
swingHigh / swingLow
= pivot con, cập nhật bình thường

structureHigh / structureLow
= đỉnh đáy chính
= chỉ cập nhật khi cấu trúc được xác nhận
```

---

# 1. Thêm hàm copy pivot

Đặt gần `getCurrentStructure()`:

```pine
copyPivot(pivot dst, pivot src) =>
    dst.lastLevel    := dst.currentLevel
    dst.currentLevel := src.currentLevel
    dst.crossed      := false
    dst.barTime      := src.barTime
    dst.barIndex     := src.barIndex
```

---

# 2. Khởi tạo structure high/low

Sau:

```pine
getCurrentStructure(swingsLengthInput, false)
```

thêm:

```pine
if na(structureHigh.currentLevel) and not na(swingHigh.currentLevel)
    copyPivot(structureHigh, swingHigh)

if na(structureLow.currentLevel) and not na(swingLow.currentLevel)
    copyPivot(structureLow, swingLow)
```

---

# 3. Sau khi một structure high/low đã bị phá, chờ pivot ngoài mới để làm mục tiêu tiếp theo

Thêm:

```pine
// Sau BOS/CHOCH tăng:
// khi hình thành một swing high mới cao hơn structure high cũ,
// dùng nó làm mục tiêu structure tiếp theo.
if structureHigh.crossed and
   not na(swingHigh.currentLevel) and
   swingHigh.currentLevel > structureHigh.currentLevel

    copyPivot(structureHigh, swingHigh)


// Tương tự cho giảm
if structureLow.crossed and
   not na(swingLow.currentLevel) and
   swingLow.currentLevel < structureLow.currentLevel

    copyPivot(structureLow, swingLow)
```

Điểm cực kỳ quan trọng là:

```pine
swingLow mới xuất hiện
```

**không tự động thay `structureLow`.**

Đó chính là phần làm cho sóng con bị bỏ qua.

---

# 4. Thay `displayStructure()` cho Swing

Hiện code gốc dùng:

```pine
pivot p_ivot = internal ? internalHigh : swingHigh
```

và:

```pine
p_ivot := internal ? internalLow : swingLow
```

Pasted text(20261006-174002)

Nghĩa là nó phá **pivot gần nhất**.

Bạn tạo một hàm riêng cho Super SMC:

```pine
displaySuperStructure() =>

    // ==============================
    // BREAK LÊN
    // ==============================
    if not na(structureHigh.currentLevel) and
       high > structureHigh.currentLevel and
       not structureHigh.crossed

        string tag = swingTrend.bias == BEARISH ? CHOCH : BOS

        // Vẽ structure trước khi thay pivot
        if showStructureInput
            drawStructure(
                 structureHigh,
                 tag,
                 swingBullColorInput,
                 line.style_solid,
                 label.style_label_down,
                 swingStructureSize
             )

        if tag == CHOCH
            currentAlerts.swingBullishCHoCH := true
        else
            currentAlerts.swingBullishBOS := true


        // =====================================================
        // QUAN TRỌNG:
        // khi phá đỉnh chính thành công,
        // đáy pullback gần nhất mới được nâng thành protected low
        // =====================================================
        if not na(swingLow.currentLevel) and
           swingLow.barIndex > structureLow.barIndex

            copyPivot(structureLow, swingLow)


        structureHigh.crossed := true
        swingTrend.bias := BULLISH


        if showSwingOrderBlocksInput
            storeOrdeBlock(structureHigh, false, BULLISH)



    // ==============================
    // BREAK XUỐNG
    // ==============================
    if not na(structureLow.currentLevel) and
       low < structureLow.currentLevel and
       not structureLow.crossed

        string tag = swingTrend.bias == BULLISH ? CHOCH : BOS

        if showStructureInput
            drawStructure(
                 structureLow,
                 tag,
                 swingBearColorInput,
                 line.style_solid,
                 label.style_label_up,
                 swingStructureSize
             )

        if tag == CHOCH
            currentAlerts.swingBearishCHoCH := true
        else
            currentAlerts.swingBearishBOS := true


        // =====================================================
        // Khi phá đáy chính thành công,
        // đỉnh pullback gần nhất mới thành protected high
        // =====================================================
        if not na(swingHigh.currentLevel) and
           swingHigh.barIndex > structureHigh.barIndex

            copyPivot(structureHigh, swingHigh)


        structureLow.crossed := true
        swingTrend.bias := BEARISH


        if showSwingOrderBlocksInput
            storeOrdeBlock(structureLow, false, BEARISH)
```

---

## 5. Thay phần execution

Hiện bạn có:

```pine
if showInternalsInput or showInternalOrderBlocksInput
    displayStructure(true)

if showStructureInput or showSwingOrderBlocksInput or showHighLowSwingsInput
    displayStructure()
```

Pasted text(20261006-174002)

Giữ Internal như cũ:

```pine
if showInternalsInput or showInternalOrderBlocksInput
    displayStructure(true)
```

Nhưng Swing đổi thành:

```pine
if showStructureInput or showSwingOrderBlocksInput or showHighLowSwingsInput
    displaySuperStructure()
```

---

# 6. Có một thay đổi nữa rất quan trọng: `close` → `high/low`

Code hiện tại:

```pine
if ta.crossover(close, p_ivot.currentLevel)
```

và:

```pine
if ta.crossunder(close, p_ivot.currentLevel)
```

Pasted text(20261006-174002)

Tức là Pine hiện tại yêu cầu **close phá structure**.

Nhưng trong video tác giả nói rõ **râu nến chạm/phá qua cũng tính**, vì giá thực tế đã giao dịch ở đó. Pasted text

Vì vậy Super SMC phải dùng:

```pine
high > structureHigh.currentLevel
```

và:

```pine
low < structureLow.currentLevel
```

không phải:

```pine
close > ...
close < ...
```

---

# Logic sau khi sửa

Đây mới là phần cốt lõi:

```text
PIVOT RAW
swingHigh / swingLow
       │
       │ phát hiện liên tục bằng length 50
       ↓
candidate pivot

           KHÔNG tự động
           trở thành structure
                 │
                 ↓

structureHigh ───────────────────┐
                                │
                           giá phá High
                                │
                              BOS
                                │
                                ↓
              swingLow gần nhất được promote
                                │
                                ↓
                         structureLow
                         (protected low)
                                │
                                │
             các Low con sau đó bị phá
                  → KHÔNG CHOCH
                                │
                                ↓
                    structureLow bị phá
                                │
                              CHOCH
```

## Ví dụ cụ thể

Ban đầu:

```text
structureHigh = 100
structureLow  = 90
trend = bullish
```

Giá:

```text
100
 ↓
95       ← swingLow
 ↑
103      ← phá 100
```

=> BOS tăng.

Lúc này:

```text
structureLow = 95
```

Sau đó:

```text
103
 ↓
99       ← swingLow mới
 ↑
102
 ↓
98
```

98 phá 99.

**Không CHOCH**, vì:

```text
structureLow vẫn = 95
```

Giá phải xuống:

```text
94.9
```

mới:

```text
low < 95
→ CHOCH giảm
```

Đây chính là khác biệt mà người trong video đang nói.

---

## Điểm quan trọng nhất

Code gốc hiện tại về cơ bản là:

```pine
new pivot
→ replace swingLow/swingHigh
→ phá pivot đó
→ BOS/CHOCH
```

Còn Super SMC phải là:

```pine
new pivot
→ chỉ lưu candidate

candidate nằm bên trong structure
→ bỏ qua

BOS cùng trend xảy ra
→ promote pivot pullback thành protected structure

protected structure bị phá
→ CHOCH
```

Nói ngắn gọn: **không sửa dòng `tag = ... ? CHOCH : BOS` là chính. Phải thêm tầng `candidate pivot → protected structural pivot`.** Đây mới là thứ khiến BOS/CHOCH của Super SMC khác SMC gốc.
