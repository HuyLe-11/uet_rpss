# Kế hoạch migrate hệ thống chấm bài

Tài liệu này là handoff cho AI/engineer tiếp tục công việc. **Trạng thái mới nhất nằm ở mục “Cập nhật vận hành giải online (2026-10-21)” cuối tài liệu; phần khảo sát/checklist trước đó là lịch sử và có nội dung đã lỗi thời.** Chủ dự án xác nhận đã áp dụng `0004`; cần áp dụng `0005` và `0006` trước khi chạy giải mới.

## Mục tiêu đã thống nhất

- Supabase là dịch vụ trung tâm cho metadata bài nộp, trạng thái chấm, điểm, kết quả giải đấu và quyền truy cập.
- Module điều phối chấm tự host trên laptop; Judge0 giữ host port `2358`, API điều phối bind loopback port `8110` (đổi được qua `OTT_SCORING_PORT`), Cloudflare Tunnel expose hostname HTTPS.
- Khi nộp, ghi nhận yêu cầu ở Supabase và gửi bài cho module chấm. Module chấm xong callback kết quả lên Supabase; frontend nhận trạng thái/kết quả từ Supabase.
- Gỡ SQLite khỏi web/backend chạy trên Render. Dữ liệu game/replay dùng Postgres và private Supabase Storage; module chấm chỉ giữ source bot cần cho việc chạy Judge0.
- Duy trì tài liệu này và cập nhật checklist/decisions khi triển khai.

## Khảo sát repository (2026-10-20)

### Luồng submit hiện tại

- `frontend/src/App.tsx` gửi `POST /api/submit` qua `api()` trong `frontend/src/api.ts`.
- `backend/routers/contestant.py::submit_bot` gọi `T.submit()`, ghi `bots/<username>/latest.py`, rồi nếu `evaluate=1` chạy `evaluator.evaluate_bot_match()` ngay trong request.
- `backend/auth.py::ensure_local_user()` đồng bộ user vào SQLite `ott.db`; xác thực profile/token dựa trên Supabase.
- `tournament.py` dùng `ott.db` cho users, submissions, tournament state, matches, daily scores, replay và live scoring. `grade_day()` chạy các trận rồi ghi `matches`/`match_replays` vào SQLite.
- `data/sync.py` đẩy dữ liệu SQLite lên Supabase sau khi chạy lệnh BTC; đây là đồng bộ sau chấm, không phải hàng đợi chấm online.

### Supabase và replay hiện tại

- Schema hiện có `profiles`, `submissions`, `daily_results`, `matches`, `contest_days`, v.v. trong `data/supabase/migrations/0001_schema.sql`.
- Đã có `get_replay_ref(match_id)` RPC kiểm tra JWT, admin/cùng bảng và trạng thái ngày đã chấm; migration mới bổ sung RPC liệt kê replay trong phạm vi user.
- Trước cập nhật 2026-10-21, `data/replay_store.py` lưu JSON gzip trên disk và `data/storage_server.py` phục vụ replay local.
- Replay lịch sử từ `match_replays` SQLite chưa được migrate tự động; module mới tạo replay cho từng job entry/test.
- Frontend lấy metadata replay từ RPC, yêu cầu signed URL ngắn hạn qua Supabase Storage SDK rồi tải file từ Storage; payload JSON được gzip nén.

### Rủi ro kiến trúc cần xử lý

- Vercel không thể gọi `localhost` của người vận hành. URL `http(s)://host:2358` phải truy cập được từ trình duyệt người chơi, thường qua tunnel/reverse proxy; CORS và TLS cần được cấu hình. Không mở port trực tiếp mà không có xác thực.
- Browser không được gửi service-role key hoặc callback secret. Tạo job/status và ghi kết quả phải đi qua RPC/Edge Function/backend tin cậy.
- Hai request chạy đồng thời bằng cùng `job_id`; API đợi tối đa 2 giây để bản ghi Supabase xuất hiện. Frontend giới hạn ACK 10 giây, đọc lại trạng thái nếu response mơ hồ, rồi gọi RPC bù `dispatch_failed` nếu module không nhận.
- Supabase không tự timeout chỉ vì có cột thời gian. Migration có hàm watchdog nhưng chưa đăng ký scheduler; cần bật lịch chạy và chốt deadline.
- Một laptop có thể tắt/ngủ/mất mạng. Job cần trạng thái hết hạn, retry an toàn và khả năng operator chạy lại; cần quyết định mức bảo đảm khi module offline.
- `servers/scoring/judge0-v1.13.0/docker-compose.yml` đang publish Judge0 lên host port `2358`. Không thấy ứng dụng hiện gọi Judge0; `engine.py` chạy một subprocess bot tồn tại xuyên suốt trận, nhận trạng thái mỗi lượt qua stdin/stdout. Chủ dự án xác nhận muốn Judge0 làm sandbox; API điều phối sẽ ở port nội bộ khác sau hostname tunnel, Judge0 giữ `2358`.
- Judge0 chạy một chương trình cho stdin cố định; đã chốt bot function API `choose_move(state)` để cả trận BO2 chạy trong một sandbox Judge0 submission. Runner khởi động candidate trong child process bên trong Judge0 để giữ nhiều lượt và tách globals khỏi harness; phải xác minh Judge0 isolate cho phép child process, đồng thời benchmark và kiểm tra harness.
- File bot là dữ liệu không tin cậy. Giữ sandbox/giới hạn CPU, RAM, thời gian và quyền truy cập file; kiểm tra giới hạn upload ở module.
- Nếu Supabase đã ghi kết quả nhưng phản hồi callback bị mất, module phải retry callback cùng `job_id`; Supabase phải xử lý lặp idempotent.

