# Google Tasks MCP server (tự host)

MCP server cho Google Tasks, viết theo kiểu [todoist/todoist-mcp](https://github.com/todoist/todoist-mcp): tool nhận input dạng mảng (batch), có `find-*` / `add-*` / `update-*` / `delete-object`. Viết bằng TypeScript, dùng `@modelcontextprotocol/sdk` 1.32 và zod. Node ≥ 23.6 chạy thẳng file `.ts` nên không cần bước build. Chỉ có 2 dependency.

## 1. Tìm hiểu: các cách host một MCP server

| Cách | Transport | Khi nào dùng | Ghi chú |
|---|---|---|---|
| **Local stdio** | stdio | Một máy, một người dùng (Claude Code/Desktop, Cursor) | Client tự spawn process, không mở cổng, đơn giản và an toàn nhất |
| **Local HTTP** | Streamable HTTP trên `127.0.0.1` | Nhiều client trên cùng máy, hoặc thử trước khi deploy | Bảo vệ bằng bearer token |
| **Cloudflare Workers** | Streamable HTTP | Remote, miễn phí ở mức nhỏ | Có template và OAuth provider sẵn, chạy runtime Workers (không phải Node đầy đủ) |
| **Google Cloud Run** | Streamable HTTP (không hỗ trợ stdio) | Remote, hợp với hệ Google, scale về 0 | Deploy container, có URL HTTPS sẵn |
| Fly.io / Render / Railway / Vercel | Streamable HTTP | Remote, deploy từ git hoặc Docker | Tương tự Cloud Run |

Các điểm chính:
- **Transport chuẩn hiện tại** là *stdio* (local) và *Streamable HTTP* (remote). Transport HTTP+SSE cũ đã bị thay thế.
- **Auth cho remote server:** spec MCP dùng OAuth 2.1. Todoist hosted (`https://ai.todoist.net/mcp`) dùng OAuth; khi chạy local thì dùng API key qua env. Server cá nhân dùng một mình thì bearer token + HTTPS là đủ.
- **Stateless HTTP** (mỗi request tạo một server/transport mới) là cách đơn giản và scale ngang dễ trên serverless. Server này đang làm như vậy.

Nguồn: [Cloud Run – Host MCP servers](https://docs.cloud.google.com/run/docs/host-mcp-servers), [Cloudflare – Remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/index.md), [Fly.io – Host a remote MCP server](https://fly.io/learn/host-a-remote-mcp-server/), [Modal – platforms for Streamable HTTP MCP](https://modal.com/resources/best-platforms-streamable-http-mcp-servers), [todoist-mcp](https://github.com/todoist/todoist-mcp).

## 2. Các tool

| Tool | Tương ứng Todoist | Mô tả |
|---|---|---|
| `find-tasklists` | find-projects | Liệt kê list, có lọc theo tên |
| `add-tasklists` | add-projects | Tạo nhiều list. Bỏ qua list trùng tên (idempotent) |
| `update-tasklists` | update-projects | Đổi tên list |
| `find-tasks` | find-tasks | Tìm task theo list, từ khoá, parent, có/không lấy task đã xong. Tự lấy hết các trang |
| `find-tasks-by-date` | find-tasks-by-date | Task theo khoảng ngày, hoặc `overdue: true` để lấy task quá hạn |
| `add-tasks` | add-tasks | Tạo nhiều task: notes, ngày hạn, subtask (`parentId`), vị trí |
| `update-tasks` | update-tasks | Sửa tiêu đề, notes, ngày hạn (`null` để xoá) |
| `complete-tasks` / `uncomplete-tasks` | complete/uncomplete-tasks | Đánh dấu xong / mở lại |
| `move-task` | project-move | Sắp xếp lại, lồng hoặc gỡ subtask, chuyển sang list khác |
| `delete-object` | delete-object | Xoá task hoặc cả list |
| `get-overview` | get-overview | Đếm task đang mở, quá hạn và đến hạn hôm nay của từng list |

Tham số `tasklist` nhận **ID hoặc tên list** (vd `"Hàng tạp hóa"`), để LLM gọi dễ hơn.

**Giới hạn của Google Tasks API** (so với Apple Reminders/Todoist):
- Hạn chỉ lưu **ngày**, phần giờ bị bỏ.
- Không có lặp lại, ưu tiên hay label.

Khi import, giờ và kiểu lặp lại được ghi vào `notes` (vd `Giờ: 10:00 · Lặp lại: Hằng tuần`).

## 3. Kết nối với tài khoản Google của bạn — cần bạn làm

Mình không thể tạo OAuth client thay bạn, vì việc này cần đăng nhập Google Cloud Console. Làm một lần, khoảng 5 phút:

1. Vào https://console.cloud.google.com/ và tạo project mới, vd `personal-mcp`.
2. Vào **APIs & Services → Library** và Enable **Google Tasks API**.
3. Vào **Google Auth Platform → Branding / Audience** (tức OAuth consent screen):
   - User type: **External**, trạng thái **Testing**.
   - Ở **Test users**, thêm Gmail của bạn.
4. Vào **Data Access → Add scope** và thêm `https://www.googleapis.com/auth/tasks`.
5. Vào **Clients → Create client**, chọn Application type **Desktop app**, rồi **Download JSON**.
6. Lưu file JSON đó thành `credentials.json` trong thư mục này. **Đừng dán nội dung vào chat.** File đã có trong `.gitignore`.
7. Chạy lệnh sau, mở link được in ra và đồng ý quyền:
   ```bash
   npm run auth
   ```
   Lệnh này tạo `token.json` (chmod 600) chứa refresh token.

> ⚠️ Khi app ở trạng thái **Testing**, Google cho refresh token **hết hạn sau 7 ngày**. Hết hạn thì chạy lại `npm run auth`. Muốn token dùng lâu dài, bấm **Publish app** (chế độ In production). App cá nhân chưa qua xác minh vẫn dùng được, chỉ hiện cảnh báo "unverified" lúc đăng nhập.

## 4. Chạy và test

```bash
npm install
```

Test offline với mock Google API: import `data/reminders.md`, chạy CRUD, kiểm tra HTTP và token.

```bash
npm test
```

Khi đã có `credentials.json` và `token.json`, chạy với tài khoản thật. Lệnh import chạy lại nhiều lần cũng không bị trùng. Phần CRUD chỉ chạy trên một list tạm, list này bị xoá ở cuối.

```bash
npm run test:real
```

Hoặc chỉ import:

```bash
npm run import
```

Hoàn tác import. Lệnh này chỉ xoá những gì import đã tạo, theo ghi chép trong `.import-state.json`: các list do import tạo mới, và các task import đã thêm vào list có sẵn. Dữ liệu cũ của bạn, kể cả list trùng tên như "Work", được giữ nguyên.

```bash
npm run import:undo
```

### Dùng hằng ngày: chat với Claude để thao tác Google Tasks

```bash
./start.sh
```

Script kiểm tra token Google (tự chạy lại `npm run auth` nếu hết hạn), rồi chạy server HTTP ở foreground tại `http://127.0.0.1:8787/mcp`. Server sống cho tới khi bạn bấm **Ctrl+C** ở terminal đó.

Mở Claude trong thư mục này ở tab/cửa sổ khác (terminal hoặc app desktop). `.mcp.json` khai báo server `google-tasks` kiểu `http`, nên Claude chỉ kết nối tới server đang chạy chứ không tự bật nó. Nếu chưa chạy `./start.sh`, server sẽ hiện là lỗi kết nối. Nếu bật server sau khi đã mở Claude, gõ `/mcp` để kết nối lại. Lần đầu, Claude sẽ hỏi có cho phép MCP server của project không: chọn đồng ý. `CLAUDE.md` hướng dẫn Claude cách dùng các tool (múi giờ, ghi giờ vào notes, xác nhận trước khi xoá).

**Bearer token:** server và Claude dùng chung token trong `.mcp-token` (chmod 600, đã có trong `.gitignore`). `start.sh` đưa token vào `MCP_AUTH_TOKEN`, còn `.mcp.json` đọc nó qua `headersHelper`. Token chặn các trang web hay tiến trình khác trên máy gọi vào server. Tạo hoặc đổi token:

```bash
(umask 077; openssl rand -hex 32 > .mcp-token)
```

### Gắn vào client khác

Mẫu cấu hình nằm ở `.mcp.json.example`:
- **stdio:** `node /đường/dẫn/src/server.ts`
- **HTTP local:** chạy `MCP_AUTH_TOKEN=... npm run http`, rồi trỏ client tới `http://127.0.0.1:8787/mcp` kèm header `Authorization: Bearer ...`

### Deploy lên Cloud Run (tuỳ chọn)

```bash
gcloud run deploy google-tasks-mcp --source . --region asia-southeast1 \
  --set-env-vars GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,GOOGLE_REFRESH_TOKEN=...,MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  --allow-unauthenticated
```

Nên đưa các secret vào Secret Manager thay vì `--set-env-vars`. Server từ chối listen trên `0.0.0.0` nếu thiếu `MCP_AUTH_TOKEN`.

## 5. Cách import `reminders.md` được map

- **6 list:** Me, Work, Subscription, Todo, Reminder, Hàng tạp hóa.
- **Bảng "Có hạn":** mỗi dòng vào list ở cột *Danh sách*, kèm ngày hạn. Giờ, kiểu lặp lại và cờ "quá hạn" ghi vào notes.
- **Todo:** "Sắp xếp lại ứng dụng mật khẩu" (3 việc con) và "Tìm hiểu Deco" (5 việc con) thành task cha có subtask thật. Phần `*(...)*` chuyển thành notes.
- **Reminder:**
  - *Hermes Agent – Personal Assistant* là nhóm thật trong app, nên thành task cha với 12 subtask.
  - Các nhóm khác chỉ là gợi ý (file có ghi chú vậy), nên task để phẳng, notes ghi `Nhóm: ...`.
- **Về số lượng:** header file ghi 65 nhắc nhở, nhưng file chỉ liệt kê **64**. Mục Reminder ghi (32) nhưng có 31 dòng. Bản import tạo 64 task + 1 task cha "Hermes Agent", tổng **65 task**.

## Cấu trúc

```
src/server.ts          entry: stdio (mặc định) hoặc --http (Streamable HTTP, stateless, bearer token)
src/tools.ts           12 MCP tools
src/google-tasks.ts    client REST tối giản: refresh token, phân trang
scripts/auth.ts        OAuth loopback + PKCE → token.json
scripts/import-reminders.ts  import reminders.md qua chính các MCP tool
test/mock-google.ts    giả lập Google Tasks API (due chỉ lưu ngày, phân trang 20/100, @default không xoá được)
test/e2e.ts            test end-to-end
```
