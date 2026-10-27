# Cấu hình Supabase

> **Trạng thái theo ghi chú triển khai trước:** migration `0004` đã được áp dụng và replay đã chạy thử. Trạng thái thực tế của project Supabase chưa xác nhận được trong phiên này. Các hàm quản trị, reset, cổng nhận bài, lượt vòng loại và tie-break mới cần migrations `0005`–`0013` chạy theo đúng thứ tự bên dưới; các migration `0008`–`0013` mới có trong workspace và chưa được áp dụng từ phiên làm việc này.

## 1. Tạo project
1. Vào https://supabase.com → **New project** (chọn region gần VN: Singapore).
2. Lưu **Database password**. Đợi project khởi tạo xong.

## 2. Chạy schema
**Dashboard → SQL Editor → New query**, chạy tuần tự từng migration:
`0001_schema.sql` → `0002_scoring_jobs.sql` → `0003_immediate_scoring_and_admin_phases.sql` → `0004_replay_storage_and_web_api.sql` → `0005_admin_monitoring_and_round_submissions.sql` → `0006_online_tournament_operations.sql` → `0007_submission_history_and_replay_visibility.sql` → `0008_admin_tournament_controls.sql` → `0009_fix_prepare_swiss_round_grp_ambiguity.sql` → `0010_handle_single_contestant_bye.sql` → `0011_safe_tournament_reset_and_resume.sql` → `0012_fix_scoring_and_submission_controls.sql` → `0013_entry_attempts_and_daily_tiebreak.sql` → `0014_fix_admin_eliminated_email_type.sql` → `0015_durable_scoring_queue.sql` → `0016_queue_claim_only_ready_jobs.sql` → `0017_cloudflare_proxy_matches.sql` → `0018_proxy_match_context.sql` → `0018_proxy_match_opponent_id.sql` → `0019_proxy_admin_controls.sql` → `0020_proxy_result_status.sql` → `0021_proxy_result_idempotency.sql` → `0022_admin_clear_contestant_submissions.sql` → `0023_balance_groups_for_small_fields.sql` → `0024_fix_admin_tournament_reset.sql` → `0025_tournament_submission_windows.sql` → `0026_cloudflare_proxy_match_flow.sql` → `0027_fix_prepare_swiss_round_conflict.sql` → `0028_match_submission_window_90_seconds.sql` → `0029_proxy_scoring_timeout_exception.sql` → `0030_advance_swiss_round_after_match.sql` → `0031_two_bo2_attempts_per_match.sql`.
Không chạy `0004` trước các migration tạo `matches` và `scoring_jobs`.

## 3. Cấu hình Auth
**Authentication → Providers → Email**:
- Bật **Email** provider.
- **Tắt "Confirm email"** (email là email giả, không gửi được mail).

**Authentication → Sign In / Providers** (hoặc *Settings*):
- **Tắt "Allow new users to sign up"** → chặn mọi người tự tạo tài khoản bằng anon key.
  Tài khoản được tạo qua `admin_cli_service` (`service_role` + Admin API); frontend không được chứa service role key.

**Authentication → Rate Limits**: giữ mặc định, hoặc nâng "Sign in" lên nếu 4000 người đăng nhập cùng lúc.
**Authentication → Sessions** (gói Pro): đặt *time-box / inactivity timeout* nếu muốn giới hạn phiên.
JWT expiry mặc định 3600s; client dùng `/auth/refresh` để gia hạn.

## 4. Lấy khóa
**Project Settings → API**:
| Giá trị | Biến môi trường | Ghi chú |
|---|---|---|
| Project URL | `SUPABASE_URL` | |
| `anon` public key | `SUPABASE_ANON_KEY` | an toàn đưa vào frontend |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | **bí mật**, chỉ trên máy chủ/máy chấm |

```bash
cp data/.env.example data/.env      # rồi điền 3 khóa trên
```

## 5. Tạo admin đầu tiên và kiểm tra
```bash
.venv/bin/python -m admin_cli_service.manage check
.venv/bin/python -m admin_cli_service.manage create-admin btc@example.com btc_admin 'MatKhauManh123'
```

Tạo/import admin chỉ chạy bằng CLI trên máy tin cậy; frontend không có chức năng gửi service-role operation.

## 6. Lưu ý dữ liệu legacy

Luồng vận hành mới không đọc/ghi SQLite. `tournament.py status` chỉ đọc Supabase; `data/sync.py` đã được archive tại `backup/legacy_sqlite/`. Nếu còn cần chuyển dữ liệu cũ, thực hiện trên bản sao riêng và đối soát trước khi import; không chạy đồng thời tool SQLite cũ với giải Supabase.

## 7. Dùng từ frontend (supabase-js)
Frontend có thể gọi trực tiếp Supabase bằng anon key + JWT của thí sinh:
```js
const { data: s } = await sb.rpc('get_group_leaderboard', { p_rnd: 1 });        // BXH bảng mình
const { data: m } = await sb.rpc('get_group_matches', { p_rnd: 1, p_day: 3 });  // trận trong ngày
const { data: me } = await sb.from('round_members').select('*');                // chỉ thấy dòng của mình
```
Frontend gọi Supabase RPC/Storage bằng anon/publishable key + JWT, còn mọi lượt chấm đi qua Cloudflare Worker. Worker giữ OnlineCompiler key và Supabase service-role key; browser không gọi scoring module cũ.

## 8. Checklist an toàn
- [ ] `data/.env` không commit (đã nằm trong `.gitignore`).
- [ ] Đã tắt public sign-up.
- [ ] RLS bật (script đã bật); thử đăng nhập 1 thí sinh và `select * from daily_results` chỉ thấy dòng của mình.
- [ ] Bật **Point-in-Time Recovery** / backup trước ngày thi (Pro) hoặc `pg_dump` định kỳ.

## 9. Biến môi trường khi deploy demo

- **Vercel** (Root Directory `frontend`, Build `npm run build`, Output `dist`): đặt `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (hoặc publishable key) và `VITE_SCORING_PROXY_URL=https://<worker-domain>`.
- **Máy quản trị**: đặt `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` trong môi trường local rồi chạy `admin_cli_service` khi cần tạo/import admin. Không đưa service-role key vào frontend.
- **Cloudflare Worker**: đặt `SUPABASE_URL` và secrets `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ONLINECOMPILER_API_KEY`. Frontend chỉ gọi Worker qua HTTPS; không cần tunnel tới scoring module.
- Trong Supabase Auth → URL Configuration, thêm domain Vercel vào Site URL/Redirect URLs.
- Áp dụng các migration replay `0004` và `0007` cùng migration proxy `0017` đến `0031`. Replay match được công bố sau khi ngày thi đã chấm và đến `publish_after`.

Các vòng thi online vận hành qua Supabase RPC và Cloudflare Worker. Vòng 5 offline chưa được triển khai; website cần Internet.