## Thiết kế trạng thái và ngoại lệ đề xuất

### Trạng thái job

`dispatching -> accepted -> running -> succeeded | failed`; lỗi ACK thành `dispatch_failed`; watchdog chuyển `dispatching`/`accepted`/`running` quá hạn thành `timed_out`.

- `succeeded`: điểm và kết quả đã commit atomically lên Supabase. Frontend đọc kết quả từ Supabase/Realtime.
- `failed`: lỗi xác định như file không hợp lệ, bot lỗi runtime theo luật, hoặc engine lỗi không retry được. Lưu mã lỗi; không lưu stack trace/secret cho client.
- `timed_out`: chưa có kết quả trước deadline. Cho phép retry/requeue theo chính sách; kết quả đến muộn chỉ được chấp nhận nếu job vẫn là lần attempt hợp lệ, hoặc được lưu để operator reconcile.
- Với quyết định “không queue khi module offline”, lỗi ACK từ module bù trạng thái sang `dispatch_failed`. Nếu response mất sau khi module đã ACK, frontend đọc lại Supabase để tránh đánh dấu nhầm job đang chạy.
- `submission accepted` không đồng nghĩa chấm xong. UI hiển thị trạng thái chờ và subscribe/poll Supabase, không báo điểm trước khi commit.

### Luồng đề xuất (cần xác nhận)

1. Frontend tạo `job_id`, gọi Supabase RPC `create_scoring_job` và `POST /v1/jobs/{job_id}` đồng thời. Supabase giữ metadata/hash; file bot chỉ gửi trực tiếp module.
2. Module xác thực JWT qua Supabase Auth, kiểm tra job owner/hash/size bằng service role, lưu source theo UUID local, ACK và đưa job vào hàng đợi giới hạn.
3. Job `entry`/`test` chạy qua Judge0; job `submission` lưu version bất biến và metadata. Chấm ngày thật sẽ chuyển ở pha sau. Module lưu replay job gzip cục bộ.
4. RPC hoàn tất ghi điểm đầu vào hoặc metadata bài nộp cùng trạng thái `succeeded` trong transaction. Source và replay không được ghi vào Supabase.
5. Frontend dùng Supabase Realtime (hoặc polling nếu Realtime không phù hợp) để nhận trạng thái. Kết quả sau timeout cần reconcile, không được âm thầm ghi đè kết quả đã chấp nhận.
6. Watchdog chuyển job quá `deadline_at` thành `timed_out`; retry phải tạo attempt mới hoặc requeue có fencing token để callback cũ không ghi đè.

### Replay

- Máy chấm lưu file JSON gzip theo match ID/job ID và metadata giải đấu; tránh phụ thuộc vào tên user do client cung cấp.
- Supabase Storage private bucket `replays` lưu gzip JSON; `replay_objects` chỉ lưu metadata/hash/path. RLS cho metadata và Storage objects chỉ cho phép chủ job hoặc thành viên cùng bảng đã chấm/admin.
- Frontend tạo signed URL có thời hạn 120 giây và tải trực tiếp từ Supabase Storage. Dữ liệu replay không đi qua Render, tunnel hoặc API module.
- Module tải replay lên Storage trước khi báo kết quả job. Nếu upload lỗi, lỗi được log nhưng kết quả chấm vẫn được ghi; job thành công có thể chưa có replay và cần cơ chế sửa lại.

## Các quyết định cần chủ dự án xác nhận

1. **Đã trả lời:** nếu module không nhận ngay, submit thất bại (không queue chờ máy online).
2. **Đã trả lời:** expose module qua HTTPS Cloudflare Tunnel/hostname.
3. ACK 10s đã chọn; Judge0 giới hạn 140s; watchdog đề xuất timeout ở 180s. Chấm tự retry chưa bật; lỗi hạ tầng cần nộp lại. Cron scheduler chưa được tạo trong Supabase.
4. Chưa chốt số máy chấm đồng thời. Giả định ban đầu: một module authoritative có URL replay ổn định; nhiều máy cần routing/storage riêng.
5. **Đã trả lời:** phạm vi gồm entry, `/test-bot`, `close/grade` và quản trị giải đấu.
6. **Đã chọn cho submission mới:** source bất biến theo `job_id`; cần làm tiếp để `grade_day()` ghim version job ID thay vì đọc snapshot cũ `snaps/`.
7. **Đã trả lời:** Judge0 tiếp tục host port `2358`; API điều phối ở port nội bộ khác và đi qua hostname tunnel riêng.
8. **Đã trả lời:** cần tích hợp Judge0 làm sandbox chạy bot.
9. **Đã trả lời:** chấp nhận chuẩn hoá bot sang function API `choose_move(state)` để toàn trận chạy trong ít Judge0 submissions; cần chuyển đổi/giữ tương thích với bot stdin-loop cũ.

## Kế hoạch triển khai theo pha

- [x] Chốt quyết định ban đầu: thất bại ngay nếu module không nhận, dùng HTTPS tunnel, phạm vi gồm toàn bộ chức năng.
- [x] Tạo migration `0002_scoring_jobs.sql`: RLS read-own/admin, RPC create/accept/run/complete/fail/dispatch-fail/timeout, link submission metadata và RPC replay metadata.
- [x] Thêm Judge0 runner cho function bot, API module port `8110`, JWT/hash checks và bounded queue.
- [x] Chuyển frontend submit sang hai request song song, ACK 10 giây, theo dõi Supabase; replay mới đi qua private Storage.
- [ ] Chuyển bot mẫu/template sang `choose_move(state)` và hoàn thiện endpoint/chức năng `/test-bot`.
- [ ] Chuyển chấm ngày `grade_day`, live/offline score và thao tác admin sang module/Supabase; các phần này hiện vẫn ghi vào `ott.db`.
- [ ] Bỏ luồng chấm theo ngày/ghép cặp/grade/advancement còn trong `tournament.py` khỏi SQLite và chuyển sang worker module + Postgres RPC.
- [ ] Chuyển dữ liệu lịch sử SQLite hiện có lên Supabase; đối soát trước khi gỡ `tournament.py`, `data/sync.py` và `ott.db`. Các file SQLite này vẫn còn cho tool cũ, nhưng đã bị tách khỏi backend web hiện tại.
- [x] Thêm cấu hình mẫu cho port module `8110`, Judge0 `2358`, Vercel URL và Cloudflare Tunnel.
- [ ] Cập nhật triển khai Vercel, HTTPS/CORS/secret rotation và runbook laptop offline/recovery.
- [ ] Chuyển dữ liệu lịch sử SQLite hiện có lên Supabase/replay store; đối soát số lượng và điểm trước khi ngắt luồng cũ.

## Cập nhật triển khai hiệu năng (2026-10-21)

- [x] `backend/main.py` không còn import/khởi tạo `tournament.py`, không còn routes leaderboard/live/sample đọc file hoặc SQLite; chỉ giữ health và API quản trị cần service role. Bind port theo `PORT` của Render.
- [x] Xóa `backend/routers/contestant.py` khỏi code vì toàn bộ route trong đó gọi SQLite; frontend đọc dashboard từ một RPC Supabase.
- [x] Gỡ `ensure_local_user()` và cache profile không giới hạn khỏi auth. Auth và truy vấn profile chạy qua thread pool để không chặn event loop; backend không giữ cache dữ liệu người dùng.
- [x] Gỡ thao tác SQLite khỏi tạo tài khoản admin và `backend/manage.py check`.
- [x] Thêm `get_my_dashboard()` RPC gộp trạng thái, bảng xếp hạng, nhà vô địch và tiến độ thành một roundtrip.
- [x] Giảm polling job fallback từ 2 giây xuống 12 giây; Supabase Realtime là đường cập nhật chính.
- [x] Thêm migration `0004_replay_storage_and_web_api.sql`: bucket private 16 MiB/object, bảng metadata/hash, RLS đọc theo chủ job/thành viên bảng/admin, RPC metadata.
- [x] Chủ dự án xác nhận đã áp dụng `0004` lên Supabase và thử replay thành công.
- [x] Thêm migration `0005_admin_monitoring_and_round_submissions.sql`: URL máy chấm chính thức, RPC dashboard giám sát admin, cấu hình giai đoạn/vòng và ghi metadata submission khi job hoàn tất.
- [x] Nối URL do thí sinh nhập vào health check và `POST /v1/jobs/{id}`; URL admin lưu chính thức trên Supabase và được dùng làm mặc định. Cần CORS allowlist trên module cho domain Vercel.
- [x] Thay admin dashboard thành các khu vực giải đấu, máy chấm, quan sát và giám sát; ẩn navigation và luồng submit thí sinh khỏi role admin. Module metrics đọc trạng thái Judge0/worker.
- [x] Kiểm tra build frontend bằng `npm run build` (TypeScript + Vite thành công; còn cảnh báo bundle JS >500 KB).
- [x] Module upload replay gzip lên Storage; frontend ký URL 120 giây và tải nội dung trực tiếp từ Supabase.
- [ ] Chạy `0005_admin_monitoring_and_round_submissions.sql` trên Supabase trước khi dùng URL chính thức và admin dashboard mới.
- [ ] Replay trận lịch sử chưa tự chuyển từ `ott.db`/`data/storage/replays`; RPC chỉ liệt kê replay có metadata `replay_objects`.
- [ ] SQLite vẫn được dùng bởi `tournament.py`, `data/sync.py`, `data/manage.py`, các batch/script legacy và tool/test cũ. `grade_day`, ghép cặp, advancement, offline/live scoring chưa được chuyển; vì vậy chưa thể xóa `ott.db` hoặc tuyên bố toàn bộ migration hoàn tất.
- [ ] Migration `0005` chưa được chạy/kiểm tra trên Supabase trong lần cập nhật này; cần áp dụng trước khi deploy UI admin mới. Admin RPC mới hiển thị tối đa 200 job, 1000 thí sinh, 200 trận và 500 kết quả gần nhất.
- [ ] Admin có thể cấu hình phase/context và quan sát; nút đóng ngày, tạo Swiss pairing, chạy grading, tính advancement/champion chưa được triển khai. Không dùng v0 để vận hành các vòng cần các thao tác này.
- [ ] Nếu replay upload fail, job chấm vẫn hoàn thành nhưng chưa có replay. Cần thêm retry/reconciliation và metric upload-failed trước production.
- [ ] Hạn chế file replay hiện là 16 MiB; cần đo kích thước thực tế và dung lượng/bandwidth Supabase trước khi demo nhiều trận.

### Cấu hình cần cho bản Render/Vercel demo

- Render API: `PORT` do Render cấp; `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OTT_CORS_ORIGINS` (domain Vercel chính xác, cộng localhost khi dev).
- Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SCORING_MODULE_URL`. Vẫn cần module chấm public HTTPS qua tunnel cho upload/chấm; replay không cần gọi tunnel.
- Không đưa service role key vào Vercel. Không bật public bucket; chỉ signed URL có thời hạn.
- Render free có thể cold start/sleep; giữ API khỏi đường đọc dashboard/replay nóng. Admin account create/import vẫn dùng Render.

## Các file liên quan

- `frontend/src/App.tsx`, `frontend/src/api.ts`, `frontend/src/Replay.tsx`
- `backend/auth.py`, `backend/main.py`
- `tournament.py`, `evaluator.py`, `engine.py`
- `data/supabase/migrations/0001_schema.sql`, `data/sync.py`, `data/replay_store.py`, `data/storage_server.py`
- `data/DATABASE_DESIGN.md`, `data/CLOUDFLARE_TUNNEL.md`, `servers/scoring/`

## Tiến độ

- [x] Khảo sát luồng hiện tại và ghi nhận kiến trúc/ngoại lệ.
- [x] Chốt thất bại ngay khi module không nhận, HTTPS tunnel, phạm vi toàn bộ và giữ Judge0 tại port `2358`.
- [x] Chọn ACK timeout 10s (frontend), bounded queue và một lần chạy; retry chấm tự động chưa bật.
- [x] Chốt execution interface: function bot `choose_move(state)` trong một Judge0 sandbox cho mỗi trận BO2.
- [x] Tạo migration và scoring module foundation (chưa apply SQL/chưa production-ready).
- [x] Chuyển frontend submit/replay foundation.
- [x] Thêm migration `0003_immediate_scoring_and_admin_phases.sql`: chấm mỗi lần gửi, cap 20 lượt vòng loại, giữ điểm tốt nhất, admin đặt phase và theo dõi scoring jobs.
- [ ] Gỡ SQLite khỏi luồng chấm và hoàn tất migration dữ liệu.

## Cập nhật vận hành giải online (2026-10-21)

Phần checklist lịch sử phía trên phản ánh trạng thái trước khi có migration 0006. Trạng thái hiện tại:

- Đã viết luật đầy đủ tại `docs/TOURNAMENT_OPERATIONS.md`, bao gồm giới hạn 4.000, vòng đầu vào/40 bảng, 7 lượt Swiss, vắng mặt `-1`, bye `0`, điều kiện 4/6, top/vé vớt, công bố trễ và phạm vi online.
- Đã tạo `data/supabase/migrations/0006_online_tournament_operations.sql`: RPC tạo cặp, xử lý bye, ghi kết quả trận, tính bảng từng ngày, xét vé vớt và chuyển vòng; thêm bảng tạm dành admin.
- Scoring module chạy cặp song song có giới hạn (`OTT_TOURNAMENT_MATCH_WORKERS`, mặc định 4), tự khởi động lại xử lý ngày hiện hành, hỗ trợ admin đóng/mở/resume ngày và tải replay lên Supabase Storage.
- `tournament.py` chỉ còn CLI đọc trạng thái Supabase. Đường đồng bộ SQLite `data/sync.py` đã được archive khỏi đường chạy; tạo tài khoản trong `data/auth_service.py` không còn đồng bộ vào SQLite. Snapshot mã cũ ở `backup/legacy_sqlite/`.
- Admin có thể xuất bảng tạm hiện tại thành CSV; dữ liệu này chỉ dành admin. Thí sinh chỉ nhận BXH theo RPC công bố sau thời điểm `publish_after`.
- **Việc còn bắt buộc trước khi vận hành:** áp dụng 0005 và 0006 lên Supabase theo thứ tự, kiểm tra dữ liệu/schema hiện hữu và chạy một giải thử trên project riêng. Workspace không có kết nối DB để thực thi migration thật. Vòng 5 offline không nằm trong phạm vi và không được tự động tạo.

Những file cũ trong phần checklist phía trên được giữ làm lịch sử; khi triển khai vận hành mới, ưu tiên tài liệu này cùng `docs/TOURNAMENT_OPERATIONS.md`.

## Lịch sử nộp bài và replay (2026-10-21)

- Tab `/submission` có lịch sử 50 job gần nhất của người đang đăng nhập (entry và submission), cập nhật khi job đổi trạng thái và làm mới dự phòng mỗi 30 giây.
- Mở một lượt vòng loại để xem điểm, điểm ba bot đối chứng và kết quả từng ván; nút yêu cầu replay tải JSON nén từ private Storage rồi phát trên bàn cờ.
- Mở một lượt thi đấu để xem replay của các trận có bot đó sau khi kết quả ngày được công bố. Trước thời điểm công bố, giao diện không hiển thị kết quả/replay trận.
- Migration `0007_submission_history_and_replay_visibility.sql` siết Storage policy và RPC replay theo `publish_after`; cần áp dụng sau `0006` trên Supabase.

### Judge0 design notes (đã chốt execution interface)

- Judge0 HTTP API nhận một chương trình, stdin cố định và chạy tới khi process kết thúc; tài liệu không mô tả kênh gửi stdin tương tác thêm trong lúc chạy ([Create a Submission](https://github.com/judge0/judge0/blob/master/docs/api/submissions/create_a_submission.md), [Submissions API](https://github.com/judge0/judge0/blob/master/docs/api/submissions/submissions.md)). Engine OTT hiện yêu cầu một bot process tương tác nhiều lượt qua stdin/stdout.
- Không thấy trong giao thức Judge0 hiện tại một cách giữ process sống rồi gửi thêm stdin giữa lượt. Vì vậy không thể thay `ProcBot` bằng một HTTP call cho toàn trận mà giữ nguyên protocol.
- Phương án một submission mỗi nước đi bị loại vì khởi chạy sandbox lại, mất state nội bộ và tạo tới hàng trăm submissions mỗi trận.
- **Đã chọn:** adapter function-based (`choose_move(state)`) cho toàn trận trong một Judge0 submission. Trusted harness chạy trong Judge0; candidate chạy trong process con persistent; parent kiểm tra nước đi và áp timeout mỗi lượt. Cần xác minh child process trong isolate trước production. Bot stdin-loop top-level phải chuyển API hoặc nộp lại.
- Không được fallback sang chạy bot trực tiếp trong API module/engine process; như vậy phá sandbox isolation.
- Cần benchmark Judge0 limits, queue saturation, timeout/resource limits, output parsing và kiểm tra bot không thể làm giả kết quả harness trước khi production.

## Trạng thái code trong workspace

- `data/supabase/migrations/0002_scoring_jobs.sql` mới tạo; phải review/apply lên Supabase project trước khi frontend submit mới hoạt động.
- `servers/scoring/module.py` chỉ bind `127.0.0.1:8110` và dùng `data.supabase_client`/service role. Bảo mật service-role key trong máy module.
- `servers/scoring/judge0_runner.py` chạy `choose_move(state)`/`choose_best_move(state)` trong một Judge0 Python submission cho BO2, spawn candidate subprocess giữ sống theo ván; child process trong isolate chưa được xác minh. Migration 0003 chuyển upload sang chấm ngay, giới hạn 20 lượt phase entry và giữ điểm cao nhất. Flow giải đấu theo ngày/grade_day vẫn chưa được chuyển.
- `frontend/src/App.tsx` / `api.ts` submit qua URL thí sinh nhập (hoặc URL admin cấu hình làm mặc định), kiểm tra `/v1/health`, tạo job Supabase và gửi file tới module. Cần HTTPS public URL, CORS allowlist `OTT_SCORING_CORS_ORIGINS` trong module và Cloudflare Tunnel. Không còn bắt buộc `VITE_SCORING_MODULE_URL` nếu URL được lưu trong Supabase/nhập trên form.
- Replay UI đọc metadata từ `get_my_replay_matches`, ký URL qua Supabase Storage SDK và tải gzip trực tiếp; replay job mới chỉ xuất hiện sau khi `0004` được apply.
- Source bot vẫn được lưu local theo job ID để module chuyển tiếp Judge0; không được dùng thư mục source làm replay/cache web.
- `.gitignore` trước đây bỏ qua toàn bộ `servers/`; đã thêm ngoại lệ hẹp cho source/config cần thiết.
- `judge0.conf` vẫn bị ignore vì chứa credentials local. Các giới hạn cần thiết được ghi trong `data/CLOUDFLARE_TUNNEL.md`; chỉ commit Compose, không commit `judge0.conf`.
- Build frontend đã chạy thành công sau thay đổi admin/URL. Chưa xác nhận SQL `0005` đã chạy và chưa xác minh deploy thực tế.
- Chưa deploy-ready cho giải đấu đầy đủ: chấm giải ngày, close, ghép cặp, live/offline scoring, advancement và các đường SQLite còn lại chưa migrate. Có thể deploy để demo luồng auth, entry scoring, replay đã chuyển và quan sát cơ bản sau khi áp dụng `0005` và cấu hình env/CORS/tunnel.

## Cập nhật chuyển sang Cloudflare Worker trực tiếp (2026-10-27)

Đây là trạng thái code mới nhất sau khi chủ dự án yêu cầu loại bỏ scoring
module chạy trên laptop khỏi đường truy cập web. **Các thay đổi trong workspace
chưa được deploy production và chưa được apply lên Supabase thật.**

### Đã triển khai trong workspace

- Thêm đường gọi trực tiếp từ frontend tới Cloudflare Worker bằng
  `VITE_SCORING_PROXY_URL`; request dùng Supabase access token trong header
  `Authorization: Bearer <JWT>`.
- Worker xác thực JWT bằng Supabase Auth endpoint trước khi nhận yêu cầu.
  `ONLINECOMPILER_API_KEY` chỉ được đọc từ Worker secret.
- Thêm Durable Object job polling cho `POST /v1/score` và
  `GET /v1/score/{job_id}`; job được giới hạn quyền đọc theo `user_id`.
- Thêm migration `0017_cloudflare_proxy_matches.sql` với bảng tạm
  `proxy_match_submissions` và RPC:
  `proxy_prepare_match`, `proxy_complete_match`.
- Thêm migration `0018_proxy_match_context.sql`; RPC
  `get_my_today_matches()` trả thêm `match_id` để frontend gửi đúng cặp đấu.
- Với trận chính, frontend gửi source bot và `match_id`. Worker lưu source theo
  `(match_id, user_id)`, chạy ngay khi có source của cả hai bên, sau đó gọi RPC
  ghi `score_a`/`points_a`/`points_b` và xóa source tạm.
- Nếu đối thủ chưa gửi, Worker chờ 90 giây rồi xử thắng/thua bằng RPC.
  Official match UI đọc trạng thái từ Supabase thay vì poll Durable Object liên
  tục, để giảm request trên Workers Free.
- Durable Objects Free có hạn mức 100.000 request/ngày và request này tính cả
  lần gọi alarm; tránh poll job của từng thí sinh qua Worker mỗi vài giây.
- Migration `0026_cloudflare_proxy_match_flow.sql` sửa luồng chính thức: sau khi
  đóng vòng loại hoặc mở ngày online, Supabase sinh pairing lượt 1 ngay; frontend
  chọn từng `match_id` và gửi bài thẳng tới Worker. Worker merge source của người
  nộp thứ hai vào job đang chờ; timeout được ghi thành forfeit qua RPC.
- Migration `0025_tournament_submission_windows.sql` còn để lại bảng nguồn theo
  ngày từ nhánh thử nghiệm cũ, nhưng luồng chính thức không đọc bảng đó nữa.
  Migration `0026` gỡ trigger deadline cũ và dùng `proxy_match_submissions` theo
  từng trận.
- Migration `0027_fix_prepare_swiss_round_conflict.sql` sửa lỗi `player_a is
  ambiguous` trong `prepare_swiss_round`; apply migration này nếu `0026` đã chạy.
- Migration `0028_match_submission_window_90_seconds.sql` nâng thời gian phản
  hồi lên 90 giây và trả điểm/kết quả của từng trận cho màn hình người chơi.
- Migration `0029_proxy_scoring_timeout_exception.sql` giới hạn mỗi request
  chấm ở 120 giây, retry tối đa hai lần và chốt ngoại lệ sau tối đa tám phút
  kể từ lúc bắt đầu xử lý; nếu vẫn lỗi thì ghi mã ngoại lệ và xử hòa 0 điểm để
  không treo trận. RPC ghi điểm/ngoại lệ yêu cầu service-role Worker key.
- Migration `0030_advance_swiss_round_after_match.sql` để Worker yêu cầu SQL
  ghép lượt Swiss kế tiếp sau khi toàn bộ các cặp của lượt hiện tại đã chốt và
  đã nghỉ tối thiểu một phút.
- Migration `0031_two_bo2_attempts_per_match.sql` cho mỗi cặp hai lượt chấm
  BO2, nghỉ một phút giữa hai lượt; điểm bốn ván được cộng lại và chỉ chốt
  điểm trận sau lượt BO2 thứ hai. Không có đồng hồ chờ lượt này trên giao diện.
- Worker chạy hai ván đổi lượt đi trước mỗi BO2; màn hình kết quả của trận
  chính hiển thị tổng bốn ván và tên đối thủ.
- Scoring module/Judge0 có thể còn trong workspace làm công cụ rollback, nhưng
  trận vòng đấu chính thức phải gửi `match_id` qua Cloudflare Worker.
- Arena đã đổi sang OnlineCompiler widget, có template bot bên dưới và nút
  copy template. Arena không ghi điểm vào thành tích giải.
- Màn hình chính đã có nút `Nộp bài`, IDE Monaco lớn hơn, lựa chọn file/code,
  menu Python hiện tại và lịch sử đấu có opponent ID/điểm/trạng thái.
- Tab `Luật thi đấu` được đổi thành `Tài liệu và trạng thái`; tiến trình thi
  đấu được đưa vào tab này.
- Đã xóa key OnlineCompiler khỏi `frontend/.env` hiện có trong workspace.
  Widget chỉ đọc `VITE_ONLINE_COMPILER_KEY` nếu ban tổ chức cấp một widget key
  public riêng; không dùng API secret của OnlineCompiler.

### Cấu hình cần có khi deploy Worker

Trong `servers/scoring/cloudflare_proxy/`:

```sh
npx wrangler secret put ONLINECOMPILER_API_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

`SUPABASE_URL` là biến Worker trong `wrangler.toml`, cần đổi từ giá trị mẫu
thành project thật. Frontend cần:

```env
VITE_SCORING_PROXY_URL=https://<worker-domain>
VITE_ONLINE_COMPILER_KEY=<public-widget-key-if-provided>
```

Không đưa `ONLINECOMPILER_API_KEY`, Supabase service-role key hoặc queue admin
token vào frontend/Vercel. Service-role key chỉ được lưu thành Cloudflare Worker
secret để Worker ghi kết quả/ngoại lệ chấm; RPC `proxy_prepare_match` vẫn dùng
JWT thí sinh.

### Việc bắt buộc trước khi dùng thật

- [ ] Apply các migration Cloudflare từ `0017` đến `0031` theo thứ tự trong
  `data/SUPABASE_SETUP.md`.
- [ ] Kiểm tra schema `public.matches` đang có các cột `state`,
  `points_a`, `points_b`, `started_at`, `finished_at`; hai migration mới phụ
  thuộc vào các cột này.
- [ ] Deploy Worker với Supabase URL/key thật và kiểm tra CORS preflight,
  JWT hết hạn, user không thuộc match, match ID giả và job của user khác.
- [ ] Kiểm thử hai tài khoản gửi cùng `match_id`: gửi trước, gửi sau, gửi lại,
  gửi sai cặp và timeout 90 giây.
- [ ] Xác minh việc ghi kết quả qua RPC không làm mất logic finalize ngày,
  bảng xếp hạng, replay và chuyển vòng.
- [ ] Bổ sung/chốt đường vòng loại trực tiếp trên Worker nếu muốn loại bỏ
  scoring module hoàn toàn. Hiện vòng loại chưa có catalog bot và phép tính
  trọng số `1×s0 + 2×s1 + 3×s2` trên Worker.
- [ ] Cài Node.js rồi chạy `npm install` và `npm run build` trong `frontend`.
- [ ] Cấu hình widget key public và kiểm tra widget OnlineCompiler thực tế.

### Giới hạn và rủi ro đã biết

- Cloudflare Free/Durable Objects không nên được xem là đã chịu tải giải thật
  chỉ dựa trên load test cũ. Cần đo queue wait, giới hạn OnlineCompiler,
  retry/429 và số trận đồng thời trên deployment thật.
- Source bot và access token đang được giữ trong Durable Object job state để
  Worker có thể gọi Supabase sau khi job hoàn tất. Cần đánh giá lại retention,
  log redaction và cách revoke token; không ghi source/token vào log.
- `proxy_complete_match` và `proxy_fail_match` chỉ được gọi bằng service-role
  secret từ Worker; không được đưa secret này vào frontend.
- Luồng chấm official mới đã được nối ở frontend nhưng chưa thay thế toàn bộ
  các luồng `entry`/`test`; fallback cũ vẫn tồn tại có chủ đích.
- `VITE_ONLINE_COMPILER_KEY` là public widget key, không phải secret. Nếu
  OnlineCompiler không cấp widget key public hoặc widget cần secret, Arena
  phải tiếp tục dùng proxy và không được đưa secret vào bundle.

### Kiểm thử đã chạy trong workspace

- `python3 -m py_compile servers/scoring/module.py servers/scoring/judge0_runner.py`
  đã chạy thành công.
- `git diff --check` đã chạy thành công.
- Chưa chạy được build/type-check frontend vì môi trường hiện tại không có
  `node`, `npm` hoặc `npx`.

## Quản trị reset và phục hồi ngày thi (2026-10-22)

- Admin sidebar có menu độc lập `Thí sinh bị loại`; có thể ban/gỡ ban. Gỡ ban khôi phục `new` khi ở đầu vào, hoặc `active` nếu vẫn có thành viên ở vòng hiện hành. Người bị ban bị loại khỏi ghép Swiss mới; các trận chờ của họ được xử thua. Không cho ban khi trận của người đó đang chạy.
- Reset giải về ngày 0 gọi qua scoring module sau khi xác thực admin. Giữ user/Auth, cấu hình `round_config`, role admin và URL máy chấm; xóa scoring jobs, source metadata, submissions, matches, byes, daily results, advancement, round membership, replay metadata và `live_scores`; đặt contestant về `new`, xóa `entry_score` và cờ disqualification; đưa tournament state về `entry`, round/day/pending day bằng 0, nhận bài mở.
- Reset từ chối khi có scoring job hoặc match còn chạy trong module hiện tại; scoring job được bảo vệ theo ID đang xử lý, match được bảo vệ theo ID đang chạy cộng với lease DB 5 phút. Job active cũ hơn 15 phút và match `running` cũ hơn 5 phút, nhưng không còn trong tiến trình hiện tại, được coi là orphan để phục hồi sau restart. Scoring module chạy một worker process (`start_module.sh` dùng uvicorn workers=1); nếu đổi sang nhiều instance, cần thay các tập ID trong RAM bằng lease/heartbeat dùng chung trước khi tin cậy cơ chế orphan recovery.
- Reset xếp Storage paths và ID source bot trên máy local vào hai cleanup queue bền vững trước khi xóa metadata. Module xóa source files theo batch; frontend xóa Storage qua Storage API rồi ACK từng batch. Nếu một bước lỗi, menu có `Dọn replay còn tồn` để retry. Tài khoản không bị xóa. Không có backup/rollback.
- `0011_safe_tournament_reset_and_resume.sql` thay reset RPC thành service-role-only, đồng bộ lock của state với tạo scoring job, chuẩn bị pairing, finalize và claim match; finalize có thể retry sau response thất lạc. Áp dụng theo thứ tự 0008–0011 (0009 sửa tên cột `grp`, 0010 xử lý bảng một người/bye).
- Scoring module phục hồi ngày `open`, `closed` và `grading` sau restart; lỗi tạm thời được retry với backoff. Match replay được lưu trước khi chuyển trạng thái match sang hoàn tất để reset không xóa giữa lượt upload. Missing bot source được log; nếu ngày đóng, match sẽ xử theo nhánh vắng mặt sau khi lấy được lease.
- Chưa chạy build/test hoặc apply migrations từ workspace. Trước khi dùng reset production: apply migrations 0008–0011; deploy frontend và scoring module đồng bộ; đảm bảo CORS/tunnel tới module hoạt động. Reset cần module online và sẽ báo từ chối nếu công việc còn đang hoạt động.

## Cập nhật proxy và lịch sử nộp bài (2026-10-27)

### Đã hoàn thành

- Đã chuyển kết quả proxy về một schema thống nhất: `match_score`, `passed`,
  `match_result` (`win`/`loss`/`draw`) và `games`. Vòng loại chỉ đấu với một
  bot mẫu; không còn dùng tiêu chí 3 bot/điểm trọng số của scoring module cũ.
- Đã cập nhật frontend và lịch sử nộp bài để hiển thị trực tiếp thắng/hòa/thua
  từ `match_score`.
- Đã thêm migration `0020_proxy_result_status.sql`. RPC
  `complete_proxy_scoring_job` ghi kết quả proxy vào `scoring_jobs`, cập nhật
  `entry_score` và chuyển thí sinh sang `active` khi thắng vòng loại.
- Đã sửa lỗi frontend đánh dấu job proxy hoàn tất trước khi RPC Supabase hoàn
  tất. Trước đây RPC lỗi bị che bởi cờ polling đã kết thúc, khiến giao diện
  chấm xong nhưng lịch sử vẫn là `accepted`/`running`. Frontend hiện giữ job
  đang hoàn tất, kiểm tra giá trị boolean RPC trả về và báo rõ nếu migration
  chưa được áp dụng.

### Việc cần triển khai bắt buộc

1. Chạy `data/supabase/migrations/0020_proxy_result_status.sql` và sau đó
   `data/supabase/migrations/0021_proxy_result_idempotency.sql` trên project
   Supabase production sau các migration `0018` và `0019`.
2. Deploy lại frontend sau thay đổi `App.tsx`, `SubmissionHistory.tsx` và
   `api.ts`.
3. Deploy lại Worker sau thay đổi schema kết quả trong `worker.js`.
4. Nộp một bài mới và xác nhận trong bảng `scoring_jobs`:
   `status = 'succeeded'`, `result.match_score` có giá trị và
   `finished_at` khác null.
5. Mở lại trang lịch sử hoặc bấm “Làm mới”; trạng thái phải là “Đã chấm xong”.

### Chẩn đoán nếu lịch sử vẫn chờ

- Nếu frontend báo lỗi RPC: đọc phần chi tiết sau dấu `:`. `proxy_scoring_job_not_owned`
  nghĩa là `job_id` trả từ Worker không thuộc user hiện tại; `invalid_proxy_result`
  nghĩa là kết quả proxy không có `match_score` hợp lệ. Các lỗi này không còn bị
  biến thành thông báo chung.
- Migration `0021` làm RPC idempotent: nếu frontend retry sau khi request trước
  đã ghi thành công, RPC trả `true` thay vì `false`. Nếu frontend vẫn báo thiếu
  migration, kiểm tra migration `0021` và quyền execute cho role `authenticated`.
- Lỗi `403 proxy_scoring_job_not_owned` đã được truy nguyên thêm: frontend tạo
  `scoring_jobs.id` và gửi `job_id` lên Worker, nhưng Worker trước đây không
  chuyển `job_id` vào Durable Object ở nhánh enqueue trực tiếp (và tự sinh UUID
  khác). Worker mới giữ nguyên `job_id` qua cả nhánh enqueue thường và
  `enqueue-waiting`, nên RPC hoàn tất tra đúng bản ghi Supabase.
- Nếu Worker trả `succeeded` nhưng `scoring_jobs` vẫn `running`, kiểm tra
  request `POST /rest/v1/rpc/complete_proxy_scoring_job` trong DevTools và
  response JSON/HTTP status.
- Không sửa trực tiếp trạng thái bằng frontend hoặc service-role key. Kết quả
  phải được ghi qua RPC để giữ kiểm tra chủ sở hữu job và RLS.

### Kiểm thử workspace

- `git diff --check`: đạt.
- Chưa chạy được build/type-check frontend vì môi trường hiện tại không có
  `node`, `npm` hoặc `npx`.
